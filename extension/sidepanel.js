// Боковая панель — весь конвейер: захват звука вкладки, распознавание (Deepgram
// или SpeechKit через сервер LiveDub), перевод,
// озвучка и субтитры. Закрытие панели останавливает перевод.
import { DEFAULT_PREFS, loadKeys, loadPrefs, savePrefs } from './lib/settings.js';
import { continuesText, joinText, looksUnfinished, splitAtSentence, stableWords, wordCount } from './lib/text.js';
import { ENDPOINTING_CHOICES, SERVER_TOKEN_PATTERN, openDeepgram, openYandexStt, synthesizeYandex, translateDeepSeek, translateYandex } from './lib/providers.js';
import { startTabAudio } from './lib/capture.js';
import { createSpeech } from './lib/speech.js';
import { createLatencyStats } from './lib/stats.js';
import { createAudioClock, lagMs, lastWordEnd, transcriptCursor } from './lib/timing.js';

const $ = (id) => document.getElementById(id);
const log = $('log'), statusEl = $('status');
const DRAFT_INTERVAL_MS = 1200;
const DRAFT_MIN_WORDS = 3;
const PAUSE_HOLD_MS = 1500;
const DRAFT_NEW_WORDS = 3;
// Yandex Translate отвечает быстро: черновик обновляется чаще и после меньшего прироста.
const YANDEX_DRAFT_INTERVAL_MS = 650;
const YANDEX_DRAFT_NEW_WORDS = 2;
const REMOTE_ENGINES = new Set(['deepseek', 'yandex']);
const LOCKED_WHILE_LIVE = ['source', 'target', 'sttEngine', 'draftEngine', 'finalEngine', 'endpointing', 'start'];
const STT_NAMES = { deepgram: 'Deepgram', yandex: 'SpeechKit' };

let keys = await loadKeys();
let prefs = await loadPrefs();
let session = null;       // { tabId, audioContext, stream, audio, ws }
let translatorPromise = Promise.resolve(null);
let captureGeneration = 0;
let buffer = [];          // финальные сегменты текущей фразы
let latestInterim = '';
let phrase = null;
let phraseSeq = 0; // номер фразы: субтитры на странице отличают новую фразу от правки текущей
let history = [];         // последние оригиналы — контекст для LLM
let activeRemoteDrafts = 0;
let keepAliveTimer = null, keepAliveSocket = null;
let audioClock = createAudioClock();
let pauseHoldTimer = null; // отложенное закрытие фразы, оборванной на полуслове
let phraseWordEnd = null; // конец последнего слова текущей фразы, секунды звука
const eagerFinals = { sent: 0, used: 0 };
const latency = createLatencyStats();
const stages = createLatencyStats(); // этапы: распознавание, конец фразы, финальный перевод

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
  if (!ENDPOINTING_CHOICES.includes(prefs.endpointing)) setPref('endpointing', DEFAULT_PREFS.endpointing);
  for (const id of ['source', 'target', 'sttEngine', 'draftEngine', 'finalEngine', 'ttsProvider', 'endpointing']) $(id).value = prefs[id];
  $('tts').checked = prefs.tts;
  $('subtitles').checked = prefs.subtitles;
  $('subtitlesFinalOnly').checked = prefs.subtitlesFinalOnly;
  $('duck').value = prefs.duck;
  populateVoices();
  $('tts').disabled = !speech.ready();
  if (sttProblem()) setStatus(sttProblem(), 'err');
}

// Почему выбранный распознаватель не запустится; пустая строка — всё в порядке.
function sttProblem() {
  if (prefs.sttEngine === 'deepgram' && !keys.deepgramKey) return 'Укажите ключ Deepgram в «Ключи API» или выберите SpeechKit';
  if (prefs.sttEngine === 'yandex' && !keys.serverUrl) return 'Укажите адрес сервера LiveDub в «Ключи API»';
  if (prefs.sttEngine === 'yandex' && keys.serverToken && !SERVER_TOKEN_PATTERN.test(keys.serverToken)) {
    return 'Токен сервера LiveDub: от 32 символов, только латиница, цифры и . _ ~ -';
  }
  return '';
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
$('sttEngine').addEventListener('change', () => {
  setPref('sttEngine', $('sttEngine').value);
  if (!session) setStatus(sttProblem() || 'готово', sttProblem() ? 'err' : '');
});
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
$('subtitlesFinalOnly').addEventListener('change', () => setPref('subtitlesFinalOnly', $('subtitlesFinalOnly').checked));
$('duck').addEventListener('input', () => setPref('duck', Number($('duck').value)));
$('endpointing').addEventListener('change', () => setPref('endpointing', Number($('endpointing').value)));
$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.keys) return;
  keys = await loadKeys();
  syncControls();
  if (!sttProblem() && statusEl.classList.contains('err') && !session) setStatus('готово');
});
if (speech.available) speechSynthesis.addEventListener('voiceschanged', () => { populateVoices(); $('tts').disabled = !speech.ready(); });

// ---------- субтитры на странице ----------
function sendToTab(tabId, message) {
  chrome.tabs.sendMessage(tabId, message).catch(() => { /* вкладка перезагрузилась или скрипт не внедрён */ });
}

async function injectSubtitles(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/subtitles.js'] });
    if (session?.tabId === tabId) session.subtitleError = '';
    return true;
  } catch (error) {
    if (session?.tabId === tabId) {
      session.subtitleError = error?.message || 'нет доступа к странице';
      showCaptureMetrics(session);
    }
    return false;
  }
}

async function sendSubtitle(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // Первое сообщение могло обогнать внедрение скрипта или смену страницы.
    if (await injectSubtitles(tabId)) {
      try {
        await chrome.tabs.sendMessage(tabId, message);
      } catch (error) {
        if (session?.tabId === tabId) {
          session.subtitleError = error?.message || 'не удалось отправить текст';
          showCaptureMetrics(session);
        }
      }
    }
  }
}

// original — тот текст, с которого сделан перевод, а не более свежая гипотеза распознавания.
function showSubtitle(state, translated, final, original = state.finalText || state.sourceText) {
  if (!prefs.subtitles || !session || state.captureGeneration !== captureGeneration) return;
  if (!final && prefs.subtitlesFinalOnly) return;
  sendSubtitle(session.tabId, { type: 'tt-subtitle', id: state.id, translation: translated, original, final });
}

// Deepgram может переписать гипотезу целиком («where is he» → «launsy»). Тогда
// показанный перевод относится к тексту, которого больше нет: приглушаем его
// в панели и на странице до прихода перевода по новому тексту.
function markStale(state) {
  const current = state.final ? state.finalText : state.sourceText;
  // Укороченный текст (фразу разрезали по границе предложения) — не переписанный.
  const stale = !!state.lastTranslation &&
    !continuesText(current, state.lastSuccessText) && !continuesText(state.lastSuccessText, current);
  if (stale === state.stale) return;
  state.stale = stale;
  state.row.querySelector('.tr').classList.toggle('stale', stale);
  if (prefs.subtitles && session && state.captureGeneration === captureGeneration) {
    sendToTab(session.tabId, { type: 'tt-subtitle-stale', id: state.id, stale });
  }
}

// Закреплённая часть оригинала обычным цветом, неустоявшийся хвост гипотезы — бледнее.
function showSource(state, text, stableText = text) {
  const el = state.row.querySelector('.src');
  const stable = stableText && text.startsWith(stableText) ? stableText : '';
  el.textContent = stable;
  const tail = text.slice(stable.length).trim();
  if (tail) {
    const span = document.createElement('span');
    span.className = 'unstable';
    span.textContent = stable ? ` ${tail}` : tail;
    el.appendChild(span);
  }
  markStale(state);
}

function showCaptureMetrics(current) {
  if (session !== current) return;
  const sentSeconds = current.sentBytes / 32000;
  const audibleSeconds = current.audibleBytes / 32000;
  const noAudio = Date.now() - current.connectedAt > 6000 && sentSeconds < 1;
  const silentCapture = sentSeconds > 10 && audibleSeconds < 1;
  const noSpeech = sentSeconds > 12 && audibleSeconds > 2 && current.sttResults === 0;
  const label = prefs.sttEngine === 'yandex' ? 'SpeechKit' : 'Deepgram';
  const subtitleProblem = prefs.subtitles && current.subtitleError;
  const el = $('captureMetrics');
  const capture = current.tabTitle ? `Вкладка «${current.tabTitle.slice(0, 50)}» · ` : '';
  el.textContent = capture + (noAudio ? 'Звук не поступает: проверьте воспроизведение.'
    : silentCapture ? 'Аудиопоток тихий: запустите видео или проверьте выбранную вкладку.'
      : noSpeech ? `Звук отправляется, но ${label} не прислал текст. Остановите перевод и проверьте распознаватель.`
        : `Звук отправлен: ${sentSeconds.toFixed(1)} с · речь: ${audibleSeconds.toFixed(1)} с · ответов STT: ${current.sttResults}`)
    + (subtitleProblem ? ` · Субтитры недоступны: ${current.subtitleError}` : '');
  el.className = noAudio || silentCapture || noSpeech || subtitleProblem ? 'err' : '';
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
  if (engine === 'off') return text;
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
  const engines = Object.entries(names).map(([engine, name]) => {
    const { all, final } = latency.summary(engine);
    return all.count ? `${name} · ${all.count} запросов: p50 ${seconds(all.p50Ms)}, p95 ${seconds(all.p95Ms)}, ` +
      `ошибок: ${all.errors}. Финальные: p95 ${seconds(final.p95Ms)}.` : '';
  });
  // Итог = от конца последнего слова до финального перевода на экране.
  const stageNames = { stt: 'распознавание', endpoint: 'конец фразы', final: 'финальный перевод', total: 'итого' };
  const parts = Object.entries(stageNames).map(([stage, name]) => {
    const { all } = stages.summary(stage);
    return all.count ? `${name} p50 ${seconds(all.p50Ms)} / p95 ${seconds(all.p95Ms)}` : '';
  }).filter(Boolean);
  const eager = eagerFinals.sent ? ` Досрочных финалов пригодилось: ${eagerFinals.used} из ${eagerFinals.sent}.` : '';
  const stageLine = parts.length ? `Этапы · ${parts.join(', ')}.${eager}` : '';
  $('metrics').textContent = [...engines, stageLine].filter(Boolean).join(' ');
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
  phrase = { id: ++phraseSeq, row, sourceText: '', stableText: '', lastRequestText: '', lastSuccessText: '', lastRequestAt: null,
    revision: 0, inFlight: null, timer: null, final: false, context: history.slice(-3),
    captureGeneration, ttsWords: [], ttsCandidate: '', ttsCandidateFinal: false,
    ttsPreviousDraft: null, ttsRewritten: false,
    ttsDropped: false, ttsUseServerFinal: false, finalText: '',
    lastTranslation: '', lastFinalTranslation: '', eager: null, flushedAt: null, endpointMs: null, stale: false };
  return phrase;
}

function renderTranslation(state, translated, elapsed, kind, sourceText) {
  state.lastTranslation = translated;
  const final = kind === 'final' || (state.final && state.finalText === sourceText);
  if (final) {
    if (!state.lastFinalTranslation) recordFinalShown(state, translated);
    state.lastFinalTranslation = translated;
  }
  const el = state.row.querySelector('.tr');
  el.textContent = translated;
  el.classList.remove('pending');
  const ms = document.createElement('span');
  ms.className = 'ms'; ms.textContent = `${Math.round(elapsed)} мс`;
  el.appendChild(ms);
  state.stale = false;
  el.classList.remove('stale');
  scrollDown();
  showSubtitle(state, translated, final, sourceText);
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
  const eager = kind === 'final' && state.eager?.text === text ? state.eager : null;
  const started = eager?.started ?? performance.now();
  (eager?.promise ?? translate(text, state.context, kind))
    .then((translated) => {
      if (revision !== state.revision) return;
      if (!state.final && state.stableText !== text && !state.stableText.startsWith(`${text} `)) return;
      state.lastSuccessText = text;
      if (eager) eagerFinals.used++;
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
  state.stableText = stableText;
  showSource(state, sourceText, stableText);
  scheduleDraft(state);
}

// Закрепляем ту же строку окончательным текстом; поздние черновые ответы игнорируются.
function flush(endpointMs = null) {
  cancelPauseHold();
  const text = joinText(buffer.join(' '), latestInterim);
  buffer = [];
  latestInterim = '';
  phraseWordEnd = null;
  if (!text) return;
  const state = ensurePhrase();
  phrase = null;
  state.flushedAt = performance.now();
  state.endpointMs = endpointMs;
  if (endpointMs != null) recordStage('endpoint', endpointMs);
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.final = true;
  state.finalText = text;
  state.row.classList.remove('draft');
  showSource(state, text);
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
      // Финальный запрос не нужен: подходящий перевод уже на экране.
      recordFinalShown(state, state.lastTranslation);
      state.lastFinalTranslation = state.lastTranslation;
      speech.speak(state, state.lastTranslation, true);
      showSubtitle(state, state.lastTranslation, true);
    }
  } else if (state.inFlight?.text !== text) {
    requestTranslation(state, text);
  }

  history.push(text);
  if (history.length > 10) history.shift();
}

function recordStage(stage, ms) {
  stages.record(stage, 'final', ms, true);
  showLatency();
}

// Первый финальный перевод фразы на экране: сколько прошло после закрытия фразы.
// Событие livedub:final читает эталонный прогон (bench/), в работе панели оно не нужно.
function recordFinalShown(state, translation) {
  if (state.flushedAt == null || state.captureGeneration !== captureGeneration) return;
  const shownAt = performance.now();
  recordStage('final', shownAt - state.flushedAt);
  if (state.endpointMs != null) recordStage('total', state.endpointMs + shownAt - state.flushedAt);
  dispatchEvent(new CustomEvent('livedub:final', { detail: {
    source: state.finalText, translation, flushedAt: state.flushedAt, shownAt, endpointMs: state.endpointMs } }));
}

// Финальный движок получает текст уже на is_final, не дожидаясь паузы
// (speech_final / UtteranceEnd). Если новых слов не будет, к закрытию фразы
// перевод уже готов или в пути; если будут — запрос просто не пригодится.
function prefetchFinal(text) {
  if (!REMOTE_ENGINES.has(prefs.finalEngine) || wordCount(text) < DRAFT_MIN_WORDS) return;
  const state = ensurePhrase();
  if (state.eager?.text === text) return;
  const promise = translate(text, state.context, 'final');
  promise.catch(() => { /* ошибку покажет requestTranslation, если запрос пригодится */ });
  state.eager = { text, promise, started: performance.now() };
  eagerFinals.sent++;
}

function scrollDown() {
  const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 120;
  if (nearBottom) window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
}

// ---------- распознавание ----------
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

// Сообщения Deepgram; сервер LiveDub присылает ответы SpeechKit в том же формате.
function handleDeepgram(msg) {
  if (msg.type === 'Error') return stop(msg.message);
  if (msg.type === 'Results') {
    const text = msg.channel?.alternatives?.[0]?.transcript ?? '';
    if (text) {
      recordStage('stt', lagMs(audioClock.seconds(), transcriptCursor(msg)));
      phraseWordEnd = lastWordEnd(msg); // промежуточные слова тоже войдут во фразу
    }
    if (msg.is_final) {
      if (text) { buffer.push(text); cancelPauseHold(); }
      latestInterim = '';
      const joined = buffer.join(' ');
      updatePhrase(joined, joined);
      // конец фразы: пауза (speech_final) или закреплённый текст кончается предложением
      if (/[.?!…]$/.test(text)) flush(endpointLag());
      else if (msg.speech_final) flushOnPause();
      // законченные предложения внутри — сразу в финал, хвост начинает следующую фразу
      else if (commitSentences(joined)) return;
      else if (wordCount(joined) > 30) flush(null); // длинный монолог без точек
      else if (text) prefetchFinal(joined);
    } else {
      const stable = stableWords(latestInterim, text);
      if (text) cancelPauseHold(); // речь возобновилась — фразу закроет следующая пауза
      latestInterim = text;
      updatePhrase(joinText(buffer.join(' '), text), joinText(buffer.join(' '), stable));
    }
  } else if (msg.type === 'UtteranceEnd') {
    if (Number.isFinite(msg.last_word_end)) phraseWordEnd = msg.last_word_end;
    flushOnPause();
  }
}

// Пауза посреди мысли («this technology is ... used by») не закрывает фразу:
// иначе перевод и субтитры рвутся на обрывки. Ждём продолжения, но недолго —
// если человек замолчал, фраза уйдёт в финал сама.
function flushOnPause() {
  const text = joinText(buffer.join(' '), latestInterim);
  if (!looksUnfinished(text) || wordCount(text) > 30) return flush(endpointLag());
  if (!pauseHoldTimer) pauseHoldTimer = setTimeout(() => { pauseHoldTimer = null; flush(endpointLag()); }, PAUSE_HOLD_MS);
}

function cancelPauseHold() {
  clearTimeout(pauseHoldTimer);
  pauseHoldTimer = null;
}

// Закрывает фразу на последней границе предложения и переносит хвост в новую.
// Работает только по закреплённому тексту (is_final): черновик Deepgram ещё может
// измениться, и его слова потом пришли бы повторно.
function commitSentences(text) {
  const split = splitAtSentence(text);
  if (!split) return false;
  const wordEnd = phraseWordEnd; // конец последнего слова относится к хвосту
  buffer = [split.done];
  flush(null);
  buffer = [split.rest];
  phraseWordEnd = wordEnd;
  updatePhrase(split.rest, split.rest);
  prefetchFinal(split.rest);
  return true;
}

// Сколько звука прошло после последнего слова фразы к моменту её закрытия.
const endpointLag = () => phraseWordEnd == null ? null : lagMs(audioClock.seconds(), phraseWordEnd);

async function connectStt(language) {
  const yandex = prefs.sttEngine === 'yandex';
  const name = yandex ? 'сервер LiveDub' : 'Deepgram';
  const sock = yandex
    ? openYandexStt(keys.serverUrl, language, { endpointing: prefs.endpointing, token: keys.serverToken })
    : openDeepgram(keys.deepgramKey, language, { endpointing: prefs.endpointing });
  sock.onmessage = (ev) => {
    if (sock !== session?.ws) return;
    const message = JSON.parse(ev.data);
    if (message.type === 'Results' && message.channel?.alternatives?.[0]?.transcript) session.sttResults++;
    handleDeepgram(message);
  };
  sock.onclose = (ev) => {
    stopKeepAlive(sock);
    if (session?.ws === sock) stop(`${name} закрыл соединение (${ev.code}) ${ev.reason}`.trim());
  };
  await new Promise((ok, fail) => {
    const timeout = setTimeout(() => { sock.close(); fail(new Error(`таймаут подключения: ${name}`)); }, 8000);
    sock.onopen = () => { clearTimeout(timeout); startKeepAlive(sock); ok(); };
    // До открытия ошибка почти всегда означает неверный ключ, токен или адрес.
    sock.onerror = () => {
      clearTimeout(timeout);
      fail(new Error(yandex
        ? 'Сервер LiveDub не принял подключение: запущен ли он, есть ли на нём ключ SpeechKit, верен ли токен'
        : 'Deepgram отклонил подключение: проверьте ключ'));
    };
  });
  sock.onerror = () => setStatus(`ошибка WebSocket: ${name}`, 'err');
  return sock;
}

// ---------- старт / стоп ----------
function lockControls(live) {
  for (const id of LOCKED_WHILE_LIVE) $(id).disabled = live;
  $('stop').disabled = !live;
}

function captureErrorMessage(error) {
  const message = error?.message || String(error);
  if (/Chrome pages cannot be captured|Cannot capture a chrome:|Cannot capture a chrome-extension:/i.test(message))
    return 'Эту служебную страницу Chrome нельзя захватить. Откройте вкладку с видео или звуком.';
  if (/activeTab|not been invoked|permission|not allowed/i.test(message))
    return 'Нет доступа к этой вкладке. Нажмите на иконку LiveDub на нужной вкладке, затем «Переводить эту вкладку».';
  if (/active stream/i.test(message)) return 'Эта вкладка уже захвачена: остановите предыдущий захват.';
  return message;
}

$('start').onclick = async () => {
  if (prefs.source === prefs.target) return setStatus('языки совпадают', 'err');
  if (sttProblem()) return setStatus(sttProblem(), 'err');
  const generation = ++captureGeneration;
  speech.cancel();
  lockControls(true);

  // Translator.create и AudioContext требуют жеста пользователя — создаём до первого await.
  const needsChrome = prefs.draftEngine === 'chrome' || prefs.finalEngine === 'chrome';
  translatorPromise = needsChrome ? createChromeTranslator(prefs.source, prefs.target) : Promise.resolve(null);
  translatorPromise.catch((e) => setStatus(`ошибка Chrome Translator: ${e.message}`, 'err'));
  const current = { tabId: null, tabTitle: '', audioContext: new AudioContext(), stream: null, audio: null, ws: null,
    sentBytes: 0, audibleBytes: 0, sttResults: 0, connectedAt: null, metricsTimer: null, subtitleError: '' };
  session = current;
  audioClock = createAudioClock(); // время Deepgram отсчитывается от начала каждого соединения
  const cancelled = () => generation !== captureGeneration;

  try {
    setStatus('захват звука вкладки…');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('Не найдена активная вкладка');
    current.tabId = tab.id;
    current.tabTitle = tab.title || '';
    let streamId;
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    } catch (error) {
      // Для активной вкладки Chrome допускает вызов без targetTabId.
      if (!/activeTab|not been invoked|permission|not allowed/i.test(error?.message || '')) throw error;
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (active?.id !== tab.id) throw error;
      streamId = await chrome.tabCapture.getMediaStreamId();
    }
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
      onPcm: (data) => {
        if (current.ws?.readyState !== WebSocket.OPEN) return;
        current.ws.send(data);
        audioClock.add(data.byteLength);
        current.sentBytes += data.byteLength;
        const samples = new Int16Array(data);
        let energy = 0;
        for (const sample of samples) energy += (sample / 32768) ** 2;
        if (Math.sqrt(energy / samples.length) > 0.01) current.audibleBytes += data.byteLength;
      },
    });
    if (cancelled()) return;

    setStatus(`подключение: ${STT_NAMES[prefs.sttEngine]}…`);
    const sock = await connectStt(prefs.source);
    if (cancelled()) {
      stopKeepAlive(sock);
      sock.send(JSON.stringify({ type: 'CloseStream' }));
      return;
    }
    current.ws = sock;
    current.connectedAt = Date.now();
    showCaptureMetrics(current);
    current.metricsTimer = setInterval(() => showCaptureMetrics(current), 2000);
    if (prefs.subtitles) injectSubtitles(tab.id);

    const names = { chrome: 'Chrome', deepseek: keys.deepseekModel, yandex: 'Yandex Translate', off: '—' };
    setStatus(`в эфире · ${prefs.source} → ${prefs.target} · распознавание: ${STT_NAMES[prefs.sttEngine]}, ` +
      `черновик: ${names[prefs.draftEngine]}, финал: ${names[prefs.finalEngine]}`, 'live');
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
    clearInterval(current.metricsTimer);
    current.audio?.stop();
    current.audioContext.close().catch(() => {});
    if (current.ws?.readyState === WebSocket.OPEN) current.ws.send(JSON.stringify({ type: 'CloseStream' }));
    current.stream?.getTracks().forEach((track) => track.stop());
    if (current.tabId) sendToTab(current.tabId, { type: 'tt-subtitle-clear' });
  }
  lockControls(false);
  $('captureMetrics').textContent = '';
  if (errorMessage) setStatus(errorMessage, 'err');
  else setStatus('остановлено');
}
$('stop').onclick = () => stop();

syncControls();
showSpeechStats();
