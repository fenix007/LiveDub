import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  checkDeepSeek, checkYandex, deepgramUrl, synthesizeYandex, translateDeepSeek, translateYandex, translationPrompt,
} from '../extension/lib/providers.js';
import { stableWords } from '../extension/lib/text.js';

const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function recorder(respond) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    return respond(url, init, calls.length);
  };
  return { calls, fetchImpl };
}

test('manifest grants only the API hosts the extension calls', () => {
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.host_permissions.sort(), [
    'https://api.deepgram.com/*', 'https://api.deepseek.com/*',
    'https://translate.api.cloud.yandex.net/*', 'https://tts.api.cloud.yandex.net/*',
  ]);
  assert.ok(manifest.permissions.includes('tabCapture'));
});

test('Deepgram URL streams 16 kHz PCM with interim results', () => {
  const url = new URL(deepgramUrl('ru'));
  assert.equal(url.origin + url.pathname, 'wss://api.deepgram.com/v1/listen');
  assert.equal(url.searchParams.get('language'), 'ru');
  assert.equal(url.searchParams.get('sample_rate'), '16000');
  assert.equal(url.searchParams.get('interim_results'), 'true');
});

test('Deepgram endpointing follows the chosen pause and defaults to 300 ms', () => {
  assert.equal(new URL(deepgramUrl('en')).searchParams.get('endpointing'), '300');
  assert.equal(new URL(deepgramUrl('en', { endpointing: 150 })).searchParams.get('endpointing'), '150');
  assert.equal(new URL(deepgramUrl('en', { endpointing: 800 })).searchParams.get('utterance_end_ms'), '1000');
});

test('DeepSeek request disables thinking and sends context in the prompt', async () => {
  const { calls, fetchImpl } = recorder(() => jsonResponse(200, { choices: [{ message: { content: ' Привет ' } }] }));
  const result = await translateDeepSeek({ key: 'k', model: 'deepseek-flash', fetchImpl },
    { text: 'Hello', context: ['a', 'b', 'c', 'd'], source: 'en', target: 'ru' });
  assert.equal(result, 'Привет');
  assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.model, 'deepseek-flash');
  assert.match(body.messages[1].content, /\[1\] b\n\[2\] c\n\[3\] d/);
});

test('DeepSeek errors do not leak the key', async () => {
  const { fetchImpl } = recorder(() => jsonResponse(401, { error: 'bad' }));
  await assert.rejects(translateDeepSeek({ key: 'secret-key', model: 'm', fetchImpl }, { text: 'x', source: 'en', target: 'ru' }),
    (error) => error.message === 'DeepSeek HTTP 401' && !error.message.includes('secret-key'));
  const timeout = async (url, init) => new Promise((resolve, reject) =>
    init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  // Таймер AbortSignal.timeout не держит процесс: без обычного таймера Node 22
  // завершает цикл событий раньше таймаута и отменяет оставшиеся тесты.
  const keepAlive = setTimeout(() => {}, 1000);
  await assert.rejects(translateDeepSeek({ key: 'k', model: 'm', timeoutMs: 20, fetchImpl: timeout }, { text: 'x', source: 'en', target: 'ru' }),
    /Таймаут DeepSeek \(20 мс\)/);
  clearTimeout(keepAlive);
  await assert.rejects(translateDeepSeek({ key: '', model: 'm' }, { text: 'x' }), /Не задан ключ DeepSeek/);
});

test('Yandex Translate uses Api-Key auth and optional folderId', async () => {
  const { calls, fetchImpl } = recorder(() => jsonResponse(200, { translations: [{ text: 'Привет мир' }] }));
  assert.equal(await translateYandex({ key: 'yk', fetchImpl }, { text: 'Hello world', source: 'en', target: 'ru' }), 'Привет мир');
  assert.equal(calls[0].init.headers.Authorization, 'Api-Key yk');
  assert.deepEqual(JSON.parse(calls[0].init.body),
    { sourceLanguageCode: 'en', targetLanguageCode: 'ru', texts: ['Hello world'], format: 'PLAIN_TEXT' });
  await translateYandex({ key: 'yk', folderId: 'b1g', fetchImpl }, { text: 'x', source: 'en', target: 'ru' });
  assert.equal(JSON.parse(calls[1].init.body).folderId, 'b1g');
});

test('Yandex Translate surfaces the API message on errors', async () => {
  const { fetchImpl } = recorder(() => jsonResponse(403, { message: 'Permission denied' }));
  await assert.rejects(translateYandex({ key: 'yk', fetchImpl }, { text: 'x', source: 'en', target: 'ru' }),
    /Yandex Translate HTTP 403: Permission denied/);
});

test('SpeechKit synthesis posts form data with the chosen voice', async () => {
  const { calls, fetchImpl } = recorder(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
  const response = await synthesizeYandex({ key: 'yk', fetchImpl }, { text: ' Привет ', lang: 'ru-RU', voice: 'marina' });
  assert.equal(response.status, 200);
  assert.equal(calls[0].url, 'https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize');
  assert.equal(calls[0].init.headers.Authorization, 'Api-Key yk');
  assert.equal(calls[0].init.body.toString(), 'text=%D0%9F%D1%80%D0%B8%D0%B2%D0%B5%D1%82&lang=ru-RU&voice=marina&format=mp3');
});

test('key checks report per-service results', async () => {
  const deepseek = recorder(() => jsonResponse(200, { data: [{ id: 'deepseek-chat' }] }));
  assert.match(await checkDeepSeek('k', 'deepseek-flash', deepseek.fetchImpl), /модели «deepseek-flash» нет в списке/);
  const yandex = recorder((url) => url.includes('translate') ? jsonResponse(200, { translations: [{ text: 'Привет' }] }) : new Response('', { status: 403 }));
  assert.equal(await checkYandex('k', '', yandex.fetchImpl), 'Translate: работает · SpeechKit: у ключа нет нужных прав (403)');
});

test('translation prompt and stable words match the web prototype', () => {
  const { system, user } = translationPrompt({ text: 'Hi', context: [], source: 'en', target: 'ru' });
  assert.match(system, /с языка "en" на "ru"/);
  assert.equal(user, 'Реплика для перевода:\nHi');
  assert.equal(stableWords('Hello, world how', 'hello world are you'), 'hello world');
});

test('extension ships the same PCM worklet as the web prototype', () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  assert.equal(read('../extension/pcm-worklet.js'), read('../public/pcm-worklet.js'));
});

test('latency stats keep a sliding window per engine', async () => {
  const { createLatencyStats } = await import('../extension/lib/stats.js');
  const stats = createLatencyStats(3);
  stats.record('yandex', 'draft', 100, true);
  stats.record('yandex', 'final', 300, false);
  stats.record('yandex', 'final', 200, true);
  stats.record('yandex', 'final', 400, true);
  stats.record('deepseek', 'final', 900, true);
  const { all, final, draft } = stats.summary('yandex');
  assert.deepEqual(all, { count: 3, errors: 1, p50Ms: 300, p95Ms: 400 });
  assert.equal(final.count, 3);
  assert.equal(draft.count, 0);
  assert.equal(stats.summary('deepseek').all.p50Ms, 900);
});

test('speech alignment does not skip a new negation or changed number', async () => {
  const { resumeFinalSpeech, sameSpeechWord, commonSpeechWords } = await import('../extension/lib/text.js');
  assert.equal(resumeFinalSpeech(['Я', 'хочу', 'это'], ['Я', 'не', 'хочу', 'это']), 0);
  assert.equal(resumeFinalSpeech(['200', 'долларов', 'кредита'], ['300', 'долларов', 'кредита']), 0);
  assert.equal(sameSpeechWord('шестнадцать', 'шестьдесят'), false);
  assert.equal(sameSpeechWord('девятнадцать', 'девяносто'), false);
  assert.equal(sameSpeechWord('should', "shouldn't"), false);
  assert.equal(sameSpeechWord('ещё', 'еще'), true);
  assert.equal(resumeFinalSpeech(['это', 'важно', 'сказал', 'что'],
    ['это', 'совсем', 'другое', 'и', 'еще', 'раз', 'сказал', 'что']), 0);
  assert.equal(resumeFinalSpeech(['Я', 'думаю,', 'что', 'это', 'работает'],
    ['Мне', 'кажется,', 'что', 'это', 'работает', 'иначе']), 5);
  assert.deepEqual(commonSpeechWords(['Мы', 'уже', 'готовы', 'идти'], ['Мы', 'уже', 'готовы', 'идти', 'дальше']),
    ['Мы', 'уже', 'готовы', 'идти']);
});

function speechHarness() {
  const requests = [];
  const audios = [];
  globalThis.Audio = class {
    constructor() { audios.push(this); }
    play() { this.onplaying?.(); return Promise.resolve(); }
    pause() { this.paused = true; }
    finish() { this.onended?.(); }
  };
  const settings = { enabled: true, provider: 'yandex', voice: '', target: 'ru', yandexKey: 'k' };
  return import('../extension/lib/speech.js').then(({ createSpeech }) => {
    const speech = createSpeech({
      config: () => settings,
      isCurrent: () => true,
      synthesize: async ({ text }) => { requests.push(text); return new Response(new Uint8Array([1]), { status: 200 }); },
    });
    const phrase = () => ({ ttsWords: [], ttsCandidate: '', ttsCandidateFinal: false, ttsDropped: false, ttsPreviousDraft: null });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
    return { speech, phrase, requests, audios, settle, settings };
  });
}

test('SpeechKit voices confirmed draft words and continues an aligned final', async () => {
  const { speech, phrase, requests, audios, settle } = await speechHarness();
  const state = phrase();
  speech.speak(state, 'Мы уже готовы идти', false);
  await settle();
  assert.equal(requests.length, 0, 'первый черновик ещё не подтверждён');
  speech.speak(state, 'Мы уже готовы идти дальше', false);
  await settle();
  assert.deepEqual(requests, ['Мы уже готовы идти']);
  speech.speak(state, 'Мы уже готовы идти дальше вместе', true);
  audios[0].finish();
  await settle();
  assert.deepEqual(requests, ['Мы уже готовы идти', 'дальше вместе']);
  audios[1].finish();
  await settle();
  assert.equal(state.ttsDropped, false);
});

test('SpeechKit speaks the rewritten tail of a final and keeps queued finals', async () => {
  const { speech, phrase, requests, audios, settle } = await speechHarness();
  const first = phrase();
  speech.speak(first, 'Я думаю что это работает', false);
  speech.speak(first, 'Я думаю что это работает хорошо', false);
  await settle();
  speech.speak(first, 'Мне кажется что это работает иначе', true);
  const others = [phrase(), phrase(), phrase()];
  others.forEach((state, i) => speech.speak(state, `Финальная фраза номер ${i + 1}`, true));
  assert.equal(requests.length, 1, 'задания SpeechKit не перекрываются');
  for (let i = 0; i < 5; i++) {
    audios[i]?.finish();
    await settle();
  }
  assert.deepEqual(requests, ['Я думаю что это работает', 'иначе',
    'Финальная фраза номер 1', 'Финальная фраза номер 2', 'Финальная фраза номер 3']);
  assert.ok([first, ...others].every((state) => !state.ttsDropped));
});

test('SpeechKit releases a job invalidated before synthesis finished', async () => {
  const { speech, phrase, requests, audios, settle, settings } = await speechHarness();
  speech.speak(phrase(), 'Первая финальная фраза', true);
  settings.enabled = false; // выключили без cancel(), как при смене состояния снаружи
  await settle();
  settings.enabled = true;
  speech.speak(phrase(), 'Вторая финальная фраза', true);
  await settle();
  assert.deepEqual(requests, ['Первая финальная фраза', 'Вторая финальная фраза']);
  audios.at(-1).finish();
  await settle();
});

test('stage timing compares the sent audio with Deepgram cursors', async () => {
  const { createAudioClock, lagMs, lastWordEnd, transcriptCursor } = await import('../extension/lib/timing.js');
  const clock = createAudioClock();
  for (let i = 0; i < 50; i++) clock.add(1280); // 50 кадров по 40 мс
  assert.equal(clock.seconds(), 2);

  const msg = { start: 0.5, duration: 1.1, channel: { alternatives: [{ words: [{ end: 0.9 }, { end: 1.3 }] }] } };
  assert.equal(transcriptCursor(msg), 1.6);
  assert.equal(lastWordEnd(msg), 1.3);
  assert.equal(lastWordEnd({ start: 1, duration: 0.5 }), 1.5);
  assert.equal(Math.round(lagMs(clock.seconds(), transcriptCursor(msg))), 400);
  assert.equal(lagMs(1, 1.2), 0); // курсор расшифровки не может обогнать звук
});

test('finished sentences split off a committed transcript, abbreviations do not', async () => {
  const { splitAtSentence } = await import('../extension/lib/text.js');
  assert.deepEqual(splitAtSentence('A lot has changed. Talk about the momentum numbers. Yeah. Always'),
    { done: 'A lot has changed. Talk about the momentum numbers. Yeah.', rest: 'Always' });
  assert.equal(splitAtSentence('no sentence end here yet'), null);
  assert.equal(splitAtSentence('Ends with a period.'), null); // закрывается целиком, без хвоста
  assert.equal(splitAtSentence('Hi. Four'), null);             // меньше трёх слов
  assert.equal(splitAtSentence('I met Mr. Smith and Dr. Brown today and'), null);
  assert.deepEqual(splitAtSentence('Is this ok for you? "Yes." And then'), { done: 'Is this ok for you? "Yes."', rest: 'And then' });
});
