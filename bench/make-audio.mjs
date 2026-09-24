// Озвучивает сценарий голосами macOS (`say`) и склеивает реплики в один WAV
// 16 кГц моно с заданными паузами. Рядом пишет timings.json: где в звуке
// начинается и заканчивается речь каждой реплики — по уровню сигнала, а не по
// длине файла, потому что `say` добавляет тишину по краям.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SAMPLE_RATE = 16000;
const SILENCE_THRESHOLD = 0.01; // RMS окна 20 мс
const LEAD_IN_MS = 1000;        // тишина до первой реплики

// Данные PCM из WAV: afconvert может добавить служебные чанки перед `data`.
export function wavSamples(buffer) {
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'data') {
      const data = buffer.subarray(offset + 8, offset + 8 + size);
      return new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length));
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('В WAV нет чанка data');
}

export function wavFile(samples, sampleRate = SAMPLE_RATE) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + samples.length * 2, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(samples.length * 2, 40);
  return Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, samples.length * 2)]);
}

// Первый и последний отсчёт окон, где RMS выше порога.
export function speechBounds(samples, sampleRate = SAMPLE_RATE) {
  const win = Math.round(sampleRate * 0.02);
  let first = -1, last = -1;
  for (let start = 0; start < samples.length; start += win) {
    let sum = 0;
    const end = Math.min(samples.length, start + win);
    for (let i = start; i < end; i++) sum += (samples[i] / 32768) ** 2;
    if (Math.sqrt(sum / (end - start)) > SILENCE_THRESHOLD) {
      if (first < 0) first = start;
      last = end;
    }
  }
  return first < 0 ? { start: 0, end: 0 } : { start: first, end: last };
}

export function scenarioHash(scenario) {
  return createHash('sha256').update(JSON.stringify(scenario)).digest('hex').slice(0, 12);
}

// Возвращает пути к WAV и таймингам; повторно не озвучивает неизменённый сценарий.
export function buildAudio(scenarioPath, outDir) {
  const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
  const hash = scenarioHash(scenario);
  const wavPath = join(outDir, `${scenario.name}.wav`);
  const timingsPath = join(outDir, `${scenario.name}.timings.json`);
  if (existsSync(timingsPath) && JSON.parse(readFileSync(timingsPath, 'utf8')).hash === hash && existsSync(wavPath)) {
    return { wavPath, timingsPath, scenario };
  }
  const tmp = join(outDir, 'lines');
  mkdirSync(tmp, { recursive: true });
  const chunks = [new Int16Array(SAMPLE_RATE * LEAD_IN_MS / 1000)];
  let cursor = chunks[0].length;
  const lines = scenario.lines.map((line, index) => {
    const aiff = join(tmp, `${index}.aiff`), wav = join(tmp, `${index}.wav`);
    execFileSync('say', ['-v', scenario.voices[line.speaker], '-r', String(scenario.rate), '-o', aiff, line.text]);
    execFileSync('afconvert', ['-f', 'WAVE', '-d', `LEI16@${SAMPLE_RATE}`, '-c', '1', aiff, wav]);
    const samples = wavSamples(readFileSync(wav));
    const { start, end } = speechBounds(samples);
    const speech = samples.subarray(start, end);
    const timing = { index, speaker: line.speaker, text: line.text, ref: line.ref,
      startMs: Math.round(cursor / SAMPLE_RATE * 1000), endMs: Math.round((cursor + speech.length) / SAMPLE_RATE * 1000) };
    const pause = new Int16Array(Math.round(SAMPLE_RATE * line.pauseAfterMs / 1000));
    chunks.push(speech, pause);
    cursor += speech.length + pause.length;
    return timing;
  });
  const all = new Int16Array(cursor);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  writeFileSync(wavPath, wavFile(all));
  writeFileSync(timingsPath, JSON.stringify({ hash, source: scenario.source, target: scenario.target,
    durationMs: Math.round(cursor / SAMPLE_RATE * 1000), lines }, null, 2));
  rmSync(tmp, { recursive: true, force: true });
  return { wavPath, timingsPath, scenario };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = new URL('.', import.meta.url).pathname;
  mkdirSync(join(root, 'out'), { recursive: true });
  const { wavPath, timingsPath } = buildAudio(join(root, 'scenario.json'), join(root, 'out'));
  const timings = JSON.parse(readFileSync(timingsPath, 'utf8'));
  console.log(`${wavPath}: ${(timings.durationMs / 1000).toFixed(1)} с, реплик: ${timings.lines.length}`);
}
