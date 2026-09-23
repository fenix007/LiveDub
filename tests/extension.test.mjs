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
  await assert.rejects(translateDeepSeek({ key: 'k', model: 'm', timeoutMs: 20, fetchImpl: timeout }, { text: 'x', source: 'en', target: 'ru' }),
    /Таймаут DeepSeek \(20 мс\)/);
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
