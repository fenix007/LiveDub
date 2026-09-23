// Очередь озвучки перевода, перенесённая из public/index.html без привязки к DOM.
// Браузерный голос произносит черновик без последнего (нестабильного) слова, после
// финала досказываются новые слова; уже сказанное начало не повторяется.
// SpeechKit озвучивает только слова, совпавшие в двух черновых переводах подряд,
// а если финал переписал сказанное — продолжает с надёжного стыка или
// произносит финал заново как исправление.
import { commonSpeechWords, resumeFinalSpeech, sameSpeechWord, speechWords } from './text.js';

const BCP47 = { en: 'en-US', ru: 'ru-RU', de: 'de-DE', fr: 'fr-FR', es: 'es-ES' };
export const speechLang = (code) => BCP47[code] || code;

// Голоса SpeechKit API v1 по целевому языку перевода.
export const YANDEX_VOICES = {
  ru: { marina: 'Марина', alena: 'Алёна', jane: 'Джейн', filipp: 'Филипп', ermil: 'Ермил', zahar: 'Захар' },
  en: { john: 'John' },
  de: { lea: 'Lea' },
};

const speechSeconds = (text) => text.length / 15;

/**
 * config()  → { enabled, provider: 'browser'|'yandex', voice, target, yandexKey }
 * isCurrent(state) → фраза относится к текущему захвату
 * synthesize({ text, lang, voice, signal }) → Response с MP3 (SpeechKit)
 */
export function createSpeech({ config, isCurrent, synthesize, onStats = () => {}, onSpeaking = () => {} }) {
  const available = typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
  const stats = { starts: [], prefixMismatch: 0, backlogDropped: 0, errors: 0 };
  let queue = [];
  let active = null;
  let epoch = 0;
  let restartTimer = null;
  let notice = '';

  const report = () => onStats({ ...stats, notice });
  const yandexSelected = () => config().provider === 'yandex';
  const setActive = (job) => { active = job; onSpeaking(Boolean(job)); };
  const recordStart = (job, state) => {
    job.started = true;
    job.startedAt = performance.now();
    stats.starts.push(job.startedAt - state.ttsQueuedAt);
    if (stats.starts.length > 50) stats.starts.shift();
    report();
  };

  function browserVoices() {
    if (!available) return [];
    const target = config().target.toLowerCase();
    return speechSynthesis.getVoices()
      .filter((voice) => voice.lang.toLowerCase().split(/[-_]/)[0] === target)
      .sort((a, b) => Number(b.localService) - Number(a.localService));
  }

  function voices() {
    const c = config();
    if (c.provider === 'yandex') return Object.entries(YANDEX_VOICES[c.target] || {}).map(([id, name]) => ({ id, name }));
    return browserVoices().map((voice) => ({ id: voice.voiceURI, name: `${voice.name}${voice.localService ? ' · локальный' : ''}` }));
  }

  function ready() {
    const c = config();
    if (c.provider === 'yandex') return Boolean(c.yandexKey && YANDEX_VOICES[c.target]);
    return browserVoices().length > 0;
  }

  function cancel() {
    ++epoch;
    if (active) {
      // Отменённая реплика могла прозвучать частично: лучше пропустить хвост, чем повторить начало.
      if (active.started) active.state.ttsWords = active.spokenWords;
      clearTimeout(active.watchdog);
      active.controller?.abort();
      active.audio?.pause();
      if (active.audioUrl) URL.revokeObjectURL(active.audioUrl);
    }
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    setActive(null);
    queue = [];
    if (available) speechSynthesis.cancel();
  }

  const backlogSeconds = () =>
    (active ? Math.max(0, speechSeconds(active.text) -
      (active.startedAt == null ? 0 : (performance.now() - active.startedAt) / 1000)) : 0) +
    queue.reduce((sum, state) => sum + speechSeconds(
      speechWords(state.ttsCandidate).slice(state.ttsWords.length).join(' ')), 0);

  function enqueue(state, first = false) {
    if (state.ttsDropped || active?.state === state || queue.includes(state)) return;
    if (!first && !state.ttsCandidateFinal && backlogSeconds() > 4) {
      stats.backlogDropped++;
      report();
      return;
    }
    state.ttsQueuedAt = performance.now();
    if (first) queue.unshift(state);
    else queue.push(state);
    while (queue.length > 2) {
      const index = queue.findIndex((item) => !item.ttsCandidateFinal);
      if (index < 0) break; // финальные реплики нельзя молча выкидывать из очереди
      queue.splice(index, 1);
      stats.backlogDropped++;
      report();
    }
    pump();
  }

  function pump() {
    if (!ready() || active || restartTimer || !config().enabled) return;
    while (!active && queue.length) {
      const state = queue.shift();
      if (state.ttsDropped || !isCurrent(state)) continue;
      const allWords = speechWords(state.ttsCandidate);
      // У браузерного голоса последний токен черновика нестабилен; черновик SpeechKit уже подтверждён.
      const desired = state.ttsCandidateFinal || yandexSelected() ? allWords : allWords.slice(0, -1);
      if (desired.length < 2 && !state.ttsCandidateFinal) continue;
      const committed = state.ttsWords;
      const matches = committed.every((word, index) =>
        index < desired.length && sameSpeechWord(word, desired[index]));
      if (!matches) {
        if (!yandexSelected()) { // браузерный голос не повторяет уже сказанное
          state.ttsDropped = true;
          stats.prefixMismatch++;
          report();
          continue;
        }
        if (!state.ttsRewritten) {
          state.ttsRewritten = true;
          stats.prefixMismatch++;
        }
        if (state.ttsCandidateFinal) {
          state.ttsWords = desired.slice(0, resumeFinalSpeech(committed, desired));
          queue.unshift(state);
        }
        report();
        continue; // черновик с расхождением ждёт финала
      }
      // Каждый удалённый перевод может менять последние слова; короткие клочки звучат рвано.
      if (yandexSelected() && !state.ttsCandidateFinal && desired.length - committed.length < 2) continue;
      if (desired.length <= committed.length) continue;
      let end = committed.length;
      while (end < desired.length && desired.slice(committed.length, end + 1).join(' ').length <= 180) end++;
      if (end === committed.length) end++;
      const spokenWords = desired.slice(0, end);
      const text = desired.slice(committed.length, end).join(' ');
      if (config().provider === 'yandex') speakYandex(state, text, spokenWords);
      else speakBrowser(state, text, spokenWords);
      return;
    }
  }

  function finishJob(job) {
    job.state.ttsWords = job.spokenWords;
    setActive(null);
    if (job.state.ttsCandidate) enqueue(job.state, true);
    pump();
  }

  function failJob(state, message) {
    state.ttsDropped = true;
    setActive(null);
    stats.errors++;
    if (message) notice = message;
    report();
    pump();
  }

  function speakBrowser(state, text, spokenWords) {
    const c = config();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = speechLang(c.target);
    utterance.rate = 1.12;
    const list = browserVoices();
    utterance.voice = list.find((voice) => voice.voiceURI === c.voice) || list[0] || null;
    const jobEpoch = epoch;
    const job = { state, text, spokenWords, watchdog: null, started: false, startedAt: null };
    setActive(job);
    utterance.onstart = () => {
      if (jobEpoch !== epoch) return;
      if (!isCurrent(state) || !config().enabled) cancel();
      else recordStart(job, state);
    };
    utterance.onend = () => {
      if (jobEpoch !== epoch || active !== job) return;
      clearTimeout(job.watchdog);
      finishJob(job);
    };
    utterance.onerror = (event) => {
      if (jobEpoch !== epoch || active !== job) return;
      clearTimeout(job.watchdog);
      if (event?.error === 'not-allowed') {
        stats.errors++;
        notice = 'Браузер запретил озвучивание: включите его переключателем ещё раз';
        cancel();
        report();
        return;
      }
      failJob(state);
    };
    try {
      speechSynthesis.resume();
      speechSynthesis.speak(utterance);
      job.watchdog = setTimeout(() => {
        if (jobEpoch !== epoch || active !== job) return;
        state.ttsDropped = true;
        stats.errors++;
        report();
        ++epoch;
        setActive(null);
        speechSynthesis.cancel();
        restartTimer = setTimeout(() => { restartTimer = null; pump(); }, 150);
      }, Math.max(4500, Math.min(20000, speechSeconds(text) * 1500 + 1500)));
    } catch (error) {
      console.error('Speech synthesis:', error);
      failJob(state);
    }
  }

  async function speakYandex(state, text, spokenWords) {
    const c = config();
    const jobEpoch = epoch;
    const controller = new AbortController();
    const job = { state, text, spokenWords, started: false, startedAt: null, controller, audio: null, audioUrl: null, watchdog: null };
    setActive(job);
    const current = () => jobEpoch === epoch && active === job && isCurrent(state) && config().enabled;
    const voice = YANDEX_VOICES[c.target]?.[c.voice] ? c.voice : Object.keys(YANDEX_VOICES[c.target] || {})[0];
    try {
      job.watchdog = setTimeout(() => controller.abort(), 20_000);
      const response = await synthesize({ text, lang: speechLang(c.target), voice, signal: controller.signal });
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 200);
        throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
      }
      if (!current()) return;
      const audio = new Audio();
      // При отставании очереди говорим чуть быстрее, но не больше 1.3x.
      const otherBacklog = queue.reduce((sum, item) => sum + speechSeconds(
        speechWords(item.ttsCandidate).slice(item.ttsWords.length).join(' ')), 0);
      audio.defaultPlaybackRate = Math.min(1.3, 1.12 + Math.max(0, otherBacklog - 4) * .025);
      audio.playbackRate = audio.defaultPlaybackRate;
      job.audio = audio;
      const finished = new Promise((resolve, reject) => {
        audio.onended = resolve;
        audio.onerror = () => reject(new Error('не удалось воспроизвести звук'));
        controller.signal.addEventListener('abort', () => reject(new Error('таймаут или отмена озвучки')), { once: true });
      });
      finished.catch(() => {});
      audio.onplaying = () => {
        if (!current() || job.started) return;
        notice = '';
        recordStart(job, state);
      };
      if ('MediaSource' in globalThis && MediaSource.isTypeSupported('audio/mpeg') && response.body) {
        // MP3 играет по мере загрузки, не дожидаясь конца синтеза.
        const media = new MediaSource();
        job.audioUrl = URL.createObjectURL(media);
        audio.src = job.audioUrl;
        await new Promise((resolve, reject) => {
          media.addEventListener('sourceopen', resolve, { once: true });
          media.addEventListener('error', () => reject(new Error('MediaSource недоступен')), { once: true });
          controller.signal.addEventListener('abort', () => reject(new Error('таймаут или отмена озвучки')), { once: true });
        });
        if (!current()) return;
        const sourceBuffer = media.addSourceBuffer('audio/mpeg');
        const parts = [];
        let done = false, started = false, receivedAudio = false;
        const append = () => {
          if (!current() || sourceBuffer.updating) return;
          if (parts.length) sourceBuffer.appendBuffer(parts.shift());
          else if (done && media.readyState === 'open') media.endOfStream();
        };
        sourceBuffer.addEventListener('updateend', () => {
          if (!started && current()) { started = true; audio.play().catch(() => controller.abort()); }
          append();
        });
        const reader = response.body.getReader();
        while (current()) {
          const part = await reader.read();
          if (part.done) {
            if (!receivedAudio) throw new Error('пустой звук');
            done = true; append(); break;
          }
          if (part.value.length) { receivedAudio = true; parts.push(part.value); append(); }
        }
      } else {
        job.audioUrl = URL.createObjectURL(await response.blob());
        audio.src = job.audioUrl;
        if (current()) await audio.play();
      }
      if (!current()) return;
      await finished;
      if (!current()) return;
      clearTimeout(job.watchdog);
      URL.revokeObjectURL(job.audioUrl);
      finishJob(job);
    } catch (error) {
      if (!current()) return;
      setActive(null);
      stats.errors++;
      notice = `SpeechKit: ${error.message}`;
      report();
      if (state.ttsCandidateFinal && (state.ttsRetries || 0) < 1) { // финал пробуем ещё раз
        state.ttsRetries = (state.ttsRetries || 0) + 1;
        enqueue(state, true);
      }
      pump();
    } finally {
      clearTimeout(job.watchdog);
      if (active === job) { // задание устарело (озвучку выключили и т. п.) — освобождаем очередь
        setActive(null);
        controller.abort();
        job.audio?.pause();
        pump();
      }
      if (job.audioUrl) URL.revokeObjectURL(job.audioUrl);
    }
  }

  function speak(state, translated, final = false) {
    if (!ready() || !config().enabled || !isCurrent(state)) return;
    if (state.ttsCandidateFinal && !final) return;
    if (yandexSelected() && !final) {
      const words = speechWords(translated);
      const previous = state.ttsPreviousDraft;
      state.ttsPreviousDraft = words;
      if (!previous) return; // первое предположение переводчика ещё не подтверждено
      const approved = commonSpeechWords(previous, words);
      if (approved.length <= state.ttsWords.length) return;
      state.ttsCandidate = approved.join(' ');
    } else {
      state.ttsCandidate = translated;
    }
    state.ttsCandidateFinal = final;
    enqueue(state);
  }

  // После смены голоса или провайдера продолжить текущую фразу с несказанного места.
  function restart(state) {
    cancel();
    if (state?.ttsCandidate && config().enabled) enqueue(state);
  }

  return {
    available, ready, voices, speak, cancel, restart,
    activeState: () => active?.state ?? null,
    setNotice(text) { notice = text; report(); },
    stats: () => ({ ...stats, notice }),
  };
}
