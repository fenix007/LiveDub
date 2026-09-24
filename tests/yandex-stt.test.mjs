import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPauseDetector, createStreamingRecognition, sessionOptions, toDeepgramMessage } from '../yandex-stt.js';
import { yandexSttUrl } from '../extension/lib/providers.js';

const frame = (amplitude, ms = 40) => Int16Array.from({ length: 16 * ms }, (_, i) => (i % 2 ? amplitude : -amplitude));
const pcm = (amplitude, ms = 40) => Buffer.from(frame(amplitude, ms).buffer);

test('SpeechKit responses become Deepgram-shaped messages shifted by the session offset', () => {
  const update = { alternatives: [{ text: 'hello there', start_time_ms: 1000, end_time_ms: 1800,
    words: [{ text: 'hello', start_time_ms: 1000, end_time_ms: 1300 }, { text: 'there', start_time_ms: 1400, end_time_ms: 1800 }] }] };
  const partial = toDeepgramMessage({ partial: update });
  assert.equal(partial.is_final, false);
  assert.equal(partial.channel.alternatives[0].transcript, 'hello there');
  assert.deepEqual([partial.start, partial.duration], [1, 0.8]);

  const final = toDeepgramMessage({ final: update }, 60_000);
  assert.equal(final.is_final, true);
  assert.equal(final.start, 61);
  assert.equal(final.channel.alternatives[0].words.at(-1).end, 61.8);

  assert.deepEqual(toDeepgramMessage({ eou_update: { time_ms: 2000 } }, 1000), { type: 'UtteranceEnd', last_word_end: 3 });
  assert.equal(toDeepgramMessage({ status_code: { code_type: 'WORKING' } }), null);
});

test('session uses raw PCM, no normalization and an external end-of-utterance classifier', () => {
  const options = sessionOptions({ language: 'en-US' });
  assert.deepEqual(options.eou_classifier, { external_classifier: {} });
  assert.equal(options.recognition_model.audio_format.raw_audio.sample_rate_hertz, 16000);
  assert.equal(options.recognition_model.text_normalization.text_normalization, 'TEXT_NORMALIZATION_DISABLED');
  assert.deepEqual(options.recognition_model.language_restriction.language_code, ['en-US']);
});

test('pause detector fires once after the configured silence following speech', () => {
  const detect = createPauseDetector({ pauseMs: 300 });
  assert.equal(detect(frame(0)), false); // тишина до речи — не конец фразы
  for (let i = 0; i < 10; i++) assert.equal(detect(frame(5000)), false);
  const fired = [];
  for (let i = 0; i < 12; i++) fired.push(detect(frame(0)));
  assert.equal(fired.indexOf(true), 7); // 8 кадров по 40 мс = 320 мс ≥ 300 мс
  assert.equal(fired.filter(Boolean).length, 1);
});

test('pause detector ignores a steady noise floor and closes endless speech', () => {
  const detect = createPauseDetector({ pauseMs: 300, maxSpeechMs: 1000 });
  for (let i = 0; i < 20; i++) assert.equal(detect(frame(150)), false); // шум ниже порога 0,01
  const fired = [];
  for (let i = 0; i < 30; i++) fired.push(detect(frame(8000)));
  assert.equal(fired.filter(Boolean).length, 1); // 25 кадров = 1000 мс непрерывной речи
});

test('streaming recognition sends eou on pauses and rotates the session with time offset', () => {
  const sessions = [];
  const messages = [];
  const open = ({ onResponse }) => {
    const session = { writes: 0, eous: 0, ended: false, onResponse };
    sessions.push(session);
    return { write: () => { session.writes++; }, eou: () => { session.eous++; }, end: () => { session.ended = true; }, cancel: () => {} };
  };
  const recognition = createStreamingRecognition({ apiKey: 'k', language: 'en-US', pauseMs: 200, onMessage: (m) => messages.push(m), onError: assert.fail, open });

  for (let i = 0; i < 5; i++) recognition.write(pcm(6000));
  for (let i = 0; i < 6; i++) recognition.write(pcm(0));
  assert.equal(sessions[0].eous, 1);

  // Почти пять минут звука: на следующей паузе открывается новая сессия.
  for (let i = 0; i < 6800; i++) recognition.write(pcm(i % 50 < 40 ? 6000 : 0));
  assert.ok(sessions.length >= 2, 'нужна новая сессия');
  assert.equal(sessions[0].ended, true);

  assert.ok(sessions[1].writes > 0, 'звук после смены идёт в новую сессию');
  sessions[1].onResponse({ eou_update: { time_ms: 500 } });
  assert.ok(messages.at(-1).last_word_end > 270, 'время второй сессии отсчитывается от начала потока');
  recognition.close();
  sessions[1].onResponse({ eou_update: { time_ms: 600 } });
  assert.equal(messages.length, 1, 'после close сообщения не передаются');
});

test('extension builds the proxy URL with ws scheme, language, pause and optional token', () => {
  const plain = new URL(yandexSttUrl('http://localhost:3000', 'en', { endpointing: 500 }));
  assert.equal(plain.href.split('?')[0], 'ws://localhost:3000/api/stt/yandex');
  assert.equal(plain.searchParams.get('endpointing'), '500');
  assert.equal(plain.searchParams.has('token'), false);
  const secure = new URL(yandexSttUrl('https://livedub.example', 'ru', { token: 's3cret' }));
  assert.equal(secure.protocol, 'wss:');
  assert.equal(secure.searchParams.get('token'), 's3cret');
});
