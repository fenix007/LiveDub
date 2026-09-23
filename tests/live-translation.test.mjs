import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

class Element {
  constructor(className = '') {
    this.className = className;
    this.textContent = '';
    this.children = [];
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.listeners = new Map();
    this.classList = {
      remove: (name) => { this.className = this.className.split(' ').filter((part) => part !== name).join(' '); },
      contains: (name) => this.className.split(' ').includes(name),
    };
  }

  set innerHTML(_) {
    this.src = new Element('src');
    this.tr = new Element('tr pending');
    this.tr.textContent = 'перевожу…';
  }

  querySelector(selector) {
    if (selector === '.src') return this.src;
    if (selector === '.tr') return this.tr;
    return new Element();
  }

  appendChild(child) { this.children.push(child); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  dispatch(name) { this.listeners.get(name)?.(); }
}

function harness(config = { gemini: true, geminiModel: 'test', llm: false }, { withSpeech = false, withYandex = false } = {}) {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const elements = Object.fromEntries(['log', 'status', 'src', 'tgt', 'mode', 'start', 'stop', 'tts', 'ttsProvider', 'voice', 'ttsMetrics']
    .map((id) => [id, new Element()]));
  elements.src.value = 'en'; elements.tgt.value = 'ru'; elements.mode.value = 'gemini'; elements.ttsProvider.value = 'browser';
  const requests = [];
  const timers = new Map();
  const intervals = new Map();
  let now = 0, nextTimer = 0;
  const spoken = [];
  const yandexRequests = [];
  const audios = [];
  class FakeAudio {
    constructor() { audios.push(this); }
    play() { this.onplaying?.(); return Promise.resolve(); }
    pause() { this.paused = true; }
    finish() { this.onended?.(); }
  }
  const speech = {
    getVoices: () => [{ name: 'Russian', lang: 'ru-RU', voiceURI: 'ru-local', localService: true }],
    addEventListener: () => {},
    speak: (utterance) => spoken.push(utterance),
    resume: () => {},
    cancel: () => { speech.cancelCount++; },
    cancelCount: 0,
  };
  class FakeUtterance { constructor(text) { this.text = text; } }
  const context = {
    document: { getElementById: (id) => elements[id], createElement: () => new Element(), body: { scrollHeight: 0 } },
    window: { scrollTo: () => {}, ...(withSpeech ? { speechSynthesis: speech, SpeechSynthesisUtterance: FakeUtterance } : {}) },
    SpeechSynthesisUtterance: FakeUtterance,
    Audio: FakeAudio,
    AbortController,
    URL: { createObjectURL: () => 'blob:audio', revokeObjectURL: () => {} },
    self: {}, performance: { now: () => now },
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (callback, delay) => { const id = ++nextTimer; intervals.set(id, { at: now + delay, delay, callback }); return id; },
    clearInterval: (id) => intervals.delete(id),
    WebSocket: { OPEN: 1 },
    fetch: (url, options) => {
      if (url === '/api/config') return Promise.resolve({ json: async () => config });
      if (url === '/api/tts' && withYandex) {
        yandexRequests.push({ body: JSON.parse(options.body), signal: options.signal });
        return Promise.resolve({ ok: true, blob: async () => ({}) });
      }
      assert.equal(url, '/api/translate');
      return new Promise((resolve) => requests.push({
        body: JSON.parse(options.body),
        respond: (translation) => resolve({ ok: true, json: async () => ({ translation }) }),
        fail: (message) => resolve({ ok: false, status: 500, json: async () => ({ error: message }) }),
      }));
    },
  };
  vm.runInNewContext(script, context);
  const result = (text, isFinal = false, speechFinal = false) => context.handleDeepgram({
    type: 'Results', is_final: isFinal, speech_final: speechFinal,
    channel: { alternatives: [{ transcript: text }] },
  });
  const advance = (ms) => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) { timers.delete(id); timer.callback(); }
    }
    for (const interval of intervals.values()) {
      while (interval.at <= now) { interval.at += interval.delay; interval.callback(); }
    }
  };
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  return { elements, requests, yandexRequests, audios, result, advance, settle, context, spoken, speech };
}

test('Yandex TTS starts on a stable draft before the source sentence ends', async () => {
  const app = harness({ gemini: true, geminiModel: 'test', llm: false, yandexTts: true },
    { withSpeech: true, withYandex: true });
  await app.settle();
  assert.equal(app.elements.ttsProvider.value, 'yandex');
  app.elements.tts.checked = true;
  app.result('We are ready');
  app.result('We are ready now');
  app.advance(150);
  app.requests[0].respond('Мы уже готовы идти');
  await app.settle();
  app.context.speakTranslation(app.context.ensurePhrase(), 'Мы уже готовы идти завтра', false);
  await app.settle();
  assert.equal(app.yandexRequests.length, 1);
  assert.equal(app.yandexRequests[0].body.text, 'Мы уже готовы идти');
  assert.equal(app.elements.log.children[0].className, 'row draft');
  app.audios[0].finish();
  await app.settle();
});

test('turning off Yandex TTS aborts synthesis and pauses its audio', async () => {
  const app = harness({ gemini: true, geminiModel: 'test', llm: false, yandexTts: true },
    { withSpeech: true, withYandex: true });
  await app.settle();
  app.elements.tts.checked = true;
  app.result('We are ready');
  app.result('We are ready now');
  app.advance(150);
  app.requests[0].respond('Мы уже готовы идти');
  await app.settle();
  app.context.speakTranslation(app.context.ensurePhrase(), 'Мы уже готовы идти завтра', false);
  await app.settle();
  app.elements.tts.checked = false;
  app.elements.tts.dispatch('change');
  assert.equal(app.yandexRequests[0].signal.aborted, true);
  assert.equal(app.audios[0].paused, true);
  await app.settle();
});

test('Yandex TTS continues an aligned final without repeating the stable draft', async () => {
  const app = harness({ gemini: false, yandexTts: true, llm: false }, { withSpeech: true, withYandex: true });
  await app.settle();
  app.elements.tts.checked = true;
  const state = app.context.ensurePhrase();
  app.context.speakTranslation(state, 'Мы уже готовы идти', false);
  app.context.speakTranslation(state, 'Мы уже готовы идти дальше', false);
  await app.settle();
  assert.equal(app.yandexRequests[0].body.text, 'Мы уже готовы идти');
  app.context.speakTranslation(state, 'Мы уже готовы идти дальше вместе', true);
  app.audios[0].finish();
  await app.settle();
  assert.equal(app.yandexRequests[1].body.text, 'дальше вместе');
  app.audios[1].finish();
  await app.settle();
  assert.equal(state.ttsDropped, false);
});

test('Yandex TTS speaks a rewritten final instead of dropping the rest of the phrase', async () => {
  const app = harness({ gemini: false, yandexTts: true, llm: false }, { withSpeech: true, withYandex: true });
  await app.settle();
  app.elements.tts.checked = true;
  const state = app.context.ensurePhrase();
  app.context.speakTranslation(state, 'Я думаю, что это работает', false);
  app.context.speakTranslation(state, 'Я думаю, что это работает хорошо', false);
  await app.settle();
  assert.equal(app.yandexRequests[0].body.text, 'Я думаю, что это работает');
  app.context.speakTranslation(state, 'Мне кажется, что это работает иначе', true);
  app.audios[0].finish();
  await app.settle();
  assert.equal(app.yandexRequests[1].body.text, 'иначе');
  assert.equal(state.ttsDropped, false);
  app.audios[1].finish();
  await app.settle();
});

test('speech alignment does not skip a new negation or changed number', () => {
  const app = harness();
  assert.equal(app.context.resumeFinalSpeech(['Я', 'хочу', 'это'], ['Я', 'не', 'хочу', 'это']), 0);
  assert.equal(app.context.resumeFinalSpeech(['200', 'долларов', 'кредита'],
    ['300', 'долларов', 'кредита']), 0);
  assert.equal(vm.runInNewContext("sameSpeechWord('шестнадцать', 'шестьдесят')", app.context), false);
  assert.equal(vm.runInNewContext("sameSpeechWord('девятнадцать', 'девяносто')", app.context), false);
  assert.equal(vm.runInNewContext('sameSpeechWord("should", "shouldn\'t")', app.context), false);
  assert.equal(app.context.resumeFinalSpeech(['это', 'важно', 'сказал', 'что'],
    ['это', 'совсем', 'другое', 'и', 'еще', 'раз', 'сказал', 'что']), 0);
});

test('a rewritten final runs before another queued phrase without overlapping Yandex jobs', async () => {
  const app = harness({ gemini: false, yandexTts: true, llm: false }, { withSpeech: true, withYandex: true });
  await app.settle();
  app.elements.tts.checked = true;
  const first = app.context.ensurePhrase();
  app.context.speakTranslation(first, 'Я думаю что это работает', false);
  app.context.speakTranslation(first, 'Я думаю что это работает хорошо', false);
  await app.settle();
  app.context.speakTranslation(first, 'Мне кажется что это работает иначе', true);
  vm.runInNewContext('phrase = null', app.context);
  const second = app.context.ensurePhrase();
  app.context.speakTranslation(second, 'Следующая фраза уже готова', true);
  assert.equal(app.yandexRequests.length, 1);
  app.audios[0].finish();
  await app.settle();
  assert.equal(app.yandexRequests.length, 2);
  assert.equal(app.yandexRequests[1].body.text, 'иначе');
  app.audios[1].finish();
  await app.settle();
  assert.equal(app.yandexRequests[2].body.text, 'Следующая фраза уже готова');
  app.audios[2].finish();
  await app.settle();
  assert.equal(first.ttsDropped, false);
  assert.equal(second.ttsDropped, false);
});

test('Yandex TTS releases an invalidated job and preserves queued finals', async () => {
  const app = harness({ gemini: false, yandexTts: true, llm: false }, { withSpeech: true, withYandex: true });
  await app.settle();
  app.elements.tts.checked = true;
  const first = app.context.ensurePhrase();
  app.context.speakTranslation(first, 'Первая финальная фраза', true);
  app.elements.tts.checked = false; // состояние изменилось до завершения fetch, без обработчика UI
  await app.settle();
  assert.equal(vm.runInNewContext('speechActive === null', app.context), true);
  app.elements.tts.checked = true;
  vm.runInNewContext('phrase = null', app.context);
  const second = app.context.ensurePhrase();
  app.context.speakTranslation(second, 'Вторая финальная фраза', true);
  vm.runInNewContext('phrase = null', app.context);
  const third = app.context.ensurePhrase();
  app.context.speakTranslation(third, 'Третья финальная фраза', true);
  vm.runInNewContext('phrase = null', app.context);
  const fourth = app.context.ensurePhrase();
  app.context.speakTranslation(fourth, 'Четвертая финальная фраза', true);
  assert.equal(second.ttsDropped, false);
  assert.equal(third.ttsDropped, false);
  assert.equal(fourth.ttsDropped, false);
  assert.equal(vm.runInNewContext('speechQueue.length', app.context), 2);
  await app.settle();
  app.audios[0].finish();
  await app.settle();
});

test('Yandex TTS in hybrid mode reads the DeepSeek final shown on screen', async () => {
  const app = harness({ gemini: false, deepseek: true, deepseekModel: 'deepseek-flash', llm: false, yandexTts: true },
    { withSpeech: true, withYandex: true });
  app.context.self.Translator = true;
  await app.settle();
  assert.equal(app.elements.mode.value, 'hybridDeepseek');
  app.elements.tts.checked = true;
  vm.runInNewContext('translatorPromise = Promise.resolve({ translate: async () => "Черновик Chrome" })', app.context);
  app.result('We are ready');
  app.result('We are ready now');
  app.advance(150);
  await app.settle();
  assert.equal(app.yandexRequests.length, 0);
  app.result('We are ready', true, true);
  app.requests[0].respond('Точный финальный перевод DeepSeek');
  await app.settle();
  assert.equal(app.elements.log.children[0].tr.textContent, 'Точный финальный перевод DeepSeek');
  assert.equal(app.yandexRequests.length, 1);
  assert.equal(app.yandexRequests[0].body.text, 'Точный финальный перевод DeepSeek');
  app.audios[0].finish();
  await app.settle();
});

test('translates a stable interim prefix, then replaces it with the final translation', async () => {
  const app = harness();
  await app.settle();
  app.result('Hello I am');
  app.result('Hello I am here');
  assert.equal(app.elements.log.children.length, 1);
  assert.equal(app.elements.log.children[0].src.textContent, 'Hello I am here');
  assert.equal(app.requests.length, 0);
  app.advance(150);
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].body.text, 'Hello I am');

  app.result('Hello I am here', true, true);
  assert.equal(app.requests.length, 2);
  assert.equal(app.requests[1].body.text, 'Hello I am here');
  app.requests[1].respond('Привет, я здесь');
  await app.settle();
  app.requests[0].respond('Привет, я');
  await app.settle();
  const row = app.elements.log.children[0];
  assert.equal(row.className, 'row');
  assert.equal(row.tr.textContent, 'Привет, я здесь');
  assert.equal(app.elements.log.children.length, 1);
});

test('reuses an in-flight translation when the final transcript matches the draft', async () => {
  const app = harness();
  await app.settle();
  app.result('We are ready');
  app.result('We are ready now');
  app.advance(150);
  assert.equal(app.requests.length, 1);
  app.result('We are ready', true, true);
  assert.equal(app.requests.length, 1);
  app.requests[0].respond('Мы готовы');
  await app.settle();
  assert.equal(app.elements.log.children[0].tr.textContent, 'Мы готовы');
});

test('reused draft is spoken in full once its source transcript becomes final', async () => {
  const app = harness(undefined, { withSpeech: true });
  app.elements.tts.checked = true;
  await app.settle();
  app.result('We are ready');
  app.result('We are ready now');
  app.advance(150);
  app.result('We are ready', true, true);
  assert.equal(app.requests.length, 1);
  app.requests[0].respond('Мы готовы');
  await app.settle();
  assert.deepEqual(app.spoken.map((item) => item.text), ['Мы готовы']);
});

test('waits for three new stable words and throttles draft requests', async () => {
  const app = harness();
  await app.settle();
  app.result('We are ready');
  app.result('We are ready to');
  app.advance(150);
  assert.equal(app.requests.length, 1);
  app.requests[0].respond('Мы готовы');
  await app.settle();

  app.result('We are ready to go');
  app.result('We are ready to go now everyone');
  assert.equal(app.requests.length, 1);
  app.result('We are ready to go now everyone here');
  app.advance(1199);
  assert.equal(app.requests.length, 1);
  app.advance(1);
  assert.equal(app.requests.length, 2);
  assert.equal(app.requests[1].body.text, 'We are ready to go now everyone');
});

test('Yandex drafts refresh after two new source words and 650 ms', async () => {
  const app = harness({ gemini: false, deepseek: false, yandexTranslate: true, llm: false });
  await app.settle();
  app.result('We are ready');
  app.result('We are ready now');
  app.advance(150);
  assert.equal(app.requests.length, 1);
  app.requests[0].respond('Мы готовы');
  await app.settle();
  app.result('We are ready to go');
  app.result('We are ready to go now');
  app.advance(649);
  assert.equal(app.requests.length, 1);
  app.advance(1);
  assert.equal(app.requests.length, 2);
  assert.equal(app.requests[1].body.text, 'We are ready to go');
});

test('ignores a draft answer after the transcript revises earlier words', async () => {
  const app = harness();
  await app.settle();
  app.result('I think this');
  app.result('I think this works');
  app.advance(150);
  app.result('I know this works');
  app.result('I know this works well');
  app.requests[0].respond('Я думаю, это работает');
  await app.settle();
  assert.equal(app.elements.log.children[0].tr.textContent, 'перевожу…');
  app.advance(1200);
  assert.equal(app.requests.length, 2);
  assert.equal(app.requests[1].body.text, 'I know this works');
});

test('keeps only one Gemini draft in flight while final translations proceed', async () => {
  const app = harness();
  await app.settle();
  app.result('First phrase starts');
  app.result('First phrase starts now');
  app.advance(150);
  assert.equal(app.requests[0].body.kind, 'draft');
  app.result('First phrase starts now', true, true);
  assert.equal(app.requests[1].body.kind, 'final');

  app.result('Second phrase starts');
  app.result('Second phrase starts now');
  app.advance(150);
  assert.equal(app.requests.length, 2);
  app.requests[0].respond('Первый черновик');
  await app.settle();
  app.advance(150);
  assert.equal(app.requests.length, 3);
  assert.equal(app.requests[2].body.kind, 'draft');
  assert.equal(app.requests[2].body.text, 'Second phrase starts');
});

test('hybrid mode keeps draft translation on device and sends only finals to Gemini', async () => {
  const app = harness();
  app.context.self.Translator = true;
  await app.settle();
  assert.equal(app.elements.mode.value, 'hybrid');
  vm.runInNewContext('translatorPromise = Promise.resolve({ translate: async () => "локально" })', app.context);
  assert.equal(await app.context.translate('Hello', [], 'draft'), 'локально');
  assert.equal(app.requests.length, 0);
  const final = app.context.translate('Hello', [], 'final');
  await app.settle();
  assert.equal(app.requests[0].body.provider, 'gemini');
  assert.equal(app.requests[0].body.kind, 'final');
  app.requests[0].respond('Привет');
  assert.equal(await final, 'Привет');
});

test('hybrid mode requests a Gemini final even when it matches the local draft', async () => {
  const app = harness();
  app.context.self.Translator = true;
  await app.settle();
  vm.runInNewContext('translatorPromise = Promise.resolve({ translate: async () => "локально" })', app.context);
  app.result('We are ready');
  app.result('We are ready now');
  app.advance(150);
  await app.settle();
  assert.equal(app.elements.log.children[0].tr.textContent, 'локально');
  app.result('We are ready', true, true);
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].body.kind, 'final');
  app.requests[0].respond('Мы готовы');
  await app.settle();
  assert.equal(app.elements.log.children[0].tr.textContent, 'Мы готовы');
});

test('DeepSeek hybrid mode sends finals to DeepSeek and falls back to Chrome on failure', async () => {
  const app = harness({ gemini: false, deepseek: true, deepseekModel: 'deepseek-flash', llm: false });
  app.context.self.Translator = true;
  await app.settle();
  assert.equal(app.elements.mode.value, 'hybridDeepseek');
  vm.runInNewContext('translatorPromise = Promise.resolve({ translate: async () => "локально" })', app.context);
  assert.equal(await app.context.translate('Hello', [], 'draft'), 'локально');
  assert.equal(app.requests.length, 0);
  const final = app.context.translate('Hello', [], 'final');
  await app.settle();
  assert.equal(app.requests[0].body.provider, 'deepseek');
  assert.equal(app.requests[0].body.kind, 'final');
  app.requests[0].fail('DeepSeek HTTP 503');
  assert.equal(await final, 'локально');
});

test('Yandex hybrid mode keeps drafts in Chrome and sends finals to Yandex Translate', async () => {
  const app = harness({ gemini: false, deepseek: true, yandexTranslate: true, llm: false });
  app.context.self.Translator = true;
  await app.settle();
  assert.equal(app.elements.mode.value, 'hybridYandex');
  vm.runInNewContext('translatorPromise = Promise.resolve({ translate: async () => "Черновик Chrome" })', app.context);
  assert.equal(await app.context.translate('Hello', [], 'draft'), 'Черновик Chrome');
  assert.equal(app.requests.length, 0);
  const final = app.context.translate('Hello', [], 'final');
  await app.settle();
  assert.equal(app.requests[0].body.provider, 'yandex');
  assert.equal(app.requests[0].body.kind, 'final');
  app.requests[0].respond('Финал Яндекса');
  assert.equal(await final, 'Финал Яндекса');
});

test('Yandex server mode translates drafts and finals without Chrome Translator', async () => {
  const app = harness({ gemini: false, deepseek: false, yandexTranslate: true, llm: false });
  await app.settle();
  assert.equal(app.elements.mode.value, 'yandex');
  const draft = app.context.translate('Hello', [], 'draft');
  await app.settle();
  assert.equal(app.requests[0].body.provider, 'yandex');
  assert.equal(app.requests[0].body.kind, 'draft');
  app.requests[0].respond('Привет');
  assert.equal(await draft, 'Привет');
});

test('live TTS speaks a stable draft and only the new words of its final translation', async () => {
  const app = harness(undefined, { withSpeech: true });
  app.elements.tts.checked = true;
  await app.settle();
  app.result('We are ready');
  app.result('We are ready now');
  app.advance(150);
  app.requests[0].respond('Мы уже готовы');
  await app.settle();
  assert.deepEqual(app.spoken.map((item) => item.text), ['Мы уже']);
  assert.equal(app.spoken[0].voice.voiceURI, 'ru-local');
  app.result('We are ready now', true, true);
  app.requests[1].respond('Мы уже готовы сейчас');
  await app.settle();
  assert.deepEqual(app.spoken.map((item) => item.text), ['Мы уже']);
  app.spoken[0].onend();
  assert.deepEqual(app.spoken.map((item) => item.text), ['Мы уже', 'готовы сейчас']);
});

test('live TTS waits for final translation after a draft rewrites spoken words', async () => {
  const app = harness(undefined, { withSpeech: true });
  app.elements.tts.checked = true;
  await app.settle();
  app.result('I think that');
  app.result('I think that works');
  app.advance(150);
  app.requests[0].respond('Я думаю что');
  await app.settle();
  app.result('I think that works well here');
  app.result('I think that works well here today');
  app.advance(1200);
  app.requests[1].respond('Мне кажется, что это работает');
  await app.settle();
  assert.deepEqual(app.spoken.map((item) => item.text), ['Я думаю']);
  app.spoken[0].onend();
  app.result('I think that works well here today', true, true);
  app.requests[2].respond('Мне кажется, что это работает здесь');
  await app.settle();
  assert.deepEqual(app.spoken.map((item) => item.text), ['Я думаю']);
  assert.equal(app.elements.log.children[0].tr.textContent, 'Мне кажется, что это работает здесь');
});

test('live TTS keeps one native utterance and replaces a queued draft with its final', () => {
  const app = harness(undefined, { withSpeech: true });
  app.elements.tts.checked = true;
  const first = app.context.ensurePhrase();
  first.final = true;
  app.context.speakTranslation(first, 'Первая готовая фраза', true);
  assert.equal(app.spoken.length, 1);
  vm.runInNewContext('phrase = null', app.context);
  const second = app.context.ensurePhrase();
  app.context.speakTranslation(second, 'Вторая старая версия');
  second.final = true;
  app.context.speakTranslation(second, 'Вторая новая финальная версия', true);
  assert.equal(app.spoken.length, 1);
  app.spoken[0].onend();
  assert.deepEqual(app.spoken.map((item) => item.text),
    ['Первая готовая фраза', 'Вторая новая финальная версия']);
});

test('queued draft stays provisional when its source phrase becomes final', () => {
  const app = harness(undefined, { withSpeech: true });
  app.elements.tts.checked = true;
  const first = app.context.ensurePhrase();
  app.context.speakTranslation(first, 'Первая готовая фраза', true);
  vm.runInNewContext('phrase = null', app.context);
  const second = app.context.ensurePhrase();
  app.context.speakTranslation(second, 'Вторая старая версия', false);
  second.final = true;
  app.spoken[0].onend();
  assert.deepEqual(app.spoken.map((item) => item.text), ['Первая готовая фраза', 'Вторая старая']);
});

test('changing the voice mid-utterance does not repeat committed words', () => {
  const app = harness(undefined, { withSpeech: true });
  app.elements.tts.checked = true;
  const state = app.context.ensurePhrase();
  app.context.speakTranslation(state, 'Первая готовая фраза', true);
  app.spoken[0].onstart();
  app.elements.voice.dispatch('change');
  assert.equal(app.speech.cancelCount, 1);
  app.context.speakTranslation(state, 'Первая готовая фраза дальше', true);
  assert.deepEqual(app.spoken.map((item) => item.text), ['Первая готовая фраза', 'дальше']);
});

test('cancel before speech starts keeps the unsaid chunk available', () => {
  const app = harness(undefined, { withSpeech: true });
  app.elements.tts.checked = true;
  const state = app.context.ensurePhrase();
  app.context.speakTranslation(state, 'Первая готовая фраза', true);
  app.elements.voice.dispatch('change');
  assert.deepEqual(app.spoken.map((item) => item.text), ['Первая готовая фраза', 'Первая готовая фраза']);
});

test('unavailable voice and browser speech denial disable TTS visibly', () => {
  const missing = harness(undefined, { withSpeech: true });
  missing.speech.getVoices = () => [];
  missing.elements.tts.checked = true;
  missing.elements.tts.dispatch('change');
  assert.equal(missing.elements.tts.checked, false);
  assert.match(missing.elements.ttsMetrics.textContent, /нет доступного голоса/);

  const denied = harness(undefined, { withSpeech: true });
  denied.elements.tts.checked = true;
  const state = denied.context.ensurePhrase();
  denied.context.speakTranslation(state, 'Это тест речи', true);
  denied.spoken[0].onerror({ error: 'not-allowed' });
  assert.equal(denied.elements.tts.checked, false);
  assert.match(denied.elements.ttsMetrics.textContent, /запретил озвучивание/);
});

test('hybrid TTS continues the Chrome draft while the server final updates the screen', async () => {
  const app = harness(undefined, { withSpeech: true });
  app.context.self.Translator = true;
  app.elements.tts.checked = true;
  await app.settle();
  vm.runInNewContext(`translatorPromise = Promise.resolve({
    translate: async (text) => text === 'We are ready now' ? 'Мы уже готовы сейчас' : 'Мы уже готовы'
  })`, app.context);
  app.result('We are ready');
  app.result('We are ready now');
  app.advance(150);
  await app.settle();
  assert.deepEqual(app.spoken.map((item) => item.text), ['Мы уже']);
  app.result('We are ready now', true, true);
  await app.settle();
  assert.equal(app.requests.length, 1);
  app.requests[0].respond('Мы готовы сегодня');
  await app.settle();
  app.spoken[0].onend();
  assert.deepEqual(app.spoken.map((item) => item.text), ['Мы уже', 'готовы сейчас']);
  assert.equal(app.elements.log.children[0].tr.textContent, 'Мы готовы сегодня');
});

test('hybrid TTS uses the server final if local final translation is empty', async () => {
  const app = harness(undefined, { withSpeech: true });
  app.context.self.Translator = true;
  app.elements.tts.checked = true;
  await app.settle();
  vm.runInNewContext('translatorPromise = Promise.resolve({ translate: async () => "" })', app.context);
  app.result('Hello there', true, true);
  await app.settle();
  app.requests[0].respond('Привет');
  await app.settle();
  assert.deepEqual(app.spoken.map((item) => item.text), ['Привет']);
});

test('stopping capture cancels speech and suppresses late translations', async () => {
  const app = harness(undefined, { withSpeech: true });
  app.elements.tts.checked = true;
  await app.settle();
  app.result('We are ready');
  app.result('We are ready now');
  app.advance(150);
  app.result('We are ready now', true, true);
  app.context.stop();
  assert.ok(app.speech.cancelCount > 0);
  app.requests[1].respond('Мы готовы сейчас');
  await app.settle();
  assert.equal(app.spoken.length, 0);
});

test('sends text KeepAlive during silence and stops it with the stream', () => {
  const app = harness();
  const sent = [];
  const socket = { readyState: 1, send: (message) => sent.push(message) };
  app.context.startKeepAlive(socket);
  app.advance(4000);
  assert.deepEqual(sent, ['{"type":"KeepAlive"}']);
  app.context.stopKeepAlive(socket);
  app.advance(8000);
  assert.equal(sent.length, 1);
});

test('starts a PCM capture and sends 40 ms worklet frames to Deepgram', async () => {
  const app = harness();
  await app.settle();
  let socket, worklet, audioContext;
  const graphNode = () => ({ connect: () => {}, disconnect: () => {} });
  class FakeAudioContext {
    constructor() {
      audioContext = this;
      this.audioWorklet = { addModule: async (url) => assert.equal(url, '/pcm-worklet.js') };
      this.destination = graphNode();
    }
    createMediaStreamSource() { return graphNode(); }
    createBiquadFilter() { return { ...graphNode(), frequency: { value: 0 }, Q: { value: 0 } }; }
    createGain() { return { ...graphNode(), gain: { value: 0 } }; }
    async resume() {}
    async close() { this.closed = true; }
  }
  class FakeAudioWorkletNode {
    constructor(_, name) {
      assert.equal(name, 'pcm16k');
      worklet = this;
      this.port = { onmessage: null, close: () => {} };
    }
    connect() {}
    disconnect() {}
  }
  class FakeWebSocket {
    static OPEN = 1;
    constructor(url) {
      socket = this;
      this.url = url;
      this.readyState = 1;
      this.sent = [];
      queueMicrotask(() => this.onopen());
    }
    send(data) { this.sent.push(data); }
  }
  const track = { addEventListener: () => {}, stop: () => {} };
  app.context.AudioContext = FakeAudioContext;
  app.context.AudioWorkletNode = FakeAudioWorkletNode;
  app.context.WebSocket = FakeWebSocket;
  app.context.MediaStream = class { constructor(tracks) { assert.equal(tracks[0], track); } };
  app.context.URLSearchParams = URLSearchParams;
  app.context.navigator = { mediaDevices: { getDisplayMedia: () => Promise.resolve({
    getAudioTracks: () => [track], getTracks: () => [track],
  }) } };
  const oldFetch = app.context.fetch;
  app.context.fetch = (url, options) => url === '/api/token' ?
    Promise.resolve({ json: async () => ({ access_token: 'test-token' }) }) : oldFetch(url, options);
  await app.elements.start.onclick();
  assert.match(socket.url, /encoding=linear16/);
  assert.match(socket.url, /sample_rate=16000/);
  assert.match(socket.url, /channels=1/);
  const frame = new ArrayBuffer(1280);
  worklet.port.onmessage({ data: frame });
  assert.equal(socket.sent[0], frame);
  app.advance(4000);
  assert.equal(socket.sent[1], '{"type":"KeepAlive"}');
  app.context.stop();
  await app.settle();
  assert.equal(audioContext.closed, true);
});
