// Страница эталонного прогона. Runner кладёт её во временную копию расширения
// рядом с sidepanel.html: так работают host_permissions и chrome.storage, а
// код панели — тот же, что у пользователя. Подменяется только захват вкладки:
// вместо него звучит WAV сценария.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error('таймаут ожидания');
    await sleep(50);
  }
}

async function main() {
  const config = window.benchConfig ?? await new Promise((resolve) =>
    addEventListener('bench:config', (event) => resolve(event.detail), { once: true }));
  await chrome.storage.local.set({ keys: config.keys, prefs: config.prefs });

  const audio = new Audio(chrome.runtime.getURL('bench-audio.wav'));
  audio.preload = 'auto';
  await new Promise((resolve, reject) => {
    audio.oncanplaythrough = resolve;
    audio.onerror = () => reject(new Error('не удалось загрузить WAV сценария'));
  });
  const stream = audio.captureStream();
  chrome.tabCapture.getMediaStreamId = async () => 'bench';
  navigator.mediaDevices.getUserMedia = async () => stream;

  // Сколько звука ушло в Deepgram: должно совпадать с длительностью по часам,
  // иначе задержки прогона ничего не значат.
  const sent = { bytes: 0, first: null, last: null, maxBufferedBytes: 0 };
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (typeof data !== 'string') {
      sent.bytes += data.byteLength;
      sent.first ??= performance.now();
      sent.last = performance.now();
      // Неотправленный хвост сокета: если растёт, звук доходит до Deepgram с опозданием.
      sent.maxBufferedBytes = Math.max(sent.maxBufferedBytes, this.bufferedAmount);
    }
    return send.call(this, data);
  };

  let startedAt = null;
  const phrases = [];
  addEventListener('livedub:final', ({ detail }) => {
    if (startedAt !== null) phrases.push({ ...detail, shownMs: detail.shownAt - startedAt, flushedMs: detail.flushedAt - startedAt });
  });

  await import('./sidepanel.js');
  const status = document.getElementById('status');
  document.getElementById('start').click();
  await waitFor(() => status.className === 'live' || status.className === 'err', 20_000);
  if (status.className === 'err') throw new Error(status.textContent);

  // Звук начинает уходить в Deepgram, как только соединение открыто; ноль шкалы
  // времени — начало WAV, пересчитанное из текущей позиции воспроизведения.
  await audio.play();
  startedAt = performance.now() - audio.currentTime * 1000;
  await new Promise((resolve) => { audio.onended = resolve; });
  const playbackSeconds = (performance.now() - startedAt) / 1000;
  await sleep(config.tailMs);

  const rows = [...document.querySelectorAll('#log .row')].map((row) => ({
    final: !row.classList.contains('draft'),
    source: row.querySelector('.src').textContent,
    translation: row.querySelector('.tr').firstChild?.textContent ?? '',
  }));
  const metrics = document.getElementById('metrics').textContent;
  document.getElementById('stop').click();
  const audioClock = { sentSeconds: sent.bytes / 32000, wallSeconds: (sent.last - sent.first) / 1000,
    playbackSeconds, wavSeconds: audio.duration, sampleRate: new AudioContext().sampleRate,
    maxBufferedSeconds: sent.maxBufferedBytes / 32000, visibility: document.visibilityState };
  return { phrases, rows, metrics, audioClock };
}

main().then(
  (result) => { window.benchResult = result; },
  (error) => { window.benchResult = { error: error.message }; },
);
