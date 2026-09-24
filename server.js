// Минимальный сервер: раздаёт страницу, выпускает временные токены Deepgram
// и (опционально) переводит текст через Gemini или OpenAI-совместимый API.
// Запуск: node --env-file=.env server.js
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { TOKEN_PROTOCOL, createAuthorizer, parseTokens, tokenFromAuthorization, tokenFromProtocols } from './access.js';

const PORT = Number(process.env.PORT || 3000);
// 127.0.0.1 на VPS за обратным прокси; по умолчанию — все интерфейсы, как раньше.
const HOST = process.env.HOST?.trim() || undefined;
const DG_KEY = process.env.DEEPGRAM_API_KEY;
const YANDEX_TTS_KEY = process.env.YANDEX_SPEECHKIT_API_KEY?.trim();
const YANDEX_TRANSLATE_KEY = (process.env.YANDEX_TRANSLATE_API_KEY || process.env.YANDEX_SPEECHKIT_API_KEY)?.trim();
const YANDEX_STT_KEY = (process.env.YANDEX_STT_API_KEY || process.env.YANDEX_SPEECHKIT_API_KEY)?.trim();
// Токены доступа (access.js). Если заданы — или LIVEDUB_REQUIRE_TOKEN=1 на продакшне, —
// без токена не работают ни распознавание, ни остальные /api/: иначе любой, кто
// достучится до сервера, будет пользоваться вашими ключами.
const access = createAuthorizer(parseTokens(process.env.LIVEDUB_STT_TOKENS?.trim(), process.env.LIVEDUB_STT_TOKEN?.trim()),
  { required: process.env.LIVEDUB_REQUIRE_TOKEN === '1' });
const clientAddress = (req) => req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
const YANDEX_TRANSLATE_TIMEOUT_MS = Number(process.env.YANDEX_TRANSLATE_TIMEOUT_MS || 5_000);
if (!Number.isInteger(YANDEX_TRANSLATE_TIMEOUT_MS) || YANDEX_TRANSLATE_TIMEOUT_MS < 1) {
  throw new Error('YANDEX_TRANSLATE_TIMEOUT_MS должен быть положительным целым числом');
}
const YANDEX_TTS_VOICES = new Set(['marina', 'alena', 'jane', 'filipp', 'ermil', 'zahar']);
const LLM_KEY = process.env.LLM_API_KEY;                       // опционально
const LLM_BASE = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-5-mini';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY?.trim();
const DEEPSEEK_BASE = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
const DEEPSEEK_TIMEOUT_MS = Number(process.env.DEEPSEEK_TIMEOUT_MS || 10_000);
if (!Number.isInteger(DEEPSEEK_TIMEOUT_MS) || DEEPSEEK_TIMEOUT_MS < 1) {
  throw new Error('DEEPSEEK_TIMEOUT_MS должен быть положительным целым числом');
}
const GEMINI_ENABLED = Boolean(process.env.GEMINI_API_KEYS?.trim() || process.env.GEMINI_API_KEY?.trim());
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const GEMINI_PYTHON = process.env.GEMINI_PYTHON || fileURLToPath(new URL('./.venv/bin/python', import.meta.url));
const GEMINI_DRAFT_RPM = Number(process.env.GEMINI_DRAFT_RPM || Math.max(1, Math.min(6, Math.floor(Number(process.env.GEMINI_RPM || 15) * 0.4))));
if (!Number.isInteger(GEMINI_DRAFT_RPM) || GEMINI_DRAFT_RPM < 1) {
  throw new Error('GEMINI_DRAFT_RPM должен быть положительным целым числом');
}

let geminiWorker;
let geminiBuffer = '';
let geminiNextId = 0;
const geminiPending = new Map();
const geminiSamples = [];
const deepseekSamples = [];
const yandexTranslateSamples = [];
const ttsSamples = [];
const deepseekPending = new Map();
let deepseekNextId = 0;
const draftTimestamps = [];
let skippedDrafts = 0;

function allowGeminiDraft() {
  const now = Date.now();
  while (draftTimestamps.length && draftTimestamps[0] <= now - 60_000) draftTimestamps.shift();
  if (draftTimestamps.length >= GEMINI_DRAFT_RPM) {
    skippedDrafts++;
    return false;
  }
  draftTimestamps.push(now);
  return true;
}

function recordGemini(pending, message) {
  geminiSamples.push({
    at: new Date().toISOString(), kind: pending.kind, ok: !message.error,
    durationMs: Date.now() - pending.startedAt,
    queueMs: message.queueMs ?? null, gatewayMs: message.gatewayMs ?? null,
    model: message.model ?? null, keyLabel: message.keyLabel ?? null,
    errorType: message.errorType ?? null,
  });
  if (geminiSamples.length > 50) geminiSamples.shift();
}

function summarizeSamples(samples) {
  const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
  const percentile = (p) => durations.length ? durations[Math.ceil(durations.length * p) - 1] : null;
  return {
    count: samples.length,
    errors: samples.filter((sample) => !sample.ok).length,
    slow: samples.filter((sample) => sample.durationMs >= 5000).length,
    p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: durations.at(-1) ?? null,
  };
}

function geminiStats() {
  const pending = [...geminiPending.values()];
  return {
    window: 50, pending: pending.length,
    skippedDrafts,
    oldestPendingMs: pending.length ? Date.now() - Math.min(...pending.map((item) => item.startedAt)) : null,
    all: summarizeSamples(geminiSamples),
    draft: summarizeSamples(geminiSamples.filter((sample) => sample.kind === 'draft')),
    final: summarizeSamples(geminiSamples.filter((sample) => sample.kind === 'final')),
    recent: geminiSamples.slice(-10).reverse(),
  };
}

function deepseekStats() {
  const pending = [...deepseekPending.values()];
  return {
    window: 50, pending: pending.length,
    oldestPendingMs: pending.length ? Date.now() - Math.min(...pending) : null,
    all: summarizeSamples(deepseekSamples),
    draft: summarizeSamples(deepseekSamples.filter((sample) => sample.kind === 'draft')),
    final: summarizeSamples(deepseekSamples.filter((sample) => sample.kind === 'final')),
    recent: deepseekSamples.slice(-10).reverse(),
  };
}

function yandexTranslateStats() {
  return {
    window: 50,
    all: summarizeSamples(yandexTranslateSamples),
    draft: summarizeSamples(yandexTranslateSamples.filter((sample) => sample.kind === 'draft')),
    final: summarizeSamples(yandexTranslateSamples.filter((sample) => sample.kind === 'final')),
    recent: yandexTranslateSamples.slice(-10).reverse(),
  };
}

function recordTts(sample) {
  const entry = { at: new Date().toISOString(), ...sample };
  ttsSamples.push(entry);
  if (ttsSamples.length > 100) ttsSamples.shift();
  console.info('[tts]', JSON.stringify(entry));
}

function ttsStats() {
  const requests = ttsSamples.filter((sample) => sample.source === 'server' && sample.event === 'complete');
  const firstBytes = requests.map((sample) => sample.firstByteMs).filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = (values, p) => values.length ? values[Math.ceil(values.length * p) - 1] : null;
  return {
    window: 100,
    completed: requests.length,
    firstByteP50Ms: percentile(firstBytes, .5),
    firstByteP95Ms: percentile(firstBytes, .95),
    events: Object.fromEntries([...new Set(ttsSamples.map((sample) => sample.event))]
      .map((event) => [event, ttsSamples.filter((sample) => sample.event === event).length])),
    recent: ttsSamples.slice(-30).reverse(),
  };
}

function failGeminiPending(error) {
  for (const pending of geminiPending.values()) {
    clearTimeout(pending.timer);
    recordGemini(pending, { error: true, errorType: 'WorkerUnavailable' });
    pending.reject(error);
  }
  geminiPending.clear();
}

function startGeminiWorker() {
  if (geminiWorker) return geminiWorker;
  const child = spawn(GEMINI_PYTHON, [fileURLToPath(new URL('./gemini_worker.py', import.meta.url))], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  geminiWorker = child;
  geminiBuffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    geminiBuffer += chunk;
    let newline;
    while ((newline = geminiBuffer.indexOf('\n')) !== -1) {
      const line = geminiBuffer.slice(0, newline);
      geminiBuffer = geminiBuffer.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        const pending = geminiPending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        geminiPending.delete(message.id);
        recordGemini(pending, message);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.translation);
      } catch (error) {
        console.error('Некорректный ответ Gemini worker:', error);
      }
    }
  });
  const failed = (error) => {
    if (geminiWorker !== child) return;
    geminiWorker = null;
    failGeminiPending(new Error(`Gemini worker недоступен: ${error.message || error}`));
  };
  child.on('error', failed);
  child.on('exit', (code) => failed(new Error(`завершился с кодом ${code}`)));
  return child;
}

function translateGemini(prompt, kind) {
  return new Promise((resolve, reject) => {
    const child = startGeminiWorker();
    const id = ++geminiNextId;
    const pending = { resolve, reject, kind, startedAt: Date.now(), timer: null };
    const timer = setTimeout(() => {
      if (!geminiPending.has(id)) return;
      geminiPending.delete(id);
      recordGemini(pending, { error: true, errorType: 'Timeout' });
      reject(new Error('Таймаут перевода Gemini'));
    }, 180_000);
    pending.timer = timer;
    geminiPending.set(id, pending);
    child.stdin.write(JSON.stringify({ id, prompt }) + '\n', (error) => {
      if (error && geminiPending.has(id)) {
        clearTimeout(timer);
        geminiPending.delete(id);
        recordGemini(pending, { error: true, errorType: 'WorkerWriteError' });
        reject(new Error('Не удалось отправить запрос Gemini worker'));
      }
    });
  });
}

// Без Deepgram не работает только веб-страница; распознавание SpeechKit для расширения
// (например, на VPS) Deepgram не нужно.
if (!DG_KEY) console.warn('Нет DEEPGRAM_API_KEY: веб-страница не сможет распознавать речь, SpeechKit для расширения работает');

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

const readBody = async (req) => {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 64_000) throw new Error('body too large');
  }
  return data ? JSON.parse(data) : {};
};

// Короткоживущий JWT для прямого WebSocket браузер → Deepgram.
// Токен нужен только на момент открытия сокета; ключ не попадает в браузер.
async function grantDeepgramToken() {
  if (!DG_KEY) throw new Error('DEEPGRAM_API_KEY не задан на сервере');
  const r = await fetch('https://api.deepgram.com/v1/auth/grant', {
    method: 'POST',
    headers: { Authorization: `Token ${DG_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ttl_seconds: 30 }),
  });
  if (r.status === 403) {
    throw new Error('Ключ Deepgram не может выдавать временные токены: создайте API key с правами Member или выше');
  }
  if (!r.ok) throw new Error(`Deepgram grant ${r.status}: ${await r.text()}`);
  return r.json(); // { access_token, expires_in }
}

// Перевод через LLM: берём пару предыдущих реплик как контекст, чтобы
// местоимения и термины переводились согласованно.
function translationPrompt({ text, context = [], source, target }) {
  const system =
    `Ты синхронный переводчик. Переведи последнюю реплику с языка "${source}" на "${target}". ` +
    `Верни только перевод, без пояснений и кавычек. Сохраняй разговорный стиль.`;
  const ctx = context.slice(-3).map((t, i) => `[${i + 1}] ${t}`).join('\n');
  const user = (ctx ? `Предыдущие реплики (для контекста, не переводить):\n${ctx}\n\n` : '') +
    `Реплика для перевода:\n${text}`;
  return { system, user };
}

async function translateLLM(input) {
  const { system, user } = translationPrompt(input);
  const body = {
    model: LLM_MODEL,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_completion_tokens: 400,
  };
  // reasoning-модели (gpt-5*, o*) без этого думают секунды — для лайва недопустимо
  if (/^(gpt-5|o\d)/.test(LLM_MODEL)) body.reasoning_effort = 'minimal';

  const r = await fetch(`${LLM_BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${LLM_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`LLM ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data.choices?.[0]?.message?.content?.trim() ?? '';
}

async function translateDeepSeek(input, kind) {
  const { system, user } = translationPrompt(input);
  const startedAt = Date.now();
  const id = ++deepseekNextId;
  deepseekPending.set(id, startedAt);
  let status = null;
  let errorType = null;
  let servedModel = null;
  try {
    const response = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DEEPSEEK_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        thinking: { type: 'disabled' },
        max_tokens: 256,
        stream: false,
      }),
      signal: AbortSignal.timeout(DEEPSEEK_TIMEOUT_MS),
    });
    status = response.status;
    if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}`);
    const data = await response.json();
    servedModel = typeof data.model === 'string' ? data.model : null;
    const translation = data.choices?.[0]?.message?.content?.trim();
    if (!translation) throw new Error('DeepSeek вернул пустой перевод');
    return translation;
  } catch (error) {
    errorType = error.name === 'TimeoutError' ? 'Timeout' :
      status === 200 ? 'InvalidResponse' : status ? `HTTP${status}` : 'NetworkError';
    if (errorType === 'Timeout') throw new Error(`Таймаут DeepSeek (${DEEPSEEK_TIMEOUT_MS} мс)`);
    if (status && status !== 200) throw new Error(`DeepSeek HTTP ${status}`);
    if (errorType === 'InvalidResponse') throw new Error('DeepSeek вернул пустой или некорректный ответ');
    throw new Error('DeepSeek недоступен');
  } finally {
    deepseekPending.delete(id);
    deepseekSamples.push({
      at: new Date().toISOString(), kind, ok: errorType === null,
      durationMs: Date.now() - startedAt, model: servedModel ?? DEEPSEEK_MODEL, errorType,
    });
    if (deepseekSamples.length > 50) deepseekSamples.shift();
  }
}

async function translateYandex({ text, source, target }, kind) {
  const startedAt = Date.now();
  let status = null;
  let errorType = null;
  try {
    const response = await fetch('https://translate.api.cloud.yandex.net/translate/v2/translate', {
      method: 'POST',
      headers: { Authorization: `Api-Key ${YANDEX_TRANSLATE_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sourceLanguageCode: source, targetLanguageCode: target,
        format: 'PLAIN_TEXT', texts: [text] }),
      signal: AbortSignal.timeout(YANDEX_TRANSLATE_TIMEOUT_MS),
    });
    status = response.status;
    if (!response.ok) throw new Error(`Yandex Translate HTTP ${status}`);
    const data = await response.json();
    const translation = data.translations?.[0]?.text?.trim();
    if (!translation) throw new Error('Yandex Translate вернул пустой перевод');
    return translation;
  } catch (error) {
    errorType = error.name === 'TimeoutError' ? 'Timeout' :
      status === 200 ? 'InvalidResponse' : status ? `HTTP${status}` : 'NetworkError';
    if (errorType === 'Timeout') throw new Error(`Таймаут Yandex Translate (${YANDEX_TRANSLATE_TIMEOUT_MS} мс)`);
    if (status && status !== 200) throw new Error(`Yandex Translate HTTP ${status}`);
    if (errorType === 'InvalidResponse') throw new Error('Yandex Translate вернул пустой или некорректный ответ');
    throw new Error('Yandex Translate недоступен');
  } finally {
    yandexTranslateSamples.push({ at: new Date().toISOString(), kind, ok: errorType === null,
      durationMs: Date.now() - startedAt, errorType });
    if (yandexTranslateSamples.length > 50) yandexTranslateSamples.shift();
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('ok');
    }
    if (req.url.startsWith('/api/') && access.enabled && !access.check(tokenFromAuthorization(req.headers.authorization))) {
      return json(res, 401, { error: 'unauthorized' });
    }
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      const html = await readFile(new URL('./public/index.html', import.meta.url));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (req.method === 'GET' && req.url === '/pcm-worklet.js') {
      const script = await readFile(new URL('./public/pcm-worklet.js', import.meta.url));
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      return res.end(script);
    }
    if (req.method === 'GET' && req.url === '/api/config') {
      return json(res, 200, {
        llm: Boolean(LLM_KEY), llmModel: LLM_KEY ? LLM_MODEL : null,
        yandexTts: Boolean(YANDEX_TTS_KEY),
        yandexTranslate: Boolean(YANDEX_TRANSLATE_KEY),
        yandexStt: Boolean(YANDEX_STT_KEY),
        gemini: GEMINI_ENABLED, geminiModel: GEMINI_ENABLED ? GEMINI_MODEL : null,
        deepseek: Boolean(DEEPSEEK_KEY), deepseekModel: DEEPSEEK_KEY ? DEEPSEEK_MODEL : null,
        geminiDraftIntervalMs: Math.ceil(60_000 / GEMINI_DRAFT_RPM),
      });
    }
    if (req.method === 'GET' && req.url === '/api/stats') {
      return json(res, 200, { gemini: geminiStats(), deepseek: deepseekStats(),
        yandexTranslate: yandexTranslateStats(), tts: ttsStats() });
    }
    if (req.method === 'POST' && req.url === '/api/tts-event') {
      const event = await readBody(req);
      const allowed = new Set(['queued', 'start', 'done', 'cancel', 'drop_backlog', 'drop_prefix', 'rewrite', 'error']);
      if (!allowed.has(event.event) || !['browser', 'yandex'].includes(event.provider)) {
        return json(res, 400, { error: 'invalid tts event' });
      }
      const number = (value) => Number.isFinite(value) ? Math.max(0, Math.min(Math.round(value), 120_000)) : null;
      recordTts({ source: 'browser', event: event.event, provider: event.provider,
        mode: typeof event.mode === 'string' ? event.mode.slice(0, 32) : null,
        target: typeof event.target === 'string' ? event.target.slice(0, 8) : null,
        phrase: number(event.phrase), waitMs: number(event.waitMs), playMs: number(event.playMs),
        backlogMs: number(event.backlogMs), queue: number(event.queue), reason: typeof event.reason === 'string' ? event.reason.slice(0, 40) : null });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/api/token') {
      return json(res, 200, await grantDeepgramToken());
    }
    if (req.method === 'POST' && req.url === '/api/tts') {
      if (!YANDEX_TTS_KEY) return json(res, 400, { error: 'YANDEX_SPEECHKIT_API_KEY не задан' });
      const { text, voice = 'marina' } = await readBody(req);
      if (typeof text !== 'string' || !text.trim() || text.length > 250 || !YANDEX_TTS_VOICES.has(voice)) {
        return json(res, 400, { error: 'Некорректный текст или голос для озвучки' });
      }
      const body = new URLSearchParams({ text: text.trim(), lang: 'ru-RU', voice, format: 'mp3' });
      const startedAt = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12_000);
      let finished = false;
      res.on('close', () => {
        controller.abort();
        clearTimeout(timeout);
        if (!finished) {
          finished = true;
          recordTts({ source: 'server', event: 'cancel', voice, chars: text.length, durationMs: Date.now() - startedAt });
        }
      });
      let response;
      try {
        response = await fetch('https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize', {
          method: 'POST',
          headers: { Authorization: `Api-Key ${YANDEX_TTS_KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
          body,
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timeout);
        finished = true;
        if (!res.destroyed) recordTts({ source: 'server', event: 'error', voice, chars: text.length,
          durationMs: Date.now() - startedAt, reason: error.name === 'AbortError' ? 'timeout' : 'network' });
        throw error;
      }
      if (!response.ok) {
        clearTimeout(timeout);
        finished = true;
        recordTts({ source: 'server', event: 'error', voice, chars: text.length,
          durationMs: Date.now() - startedAt, reason: `http_${response.status}` });
        const detail = (await response.text()).slice(0, 300);
        return json(res, 502, { error: `SpeechKit ${response.status}: ${detail}` });
      }
      if (!response.body) {
        finished = true;
        clearTimeout(timeout);
        recordTts({ source: 'server', event: 'error', voice, chars: text.length,
          durationMs: Date.now() - startedAt, reason: 'empty_audio' });
        return json(res, 502, { error: 'SpeechKit вернул пустой звук' });
      }
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' });
      const upstream = Readable.fromWeb(response.body);
      let firstByteMs = null, bytes = 0;
      upstream.on('data', (chunk) => { if (firstByteMs === null) firstByteMs = Date.now() - startedAt; bytes += chunk.length; });
      upstream.on('error', (error) => {
        clearTimeout(timeout);
        if (!finished) {
          finished = true;
          recordTts({ source: 'server', event: 'error', voice, chars: text.length,
            durationMs: Date.now() - startedAt, reason: error.name === 'AbortError' ? 'timeout' : 'stream' });
        }
        res.destroy(error);
      });
      upstream.on('end', () => {
        clearTimeout(timeout);
        if (!finished) {
          finished = true;
          recordTts({ source: 'server', event: 'complete', voice, chars: text.length,
            firstByteMs, durationMs: Date.now() - startedAt, bytes });
        }
      });
      upstream.pipe(res);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/translate') {
      const { text, context = [], source, target, provider = 'llm', kind = 'final' } = await readBody(req);
      if (typeof text !== 'string' || !text.trim()) return json(res, 400, { error: 'empty text' });
      if (!Array.isArray(context) || !context.every((item) => typeof item === 'string') ||
          typeof source !== 'string' || typeof target !== 'string') {
        return json(res, 400, { error: 'invalid translation request' });
      }
      if (provider === 'gemini') {
        if (!GEMINI_ENABLED) return json(res, 400, { error: 'GEMINI_API_KEYS не заданы' });
        if (kind !== 'draft' && kind !== 'final') return json(res, 400, { error: 'invalid translation kind' });
        if (kind === 'draft' && !allowGeminiDraft()) {
          return json(res, 429, { error: 'Лимит черновых Gemini-запросов; финальный перевод продолжает работать' });
        }
        const { system, user } = translationPrompt({ text, context, source, target });
        return json(res, 200, { translation: await translateGemini(`${system}\n\n${user}`, kind) });
      }
      if (provider === 'deepseek') {
        if (!DEEPSEEK_KEY) return json(res, 400, { error: 'DEEPSEEK_API_KEY не задан' });
        if (kind !== 'draft' && kind !== 'final') return json(res, 400, { error: 'invalid translation kind' });
        return json(res, 200, { translation: await translateDeepSeek({ text, context, source, target }, kind) });
      }
      if (provider === 'yandex') {
        if (!YANDEX_TRANSLATE_KEY) return json(res, 400, { error: 'YANDEX_TRANSLATE_API_KEY не задан' });
        if (kind !== 'draft' && kind !== 'final') return json(res, 400, { error: 'invalid translation kind' });
        if (!/^[a-z]{2,3}$/.test(source) || !/^[a-z]{2,3}$/.test(target) || text.length > 10_000) {
          return json(res, 400, { error: 'invalid translation languages or text length' });
        }
        return json(res, 200, { translation: await translateYandex({ text, source, target }, kind) });
      }
      if (provider !== 'llm') return json(res, 400, { error: 'unknown provider' });
      if (!LLM_KEY) return json(res, 400, { error: 'LLM_API_KEY не задан' });
      return json(res, 200, { translation: await translateLLM({ text, context, source, target }) });
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: String(e.message || e) });
  }
});

// Потоковое распознавание SpeechKit для расширения: WebSocket ⇄ gRPC.
// Зависимости (ws, @grpc/*) грузятся только при первом подключении, поэтому
// остальному серверу `npm install` по-прежнему не нужен.
let sttSockets = null;
async function acceptYandexStt(req, socket, head, url) {
  const reject = (status, text) => { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`); };
  const client = access.check(tokenFromProtocols(req.headers['sec-websocket-protocol']));
  if (access.enabled && !client) {
    console.warn(`[stt] отклонено подключение без верного токена: ${clientAddress(req)}`);
    return reject(401, 'Unauthorized');
  }
  if (!YANDEX_STT_KEY) return reject(503, 'YANDEX_SPEECHKIT_API_KEY not set');
  const [{ YANDEX_STT_LANGUAGES, attachSocket }, { WebSocketServer }] = await Promise.all([import('./yandex-stt.js'), import('ws')]);
  const language = YANDEX_STT_LANGUAGES[url.searchParams.get('language')];
  const pauseMs = Number(url.searchParams.get('endpointing') || 300);
  if (!language || !(pauseMs >= 100 && pauseMs <= 3000)) return reject(400, 'Bad Request');
  // Браузер ждёт, что сервер подтвердит протокол, в котором пришёл токен.
  sttSockets ??= new WebSocketServer({ noServer: true, handleProtocols: (protocols) => protocols.has(TOKEN_PROTOCOL) && TOKEN_PROTOCOL });
  sttSockets.handleUpgrade(req, socket, head, (ws) => {
    const started = Date.now();
    console.log(`[stt] подключение: ${client ?? 'без токена'} (${clientAddress(req)})`);
    ws.on('close', () => console.log(`[stt] отключение: ${client ?? 'без токена'}, ${Math.round((Date.now() - started) / 1000)} с`));
    attachSocket(ws, { apiKey: YANDEX_STT_KEY, language, pauseMs });
  });
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/api/stt/yandex') return socket.destroy();
  acceptYandexStt(req, socket, head, url).catch((error) => {
    console.error('[stt]', error.message);
    socket.destroy();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Открой http://localhost:${PORT} в Chrome/Edge`);
  console.log(`LLM-перевод: ${LLM_KEY ? `включён (${LLM_MODEL} @ ${LLM_BASE})` : 'выключен — только встроенный переводчик Chrome'}`);
  console.log(`Gemini-перевод: ${GEMINI_ENABLED ? `включён (${GEMINI_MODEL})` : 'выключен'}`);
  console.log(`DeepSeek-перевод: ${DEEPSEEK_KEY ? `включён (${DEEPSEEK_MODEL})` : 'выключен'}`);
  console.log(`Распознавание SpeechKit для расширения: ${YANDEX_STT_KEY ? `ws://localhost:${PORT}/api/stt/yandex` : 'выключено'}`);
  console.log(`Доступ к /api/: ${access.enabled ? 'только с токеном' : 'без токена'}`);
});

process.on('exit', () => geminiWorker?.kill());
