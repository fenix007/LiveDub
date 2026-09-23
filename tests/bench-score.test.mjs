import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alignWords, chrF, lineLatencies, normalizeWords, scoreRun, wordErrorRate } from '../bench/score.js';
import { speechBounds, wavFile, wavSamples } from '../bench/make-audio.mjs';

test('words are compared without case and punctuation', () => {
  assert.deepEqual(normalizeWords('Hi, thanks! Don\'t — stop. 300 Ёлка'), ['hi', 'thanks', 'don\'t', 'stop', '300', 'елка']);
});

test('word error rate counts substitutions, deletions and insertions', () => {
  assert.deepEqual(wordErrorRate('a b c d', 'a x c d e'), { wer: 0.5, words: 4, substitutions: 1, deletions: 0, insertions: 1 });
  assert.equal(wordErrorRate('one two three', 'one three').deletions, 1);
  assert.equal(alignWords([], ['x']).length, 1);
});

test('line latency uses the phrase that carried the last word of the line', () => {
  const lines = [{ text: 'hello there my friend', endMs: 1000 }, { text: 'how are you', endMs: 3000 }];
  // Вторая реплика склеилась с хвостом первой в одну фразу расширения.
  const phrases = [{ source: 'hello there', shownMs: 900 }, { source: 'my friend how are you', shownMs: 3600 }];
  assert.deepEqual(lineLatencies(lines, phrases).map((line) => line.latencyMs), [2600, 600]);
  // Нераспознанная реплика не получает задержки.
  assert.equal(lineLatencies([{ text: 'zzz', endMs: 0 }], phrases)[0].latencyMs, null);
});

test('chrF is 100 for an exact match and drops for a different text', () => {
  assert.equal(Math.round(chrF('Привет, мир', 'привет,мир')), 100);
  assert.ok(chrF('Я работаю инженером', 'Я работаю программистом') < 80);
  assert.equal(chrF('текст', ''), 0);
});

test('run score combines recognition, latency and translation', () => {
  const result = scoreRun({
    lines: [{ text: 'good morning', ref: 'доброе утро', endMs: 500 }],
    phrases: [{ source: 'Good morning.', translation: 'Доброе утро.', shownMs: 1700 }],
  });
  assert.equal(result.recognition.wer, 0);
  assert.equal(result.latency.p50Ms, 1200);
  assert.ok(result.translation.chrF > 90);
});

test('generated WAV round-trips and speech bounds skip silence', () => {
  const samples = new Int16Array(16000);
  for (let i = 4000; i < 8000; i++) samples[i] = i % 2 ? 8000 : -8000;
  const parsed = wavSamples(wavFile(samples));
  assert.deepEqual([...parsed.slice(3998, 4002)], [0, 0, -8000, 8000]);
  const { start, end } = speechBounds(parsed);
  assert.ok(start <= 4000 && start > 3600, `start ${start}`);
  assert.ok(end >= 8000 && end < 8400, `end ${end}`);
});
