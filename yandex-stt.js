// Потоковое распознавание Yandex SpeechKit (API v3) для браузера. SpeechKit
// принимает поток только по gRPC, браузер так не умеет, поэтому сервер держит
// gRPC-поток и отдаёт результаты по WebSocket в формате ответов Deepgram:
// боковая панель обрабатывает оба распознавателя одним кодом.
//
//   partial      → Results { is_final: false }   текст ещё может измениться
//   final        → Results { is_final: true }    текст закреплён
//   eou_update   → UtteranceEnd                  конец фразы
//
// Конец фразы определяет сервер по паузе в звуке и сообщает SpeechKit сам
// (external_classifier). Встроенный детектор SpeechKit на эталонном прогоне
// переставал срабатывать и склеивал по пять реплик в одну.
import { fileURLToPath } from 'node:url';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';

export const YANDEX_STT_ENDPOINT = 'stt.api.cloud.yandex.net:443';
export const YANDEX_STT_LANGUAGES = { en: 'en-US', ru: 'ru-RU', de: 'de-DE', fr: 'fr-FR', es: 'es-ES' };
const SAMPLE_RATE = 16000;
const BYTES_PER_MS = SAMPLE_RATE * 2 / 1000;
// SpeechKit принимает не больше 5 минут звука за сессию: новая открывается раньше.
const MAX_SESSION_MS = 270_000;
const FORCED_ROTATION_MS = 290_000;

let RecognizerClient = null;
function recognizer() {
  if (!RecognizerClient) {
    const definition = protoLoader.loadSync('speechkit/stt/v3/stt_service.proto', {
      includeDirs: [fileURLToPath(new URL('./proto', import.meta.url))],
      keepCase: true, longs: Number, enums: String, defaults: false, oneofs: true,
    });
    RecognizerClient = grpc.loadPackageDefinition(definition).speechkit.stt.v3.Recognizer;
  }
  return RecognizerClient;
}

export function sessionOptions({ language }) {
  return {
    recognition_model: {
      model: 'general',
      audio_format: { raw_audio: { audio_encoding: 'LINEAR16_PCM', sample_rate_hertz: SAMPLE_RATE, audio_channel_count: 1 } },
      // Нормализация добавляет задержку к финалу: текст идёт как распознан.
      text_normalization: { text_normalization: 'TEXT_NORMALIZATION_DISABLED' },
      language_restriction: { restriction_type: 'WHITELIST', language_code: [language] },
      audio_processing_type: 'REAL_TIME',
    },
    eou_classifier: { external_classifier: {} },
  };
}

const alternativeResult = (update, isFinal, offsetMs) => {
  const alternative = update?.alternatives?.[0];
  if (!alternative) return null;
  const startMs = Number(alternative.start_time_ms ?? 0), endMs = Number(alternative.end_time_ms ?? startMs);
  return {
    type: 'Results', is_final: isFinal, speech_final: false,
    start: (startMs + offsetMs) / 1000, duration: Math.max(0, endMs - startMs) / 1000,
    channel: { alternatives: [{
      transcript: alternative.text ?? '',
      words: (alternative.words ?? []).map((word) => ({
        word: word.text,
        start: (Number(word.start_time_ms ?? 0) + offsetMs) / 1000,
        end: (Number(word.end_time_ms ?? 0) + offsetMs) / 1000,
      })),
    }] },
  };
};

// Ответ SpeechKit → сообщение в формате Deepgram или null, если передавать нечего.
// offsetMs — сколько звука ушло в предыдущие сессии: время отсчитывается от начала потока.
export function toDeepgramMessage(response, offsetMs = 0) {
  if (response.partial) return alternativeResult(response.partial, false, offsetMs);
  if (response.final) return alternativeResult(response.final, true, offsetMs);
  if (response.eou_update) return { type: 'UtteranceEnd', last_word_end: (Number(response.eou_update.time_ms ?? 0) + offsetMs) / 1000 };
  return null;
}

// Пауза по уровню сигнала. Порог — втрое выше фона, но не ниже 0,01: фон быстро
// следует за тишиной вниз и медленно поднимается, если звук постоянно громкий
// (музыка). Непрерывная речь без пауз закрывается принудительно через maxSpeechMs.
export function createPauseDetector({ pauseMs, maxSpeechMs = 15_000 }) {
  let speaking = false, silentMs = 0, speechMs = 0, floor = 0.003;
  return (samples) => {
    if (!samples.length) return false;
    let sum = 0;
    for (const sample of samples) sum += (sample / 32768) ** 2;
    const rms = Math.sqrt(sum / samples.length);
    const ms = samples.length / SAMPLE_RATE * 1000;
    floor += (rms - floor) * (rms < floor ? 1 : 0.0005);
    if (rms > Math.max(0.01, floor * 3)) {
      speaking = true;
      silentMs = 0;
      speechMs += ms;
      if (speechMs < maxSpeechMs) return false;
      speechMs = 0;
      return true;
    }
    if (!speaking) return false;
    silentMs += ms;
    speechMs += ms;
    if (silentMs < pauseMs) return false;
    speaking = false;
    silentMs = speechMs = 0;
    return true;
  };
}

// Один gRPC-поток. Возвращает { write(pcm), eou(), end(), cancel() }.
export function openRecognition({ apiKey, language, onResponse, onError, onEnd,
  endpoint = YANDEX_STT_ENDPOINT, credentials = grpc.credentials.createSsl() }) {
  const Recognizer = recognizer();
  const client = new Recognizer(endpoint, credentials);
  const metadata = new grpc.Metadata();
  metadata.set('authorization', `Api-Key ${apiKey}`);
  const call = client.RecognizeStreaming(metadata);
  call.on('data', onResponse);
  call.on('error', (error) => {
    // CANCELLED приходит после нашего же cancel().
    if (error.code !== grpc.status.CANCELLED) onError(error);
  });
  call.on('end', () => { client.close(); onEnd?.(); });
  call.write({ session_options: sessionOptions({ language }) });
  return {
    write: (pcm) => call.write({ chunk: { data: pcm } }),
    eou: () => call.write({ eou: {} }),
    end: () => call.end(),
    cancel: () => { call.cancel(); client.close(); },
  };
}

// Непрерывное распознавание поверх сессий SpeechKit: паузы → eou, смена сессии
// до лимита в 5 минут на ближайшей паузе, время в ответах — от начала потока.
export function createStreamingRecognition({ apiKey, language, pauseMs, onMessage, onError, open = openRecognition }) {
  const detectPause = createPauseDetector({ pauseMs });
  let sentMs = 0, session = null, sessionStartMs = 0, closed = false;

  function start() {
    const offsetMs = sentMs;
    sessionStartMs = sentMs;
    session = open({
      apiKey, language,
      onResponse: (response) => {
        const message = toDeepgramMessage(response, offsetMs);
        if (message && !closed) onMessage(message);
      },
      onError: (error) => { if (!closed) onError(error); },
    });
  }
  start();

  return {
    write(pcm) {
      if (closed) return;
      session.write(pcm);
      sentMs += pcm.length / BYTES_PER_MS;
      // Buffer из ws может начинаться с нечётного смещения — Int16Array тогда нельзя создать поверх него.
      const aligned = pcm.byteOffset % 2 ? Buffer.from(pcm) : pcm;
      const pause = detectPause(new Int16Array(aligned.buffer, aligned.byteOffset, aligned.length >> 1));
      if (pause) session.eou();
      const age = sentMs - sessionStartMs;
      if ((pause && age >= MAX_SESSION_MS) || age >= FORCED_ROTATION_MS) {
        if (!pause) session.eou();
        session.end(); // старая сессия дошлёт свой финал
        start();
      }
    },
    close() {
      closed = true;
      session.cancel();
    },
  };
}

// Понятный текст ошибки gRPC без ключа.
export function describeGrpcError(error) {
  if (error.code === grpc.status.UNAUTHENTICATED) return 'SpeechKit: ключ не принят';
  if (error.code === grpc.status.PERMISSION_DENIED) return 'SpeechKit: у ключа нет роли ai.speechkit-stt.user';
  return `SpeechKit: ${error.details || error.message}`;
}

// WebSocket от браузера: бинарные сообщения — PCM 16 кГц, текстовые (KeepAlive,
// CloseStream) — служебные сообщения в формате Deepgram.
export function attachSocket(ws, { apiKey, language, pauseMs }) {
  const send = (message) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message)); };
  const recognition = createStreamingRecognition({
    apiKey, language, pauseMs,
    onMessage: send,
    onError: (error) => {
      send({ type: 'Error', message: describeGrpcError(error) });
      ws.close(1011, 'SpeechKit error');
    },
  });
  ws.on('message', (data, isBinary) => {
    if (isBinary) return recognition.write(Buffer.isBuffer(data) ? data : Buffer.concat(data));
    if (String(data).includes('CloseStream')) ws.close(1000);
  });
  ws.on('close', () => recognition.close());
}
