// Загружает исходные субтитры и аудио YouTube для проверки распознавания.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeWords } from './score.js';

const timestampMs = (value) => {
  const parts = value.replace(',', '.').split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return NaN;
  return parts.reduce((total, part) => total * 60 + part, 0) * 1000;
};

export function subtitleWords(vtt, startSeconds = 0, durationSeconds = Infinity) {
  const firstMs = startSeconds * 1000, lastMs = (startSeconds + durationSeconds) * 1000;
  const words = [];
  for (const block of vtt.replaceAll('\r', '').split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const cueIndex = lines.findIndex((line) => line.includes('-->'));
    if (cueIndex < 0) continue;
    const match = lines[cueIndex].match(/(\d{2}:\d{2}:\d{2}[.,]\d{3}|\d{2}:\d{2}[.,]\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}[.,]\d{3}|\d{2}:\d{2}[.,]\d{3})/);
    if (!match || timestampMs(match[2]) <= firstMs || timestampMs(match[1]) >= lastMs) continue;
    const raw = lines.slice(cueIndex + 1).join(' ')
      .replace(/<[^>]*>/g, ' ').replace(/\[[^\]]*\]/g, ' ')
      .replace(/&amp;/gi, '&').replace(/&(?:#39|apos);/gi, "'")
      .replace(/&quot;/gi, '"').replace(/&nbsp;/gi, ' ');
    const cue = normalizeWords(raw);
    if (!cue.length) continue;
    // Автоматические субтитры YouTube часто повторяют хвост предыдущего cue.
    let overlap = 0;
    for (let n = Math.min(words.length, cue.length); n >= 2; n--) {
      if (words.slice(-n).every((word, index) => word === cue[index])) { overlap = n; break; }
    }
    words.push(...cue.slice(overlap));
  }
  return words;
}

export function prepareYoutube({ url, language, startSeconds, durationSeconds, outDir }) {
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol) ||
      !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(parsed.hostname))
    throw new Error('Нужна ссылка на видео YouTube');
  mkdirSync(outDir, { recursive: true });
  const workDir = mkdtempSync(join(outDir, 'clip-'));
  const run = (program, args) => {
    try {
      return execFileSync(program, args, {
        encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Не найдена команда ${program}: установите её и добавьте в PATH`);
      throw new Error(`${program}: ${error.stderr?.toString().trim() || error.message}`);
    }
  };
  try {
    const info = JSON.parse(run('yt-dlp', ['--dump-single-json', '--skip-download', '--no-playlist', url]));
    const manual = Boolean(info.subtitles?.[language]?.length);
    const automatic = Boolean(info.automatic_captions?.[language]?.length);
    if (!manual && !automatic) {
      const available = Object.keys({ ...info.subtitles, ...info.automatic_captions }).slice(0, 25).join(', ');
      throw new Error(`Нет субтитров языка ${language}. Доступны: ${available || 'нет'}`);
    }
    const base = join(workDir, 'youtube-reference');
    run('yt-dlp', ['--no-playlist', '--skip-download', manual ? '--write-subs' : '--write-auto-subs',
      '--sub-langs', language, '--sub-format', 'vtt', '-o', `${base}.%(ext)s`, url]);
    const subtitle = readdirSync(workDir).find((name) => name.startsWith('youtube-reference.') && name.endsWith('.vtt'));
    if (!subtitle) throw new Error('yt-dlp не сохранил субтитры VTT');
    const words = subtitleWords(readFileSync(join(workDir, subtitle), 'utf8'), startSeconds, durationSeconds);
    if (!words.length) throw new Error('В выбранном фрагменте нет слов в субтитрах');

    run('yt-dlp', ['--no-playlist', '-f', 'bestaudio', '-o', `${join(workDir, 'youtube-audio')}.%(ext)s`, url]);
    const audio = readdirSync(workDir).find((name) => name.startsWith('youtube-audio.'));
    if (!audio) throw new Error('yt-dlp не сохранил аудио');
    const wavPath = join(workDir, 'youtube-bench.wav');
    run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(startSeconds), '-t', String(durationSeconds),
      '-i', join(workDir, audio), '-af', 'apad=pad_dur=2', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wavPath]);
    return { wavPath, reference: words.join(' '), title: info.title, videoId: info.id,
      captionKind: manual ? 'ручные' : 'автоматические', durationMs: (durationSeconds + 2) * 1000, workDir };
  } catch (error) {
    rmSync(workDir, { recursive: true, force: true });
    throw error;
  }
}
