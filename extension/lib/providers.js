// Прямые запросы к API из страницы расширения. CORS не мешает благодаря
// host_permissions в manifest.json. Тексты ошибок не содержат ключей.
export const DEEPSEEK_BASE = 'https://api.deepseek.com';
export const YANDEX_TRANSLATE_URL = 'https://translate.api.cloud.yandex.net/translate/v2/translate';
export const YANDEX_TTS_URL = 'https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize';

export const ENDPOINTING_CHOICES = [150, 300, 500, 800];

export function deepgramUrl(language, { endpointing = 300 } = {}) {
  const params = new URLSearchParams({
    model: 'nova-3', language,
    encoding: 'linear16', sample_rate: '16000', channels: '1',
    smart_format: 'true', interim_results: 'true',
    endpointing: String(endpointing), // мс тишины до speech_final
    utterance_end_ms: '1000',    // страховка: по таймингам слов, устойчиво к шуму
    vad_events: 'true',
  });
  return `wss://api.deepgram.com/v1/listen?${params}`;
}

// Браузер не даёт ставить заголовки на WebSocket, поэтому ключ передаётся в Sec-WebSocket-Protocol.
export const openDeepgram = (key, language, options) => new WebSocket(deepgramUrl(language, options), ['token', key]);

// Yandex SpeechKit принимает поток только по gRPC, поэтому звук идёт через сервер
// LiveDub (server.js). Сервер отвечает сообщениями в формате Deepgram.
export function yandexSttUrl(serverUrl, language, { endpointing = 300 } = {}) {
  const url = new URL('/api/stt/yandex', serverUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = new URLSearchParams({ language, endpointing: String(endpointing) });
  return url.href;
}

// Токен идёт в Sec-WebSocket-Protocol, а не в адресе: адреса попадают в логи прокси.
// Протокол допускает только символы токена HTTP — так же проверяет сервер (access.js).
export const SERVER_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{32,256}$/;
export const serverProtocols = (token) => (token ? ['livedub', token] : undefined);

export const openYandexStt = (serverUrl, language, { token, ...options } = {}) =>
  new WebSocket(yandexSttUrl(serverUrl, language, options), serverProtocols(token));

// Перевод через LLM: пара предыдущих реплик как контекст, чтобы
// местоимения и термины переводились согласованно.
export function translationPrompt({ text, context = [], source, target }) {
  const system =
    `Ты синхронный переводчик. Переведи последнюю реплику с языка "${source}" на "${target}". ` +
    `Верни только перевод, без пояснений и кавычек. Сохраняй разговорный стиль.`;
  const ctx = context.slice(-3).map((t, i) => `[${i + 1}] ${t}`).join('\n');
  const user = (ctx ? `Предыдущие реплики (для контекста, не переводить):\n${ctx}\n\n` : '') +
    `Реплика для перевода:\n${text}`;
  return { system, user };
}

export async function translateDeepSeek({ key, model, timeoutMs = 10_000, base = DEEPSEEK_BASE, fetchImpl = fetch }, input) {
  if (!key) throw new Error('Не задан ключ DeepSeek');
  const { system, user } = translationPrompt(input);
  let response;
  try {
    response = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        thinking: { type: 'disabled' },
        max_tokens: 256,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error.name === 'TimeoutError') throw new Error(`Таймаут DeepSeek (${timeoutMs} мс)`);
    throw new Error('DeepSeek недоступен');
  }
  if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}`);
  const data = await response.json().catch(() => null);
  const translation = data?.choices?.[0]?.message?.content?.trim();
  if (!translation) throw new Error('DeepSeek вернул пустой или некорректный ответ');
  return translation;
}

export async function translateYandex({ key, folderId, timeoutMs = 5_000, fetchImpl = fetch }, { text, source, target }) {
  if (!key) throw new Error('Не задан ключ Yandex');
  const body = { sourceLanguageCode: source, targetLanguageCode: target, texts: [text], format: 'PLAIN_TEXT' };
  if (folderId) body.folderId = folderId;
  let response;
  try {
    response = await fetchImpl(YANDEX_TRANSLATE_URL, {
      method: 'POST',
      headers: { Authorization: `Api-Key ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error.name === 'TimeoutError') throw new Error(`Таймаут Yandex Translate (${timeoutMs} мс)`);
    throw new Error('Yandex Translate недоступен');
  }
  if (!response.ok) {
    const detail = await response.json().then((data) => data?.message, () => null);
    throw new Error(`Yandex Translate HTTP ${response.status}${detail ? `: ${String(detail).slice(0, 200)}` : ''}`);
  }
  const data = await response.json().catch(() => null);
  const translation = data?.translations?.[0]?.text?.trim();
  if (!translation) throw new Error('Yandex Translate вернул пустой перевод');
  return translation;
}

// Возвращает Response со звуком MP3, чтобы вызывающий мог воспроизводить его по мере загрузки.
export function synthesizeYandex({ key, fetchImpl = fetch }, { text, lang, voice, signal }) {
  const body = new URLSearchParams({ text: text.trim(), lang, voice, format: 'mp3' });
  return fetchImpl(YANDEX_TTS_URL, {
    method: 'POST',
    headers: { Authorization: `Api-Key ${key}`, 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal,
  });
}

// ---------- проверки ключей для страницы настроек ----------
const httpError = (name, status) =>
  status === 401 ? `${name}: ключ не принят (401)` :
  status === 403 ? `${name}: у ключа нет нужных прав (403)` : `${name}: HTTP ${status}`;

export async function checkDeepgram(key, fetchImpl = fetch) {
  const response = await fetchImpl('https://api.deepgram.com/v1/projects', {
    headers: { Authorization: `Token ${key}` }, signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(httpError('Deepgram', response.status));
  return 'Deepgram: ключ работает';
}

export async function checkDeepSeek(key, model, fetchImpl = fetch) {
  const response = await fetchImpl(`${DEEPSEEK_BASE}/models`, {
    headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(httpError('DeepSeek', response.status));
  const models = (await response.json().catch(() => null))?.data?.map((item) => item.id) ?? [];
  return models.length && !models.includes(model)
    ? `DeepSeek: ключ работает, но модели «${model}» нет в списке (${models.join(', ')})`
    : 'DeepSeek: ключ работает';
}

// Сервер отвечает на WebSocket только при заданном ключе SpeechKit и верном токене.
export function checkServer(serverUrl, token, WebSocketImpl = WebSocket) {
  return new Promise((resolve, reject) => {
    let sock;
    try {
      if (token && !SERVER_TOKEN_PATTERN.test(token)) throw new Error('token');
      sock = new WebSocketImpl(yandexSttUrl(serverUrl, 'en'), serverProtocols(token));
    } catch (error) {
      return reject(new Error(error.message === 'token'
        ? 'Токен: от 32 символов, только латиница, цифры и . _ ~ -'
        : 'Некорректный адрес сервера'));
    }
    const timer = setTimeout(() => { sock.close(); reject(new Error('Сервер не ответил за 8 секунд')); }, 8000);
    sock.onopen = () => {
      clearTimeout(timer);
      sock.send(JSON.stringify({ type: 'CloseStream' }));
      sock.close();
      resolve('Сервер LiveDub: распознавание SpeechKit доступно');
    };
    sock.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Не удалось подключиться: сервер не запущен, на нём нет ключа SpeechKit или неверный токен'));
    };
  });
}

export async function checkYandex(key, folderId, fetchImpl = fetch) {
  const results = [];
  try {
    await translateYandex({ key, folderId, fetchImpl }, { text: 'Hello', source: 'en', target: 'ru' });
    results.push('Translate: работает');
  } catch (error) {
    results.push(`Translate: ${error.message}`);
  }
  try {
    const response = await synthesizeYandex({ key, fetchImpl },
      { text: 'Проверка', lang: 'ru-RU', voice: 'alena', signal: AbortSignal.timeout(8000) });
    results.push(response.ok ? 'SpeechKit: работает' : httpError('SpeechKit', response.status));
  } catch {
    results.push('SpeechKit: недоступен');
  }
  return results.join(' · ');
}
