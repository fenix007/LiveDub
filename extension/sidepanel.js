// Боковая панель — весь конвейер: захват звука вкладки, Deepgram, перевод,
// озвучка и субтитры. Закрытие панели останавливает перевод.
import { DEFAULT_PREFS, loadKeys, loadPrefs, savePrefs } from './lib/settings.js';
import { joinText, stableWords, wordCount } from './lib/text.js';
import { openDeepgram, synthesizeYandex, translateDeepSeek, translateYandex } from './lib/providers.js';
import { startTabAudio } from './lib/capture.js';
import { createSpeech } from './lib/speech.js';
import { createLatencyStats } from './lib/stats.js';

const $ = (id) => document.getElementById(id);
const log = $('log'), statusEl = $('status');
const DRAFT_INTERVAL_MS = 1200;
const DRAFT_MIN_WORDS = 3;
const DRAFT_NEW_WORDS = 3;
// Yandex Translate отвечает быстро: черновик обновляется чаще и после меньшего прироста.
const YANDEX_DRAFT_INTERVAL_MS = 650;
const YANDEX_DRAFT_NEW_WORDS = 2;
const REMOTE_ENGINES = new Set(['deepseek', 'yandex']);
const LOCKED_WHILE_LIVE = ['source', 'target', 'draftEngine', 'finalEngine', 'start'];

let keys = await loadKeys();
let prefs = await loadPrefs();
let session = null;       // { tabId, audioContext, stream, audio, ws }
let translatorPromise = Promise.resolve(null);
let captureGeneration = 0;
let buffer = [];          // финальные сегменты текущей фразы
let latestInterim = '';
let phrase = null;
let history = [];         // последние оригиналы — контекст для LLM
let activeRemoteDrafts = 0;
let keepAliveTimer = null, keepAliveSocket = null;
const latency = createLatencyStats();

const setStatus = (text, cls = '') => { statusEl.textContent = text; statusEl.className = cls; };
const hasTranslator = 'Translator' in self;

// ---------- озвучка ----------
const speech = createSpeech({
  config: () => ({ enabled: prefs.tts, provider: prefs.ttsProvider, voice: prefs.voice, target: prefs.target, yandexKey: keys.yandexKey }),
  isCurrent: (state) => state.captureGeneration === captureGeneration,
  synthesize: (request) => synthesizeYandex({ key: keys.yandexKey }, request),
  onStats: showSpeechStats,
  onSpeaking: (speaking) => session?.audio?.setVolume(speaking ? prefs.duck : 1),
});

function showSpeechStats(stats = speech.stats()) {
  if (!prefs.tts && !stats.notice) { $('ttsMetrics').textContent = ''; return; }
  const starts = [...stats.starts].sort((a, b) => a - b);
  const p95 = starts.length ? (starts[Math.ceil(starts.length * .95) - 1] / 1000).toFixed(1) + ' с' : '—';
  $('ttsMetrics').textContent = `Озвучка · стартов: ${starts.length}, p95 ожидания: ${p95}, ` +
    `изменений сказанного: ${stats.prefixMismatch}, пропущено: ${stats.backlogDropped}, ошибок: ${stats.errors}` +
    (stats.notice ? `. ${stats.notice}` : '');
}

// ---------- настройки и элементы управления ----------
function setPref(name, value) {
  prefs = { ...prefs, [name]: value };
  savePrefs(prefs);
}

function engineAvailable(engine) {
  return engine === 'off' || (engine === 'chrome' && hasTranslator) ||
    (engine === 'deepseek' && Boolean(keys.deepseekKey)) || (engine === 'yandex' && Boolean(keys.yandexKey));
}

function populateVoices() {
  $('voice').innerHTML = '<option value="">Авто</option>';
  for (const voice of speech.voices()) $('voice').add(new Option(voice.name, voice.id));
  $('voice').value = [...$('voice').options].some((option) => option.value === prefs.voice) ? prefs.voice : '';
}

function syncControls() {
  for (const id of ['draftEngine', 'finalEngine']) {
    for (const option of $(id).options) option.disabled = !engineAvailable(option.value);
    if (!engineAvailable(prefs[id])) {
      const fallback = [...$(id).options].find((option) => !option.disabled)?.value ?? DEFAULT_PREFS[id];
      setPref(id, fallback);
    }
  }
  $('ttsProvider').querySelector('[value=yandex]').disabled = !keys.yandexKey;
  if (prefs.ttsProvider === 'yandex' && !speech.ready()) setPref('ttsProvider', 'browser');
  for (const id of ['source', 'target', 'draftEngine', 'finalEngine', 'ttsProvider']) $(id).value = prefs[id];
  $('tts').checked = prefs.tts;
  $('subtitles').checked = prefs.subtitles;
  $('duck').value = prefs.duck;
  populateVoices();
  $('tts').disabled = !speech.ready();
  if (!keys.deepgramKey) setStatus('Укажите ключ Deepgram в «Ключи API»', 'err');
}

function disableSpeechIfUnavailable() {
  if (prefs.tts && !speech.ready()) {
    setPref('tts', false);
    $('tts').checked = false;
    speech.setNotice('Для целевого языка нет доступного голоса');
  }
  $('tts').disabled = !speech.ready();
}

for (const id of ['source', 'draftEngine', 'finalEngine']) {
  $(id).addEventListener('change', () => setPref(id, $(id).value));
}
$('target').addEventListener('change', () => {
  speech.cancel();
  setPref('target', $('target').value);
  if (prefs.ttsProvider === 'yandex' && !speech.ready()) {
    setPref('ttsProvider', 'browser');
    $('ttsProvider').value = 'browser';
  }
  setPref('voice', '');
  populateVoices();
  disableSpeechIfUnavailable();
});
$('ttsProvider').addEventListener('change', () => {
  setPref('ttsProvider', $('ttsProvider').value);
  setPref('voice', '');
  populateVoices();
  disableSpeechIfUnavailable();
  speech.restart(speech.activeState() || phrase);
});
$('voice').addEventListener('change', () => {
  setPref('voice', $('voice').value);
  speech.restart(speech.activeState() || phrase);
});
$('tts').addEventListener('change', () => {
  speech.cancel();
  setPref('tts', $('tts').checked);
  disableSpeechIfUnavailable();
  if (prefs.tts) speech.setNotice('');
  showSpeechStats();
  if (prefs.tts && phrase?.lastTranslation) speech.speak(phrase, phrase.lastTranslation, false);
});
$('subtitles').addEventListener('change', () => {
  setPref('subtitles', $('subtitles').checked);
  if (!session) return;
  if (prefs.subtitles) injectSubtitles(session.tabId);
  else sendToTab(session.tabId, { type: 'tt-subtitle-clear' });
});
$('duck').addEventListener('input', () => setPref('duck', Number($('duck').value)));
$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.keys) return;
  keys = await loadKeys();
  syncControls();
  if (keys.deepgramKey && statusEl.classList.contains('err') && !session) setStatus('готово');
});
if (speech.available) speechSynthesis.addEventListener('voiceschanged', () => { populateVoices(); $('tts').disabled = !speech.ready(); });

// ---------- субтитры на странице ----------
function sendToTab(tabId, message) {
  chrome.tabs.sendMessage(tabId, message).catch(() => { /* вкладка перезагрузилась или скрипт не внедрён */ });
}

async function injectSubtitles(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/subtitles.js'] });
  } catch {
    setStatus('Субтитры недоступны на этой странице; перевод виден в панели', statusEl.className);
  }
}

function showSubtitle(state, translated, final) {
  if (!prefs.subtitles || !session || state.captureGeneration !== captureGeneration) return;
  sendToTab(session.tabId, { type: 'tt-subtitle', translation: translated, original: state.finalText || state.sourceText, final });
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  // После перезагрузки страницы content script пропадает, внедряем заново.
  if (session?.tabId === tabId && info.status === 'complete' && prefs.subtitles) injectSubtitles(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => { if (session?.tabId === tabId) stop('вкладка закрыта'); });

// ---------- перевод ----------
async function createChromeTranslator(sourceLanguage, targetLanguage) {
  if (!hasTranslator) throw new Error('Translator API недоступен (нужен Chrome 138+ на десктопе)');
  return Translator.create({
    sourceLanguage, targetLanguage,
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => setStatus(`загрузка языковой модели ${Math.round(e.loaded * 100)}%`));
    },
  });
}

async function engineTranslate(engine, text, context, kind) {
  const input = { text, context, source: prefs.source, target: prefs.target };
  if (engine === 'chrome') {
    const translator = await translatorPromise;
    if (!translator) throw new Error('Chrome Translator не запущен');
    return translator.translate(text);
  }
  if (engine === 'deepseek') {
    return timed(engine, kind, translateDeepSeek({ key: keys.deepseekKey, model: keys.deepseekModel }, input));
  }
  if (engine === 'yandex') {
    return timed(engine, kind, translateYandex({ key: keys.yandexKey, folderId: keys.yandexFolderId }, input));
  }
  throw new Error(`Неизвестный движок: ${engine}`);
}

// Задержки облачных движков, чтобы сравнивать Yandex и DeepSeek на реальных репликах.
async function timed(engine, kind, request) {
  const started = performance.now();
  try {
    const result = await request;
    latency.record(engine, kind, performance.now() - started, true);
    return result;
  } catch (error) {
    latency.record(engine, kind, performance.now() - started, false);
    throw error;
  } finally {
    showLatency();
  }
}

function showLatency() {
  const seconds = (ms) => ms == null ? '—' : `${(ms / 1000).toFixed(1)} с`;
  const names = { yandex: 'Yandex Translate', deepseek: 'DeepSeek' };
  $('metrics').textContent = Object.entries(names).map(([engine, name]) => {
    const { all, final } = latency.summary(engine);
    return all.count ? `${name} · ${all.count} запросов: p50 ${seconds(all.p50Ms)}, p95 ${seconds(all.p95Ms)}, ` +
      `ошибок: ${all.errors}. Финальные: p95 ${seconds(final.p95Ms)}.` : '';
  }).filter(Boolean).join(' ');
}

// Черновик и финал переводят разные движки. Браузерный голос продолжает черновой
// движок, а на экране финальную строку заменяет перевод финального движка.
// SpeechKit в этом режиме озвучивает только финал — тот же текст, что на экране.
const splitVoice = () => prefs.draftEngine !== 'off' && prefs.draftEngine !== prefs.finalEngine;
const yandexVoice = () => prefs.ttsProvider === 'yandex';

async function translate(text, context, kind) {
  const engine = kind === 'draft' ? prefs.draftEngine : prefs.finalEngine;
  try {
    return await engineTranslate(engine, text, context, kind);
  } catch (error) {
    if (kind === 'final' && splitVoice()) return engineTranslate(prefs.draftEngine, text, context, 'final');
    throw error;
  }
}

function ensurePhrase() {
  if (phrase) return phrase;
  const row = document.createElement('div');
  row.className = 'row draft';
  row.innerHTML = '<div class="src"></div><div class="tr pending">перевожу…</div>';
  log.appendChild(row);
  scrollDown();
  phrase = { row, sourceText: '', stableText: '', lastRequestText: '', lastSuccessText: '', lastRequestAt: null,
    revision: 0, inFlight: null, timer: null, final: false, context: history.slice(-3),
    captureGeneration, ttsWords: [], ttsCandidate: '', ttsCandidateFinal: false,
    ttsPreviousDraft: null, ttsRewritten: false,
    ttsDropped: false, ttsUseServerFinal: false, finalText: '',
    lastTranslation: '', lastFinalTranslation: '' };
  return phrase;
}

function renderTranslation(state, translated, elapsed, kind, sourceText) {
  state.lastTranslation = translated;
  const final = kind === 'final' || (state.final && state.finalText === sourceText);
  if (final) state.lastFinalTranslation = translated;
  const el = state.row.querySelector('.tr');
  el.textContent = translated;
  el.classList.remove('pending');
  const ms = document.createElement('span');
  ms.className = 'ms'; ms.textContent = `${Math.round(elapsed)} мс`;
  el.appendChild(ms);
  scrollDown();
  showSubtitle(state, translated, final);
  if (!splitVoice() || state.ttsUseServerFinal || (yandexVoice() ? final : !final)) {
    speech.speak(state, translated, final);
  }
}

function requestTranslation(state, text) {
  const kind = state.final ? 'final' : 'draft';
  const usesDraftSlot = kind === 'draft' && REMOTE_ENGINES.has(prefs.draftEngine);
  if (usesDraftSlot && activeRemoteDrafts >= 1) return;
  if (usesDraftSlot) activeRemoteDrafts++;
  const revision = ++state.revision;
  state.lastRequestText = text;
  state.lastRequestAt = performance.now();
  state.inFlight = { revision, text };
  const started = performance.now();
  translate(text, state.context, kind)
    .then((translated) => {
      if (revision !== state.revision) return;
      if (!state.final && state.stableText !== text && !state.stableText.startsWith(`${text} `)) return;
      state.lastSuccessText = text;
      renderTranslation(state, translated, performance.now() - started, kind, text);
    })
    .catch((error) => {
      if (revision !== state.revision) return;
      if (state.final) state.row.querySelector('.tr').textContent = `ошибка перевода: ${error.message}`;
    })
    .finally(() => {
      if (usesDraftSlot) {
        activeRemoteDrafts--;
        if (phrase && phrase !== state) scheduleDraft(phrase);
      }
      if (state.inFlight?.revision !== revision) return;
      state.inFlight = null;
      if (!state.final && state === phrase) scheduleDraft(state);
    });
}

function draftDue(state) {
  const text = state.stableText;
  if (prefs.draftEngine === 'off' || wordCount(text) < DRAFT_MIN_WORDS || text === state.lastRequestText) return false;
  const appended = text.startsWith(`${state.lastRequestText} `);
  const minNewWords = prefs.draftEngine === 'yandex' ? YANDEX_DRAFT_NEW_WORDS : DRAFT_NEW_WORDS;
  return !appended || wordCount(text) - wordCount(state.lastRequestText) >= minNewWords;
}

function scheduleDraft(state) {
  if (state.final || state.timer || state.inFlight || !draftDue(state)) return;
  const delay = state.lastRequestAt === null ? 150 :
    Math.max(150, state.lastRequestAt + (prefs.draftEngine === 'yandex' ? YANDEX_DRAFT_INTERVAL_MS : DRAFT_INTERVAL_MS) - performance.now());
  state.timer = setTimeout(() => {
    state.timer = null;
    if (!state.final && state === phrase && !state.inFlight && draftDue(state)) requestTranslation(state, state.stableText);
  }, delay);
}

function updatePhrase(sourceText, stableText) {
  if (!sourceText) return;
  const state = ensurePhrase();
  state.sourceText = sourceText;
  state.row.querySelector('.src').textContent = sourceText;
  state.stableText = stableText;
  scheduleDraft(state);
}

// Закрепляем ту же строку окончательным текстом; поздние черновые ответы игнорируются.
function flush() {
  const text = joinText(buffer.join(' '), latestInterim);
  buffer = [];
  latestInterim = '';
  if (!text) return;
  const state = ensurePhrase();
  phrase = null;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.final = true;
  state.finalText = text;
  state.row.classList.remove('draft');
  state.row.querySelector('.src').textContent = text;
  if (splitVoice()) {
    // Даже при совпадении текста с черновиком нужен ответ финального движка.
    requestTranslation(state, text);
    if (prefs.tts && speech.ready() && !yandexVoice()) {
      (async () => {
        try {
          const voiced = await engineTranslate(prefs.draftEngine, text, state.context, 'final');
          if (!voiced?.trim()) throw new Error('Пустой перевод для озвучки');
          speech.speak(state, voiced, true);
        } catch {
          // Черновой движок не ответил — озвучиваем экранный финал после его прихода.
          state.ttsUseServerFinal = true;
          if (state.lastFinalTranslation) speech.speak(state, state.lastFinalTranslation, true);
        }
      })();
    }
  } else if (state.lastSuccessText === text) {
    if (state.inFlight && state.inFlight.text !== text) ++state.revision;
    if (state.lastTranslation) {
      speech.speak(state, state.lastTranslation, true);
      showSubtitle(state, state.lastTranslation, true);
    }
  } else if (state.inFlight?.text !== text) {
    requestTranslation(state, text);
  }

  history.push(text);
  if (history.length > 10) history.shift();
}

function scrollDown() {
  const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 120;
  if (nearBottom) window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
}

// ---------- Deepgram ----------
function stopKeepAlive(sock) {
  if (sock && sock !== keepAliveSocket) return;
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = keepAliveSocket = null;
}

function startKeepAlive(sock) {
  stopKeepAlive();
  keepAliveSocket = sock;
  // Deepgram закрывает поток после 10 секунд без аудио или текстового сообщения.
  keepAliveTimer = setInterval(() => {
    if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: 'KeepAlive' }));
  }, 4000);
}

function handleDeepgram(msg) {
  if (msg.type === 'Results') {
    const text = msg.channel?.alternatives?.[0]?.transcript ?? '';
    if (msg.is_final) {
      if (text) buffer.push(text);
      latestInterim = '';
      updatePhrase(buffer.join(' '), buffer.join(' '));
      // конец фразы: пауза (speech_final), конец предложения или слишком длинный монолог
      if (msg.speech_final || /[.?!…]$/.test(text) || wordCount(buffer.join(' ')) > 30) flush();
    } else {
      const stable = stableWords(latestInterim, text);
      latestInterim = text;
      updatePhrase(joinText(buffer.join(' '), text), joinText(buffer.join(' '), stable));
    }
  } else if (msg.type === 'UtteranceEnd') {
    flush();
  }
}

async function connectDeepgram(language) {
  const sock = openDeepgram(keys.deepgramKey, language);
  sock.onmessage = (ev) => { if (sock === session?.ws) handleDeepgram(JSON.parse(ev.data)); };
  sock.onclose = (ev) => {
    stopKeepAlive(sock);
    if (session?.ws === sock) stop(`Deepgram закрыл соединение (${ev.code}) ${ev.reason}`.trim());
  };
  await new Promise((ok, fail) => {
    const timeout = setTimeout(() => { sock.close(); fail(new Error('таймаут подключения к Deepgram')); }, 8000);
    sock.onopen = () => { clearTimeout(timeout); startKeepAlive(sock); ok(); };
    // До открытия ошибка почти всегда означает неверный ключ или язык.
    sock.onerror = () => { clearTimeout(timeout); fail(new Error('Deepgram отклонил подключение: проверьте ключ')); };
  });
  sock.onerror = () => setStatus('ошибка WebSocket Deepgram', 'err');
  return sock;
}

// ---------- старт / стоп ----------
function lockControls(live) {
  for (const id of LOCKED_WHILE_LIVE) $(id).disabled = live;
  $('stop').disabled = !live;
}

function captureErrorMessage(error) {
  const message = error?.message || String(error);
  if (/activeTab|not been invoked|Chrome pages cannot be captured/i.test(message)) {
    return 'Нажмите на иконку расширения на нужной вкладке, затем «Переводить эту вкладку». Страницы chrome:// захватить нельзя.';
  }
  if (/active stream/i.test(message)) return 'Эта вкладка уже захвачена: остановите предыдущий захват.';
  return message;
}

$('start').onclick = async () => {
  if (prefs.source === prefs.target) return setStatus('языки совпадают', 'err');
  if (!keys.deepgramKey) return setStatus('Укажите ключ Deepgram в «Ключи API»', 'err');
  const generation = ++captureGeneration;
  speech.cancel();
  lockControls(true);

  // Translator.create и AudioContext требуют жеста пользователя — создаём до первого await.
  const needsChrome = prefs.draftEngine === 'chrome' || prefs.finalEngine === 'chrome';
  translatorPromise = needsChrome ? createChromeTranslator(prefs.source, prefs.target) : Promise.resolve(null);
  translatorPromise.catch((e) => setStatus(`ошибка Chrome Translator: ${e.message}`, 'err'));
  const current = { tabId: null, audioContext: new AudioContext(), stream: null, audio: null, ws: null };
  session = current;
  const cancelled = () => generation !== captureGeneration;

  try {
    setStatus('захват звука вкладки…');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('Не найдена активная вкладка');
    current.tabId = tab.id;
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    });
    current.stream = stream;
    if (cancelled()) return stream.getTracks().forEach((track) => track.stop());
    stream.getAudioTracks()[0].addEventListener('ended', () => { if (session === current) stop('захват вкладки завершён'); });

    // Звук вкладки возвращается в колонки сразу, ещё до подключения к Deepgram.
    current.audio = await startTabAudio({
      context: current.audioContext, stream, workletUrl: chrome.runtime.getURL('pcm-worklet.js'),
      onPcm: (data) => { if (current.ws?.readyState === WebSocket.OPEN) current.ws.send(data); },
    });
    if (cancelled()) return;

    setStatus('подключение к Deepgram…');
    const sock = await connectDeepgram(prefs.source);
    if (cancelled()) {
      stopKeepAlive(sock);
      sock.send(JSON.stringify({ type: 'CloseStream' }));
      return;
    }
    current.ws = sock;
    if (prefs.subtitles) injectSubtitles(tab.id);

    const names = { chrome: 'Chrome', deepseek: keys.deepseekModel, yandex: 'Yandex Translate', off: '—' };
    setStatus(`в эфире · ${prefs.source} → ${prefs.target} · черновик: ${names[prefs.draftEngine]}, финал: ${names[prefs.finalEngine]}`, 'live');
  } catch (error) {
    if (cancelled()) return;
    stop(captureErrorMessage(error));
  }
};

function stop(errorMessage) {
  ++captureGeneration;
  speech.cancel();
  flush();
  stopKeepAlive();
  const current = session;
  session = null;
  if (current) {
    current.audio?.stop();
    current.audioContext.close().catch(() => {});
    if (current.ws?.readyState === WebSocket.OPEN) current.ws.send(JSON.stringify({ type: 'CloseStream' }));
    current.stream?.getTracks().forEach((track) => track.stop());
    if (current.tabId) sendToTab(current.tabId, { type: 'tt-subtitle-clear' });
  }
  lockControls(false);
  if (errorMessage) setStatus(errorMessage, 'err');
  else setStatus('остановлено');
}
$('stop').onclick = () => stop();

syncControls();
showSpeechStats();
