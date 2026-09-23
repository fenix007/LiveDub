// Эталонный прогон: синтезированное собеседование проходит через настоящий код
// боковой панели (Deepgram + движки перевода) в Chromium без окна.
//
//   node --env-file=.env bench/run.mjs --final yandex,deepseek --endpointing 300,500
//
// Флаги принимают списки через запятую, прогоняются все сочетания:
//   --final     yandex | deepseek | chrome   (по умолчанию yandex)
//   --draft     off | yandex | deepseek      (по умолчанию off; Chrome Translator в Chromium без окна недоступен)
//   --endpointing 150 | 300 | 500 | 800      (по умолчанию 300)
//   --headed    показать окно браузера
//   --verbose   задержка и текст по каждой реплике
// Один прогон длится около двух минут и тратит ~1,6 минуты распознавания Deepgram.
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { buildAudio } from './make-audio.mjs';
import { scoreRun } from './score.js';

const root = new URL('.', import.meta.url).pathname;
const extensionDir = join(root, '..', 'extension');
const outDir = join(root, 'out');
const TAIL_MS = 8000; // ожидание после конца звука: последняя фраза и её перевод

function parseArgs(argv) {
  const options = { final: ['yandex'], draft: ['off'], endpointing: [300], headed: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, '');
    if (name === 'headed' || name === 'verbose') { options[name] = true; continue; }
    if (!(name in options)) throw new Error(`Неизвестный флаг: ${argv[i]}`);
    const values = String(argv[++i] ?? '').split(',').filter(Boolean);
    options[name] = name === 'endpointing' ? values.map(Number) : values;
  }
  return options;
}

function keysFromEnv(env) {
  return {
    deepgramKey: env.DEEPGRAM_API_KEY ?? '',
    deepseekKey: env.DEEPSEEK_API_KEY ?? '',
    deepseekModel: env.DEEPSEEK_MODEL || 'deepseek-flash',
    yandexKey: env.YANDEX_TRANSLATE_API_KEY || env.YANDEX_SPEECHKIT_API_KEY || '',
    yandexFolderId: env.YANDEX_FOLDER_ID ?? '',
  };
}

const engineKey = { yandex: 'yandexKey', deepseek: 'deepseekKey' };
const missingKey = (keys, engine) => engineKey[engine] && !keys[engineKey[engine]];

// Временная копия расширения со страницей стенда рядом с sidepanel.html.
function prepareExtension(wavPath) {
  const dir = mkdtempSync(join(tmpdir(), 'livedub-bench-ext-'));
  cpSync(extensionDir, dir, { recursive: true });
  const html = readFileSync(join(dir, 'sidepanel.html'), 'utf8')
    .replace('<script type="module" src="sidepanel.js"></script>', '<script type="module" src="bench-hooks.js"></script>');
  if (!html.includes('bench-hooks.js')) throw new Error('В sidepanel.html не найден скрипт панели');
  writeFileSync(join(dir, 'bench.html'), html);
  cpSync(join(root, 'hooks.js'), join(dir, 'bench-hooks.js'));
  cpSync(wavPath, join(dir, 'bench-audio.wav'));
  return dir;
}

async function runOnce({ extDir, keys, prefs, durationMs, headed }) {
  const profile = mkdtempSync(join(tmpdir(), 'livedub-bench-profile-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: !headed,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--autoplay-policy=no-user-gesture-required'],
  });
  const errors = [];
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(`chrome-extension://${extensionId}/bench.html`);
    // При установке расширение открывает настройки: закрываем, чтобы вкладка стенда была активной.
    for (const other of context.pages()) if (other !== page) await other.close();
    await page.bringToFront();
    await page.evaluate((config) => {
      window.benchConfig = config;
      dispatchEvent(new CustomEvent('bench:config', { detail: config }));
    }, { keys, prefs, tailMs: TAIL_MS });
    const handle = await page.waitForFunction(() => window.benchResult, null, { timeout: durationMs + TAIL_MS + 60_000, polling: 500 });
    return { ...(await handle.jsonValue()), errors };
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

const seconds = (ms) => ms == null ? '—' : `${(ms / 1000).toFixed(2)} с`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const keys = keysFromEnv(process.env);
  if (!keys.deepgramKey) throw new Error('Нужен DEEPGRAM_API_KEY: запускайте с --env-file=.env');
  mkdirSync(outDir, { recursive: true });
  const { wavPath, timingsPath, scenario } = buildAudio(join(root, 'scenario.json'), outDir);
  const timings = JSON.parse(readFileSync(timingsPath, 'utf8'));
  const extDir = prepareExtension(wavPath);

  const configs = options.final.flatMap((finalEngine) => options.draft.flatMap((draftEngine) =>
    options.endpointing.map((endpointing) => ({ finalEngine, draftEngine, endpointing }))));
  const report = { scenario: scenario.name, startedAt: new Date().toISOString(), durationMs: timings.durationMs, runs: [] };
  try {
    for (const config of configs) {
      const label = `финал ${config.finalEngine}, черновик ${config.draftEngine}, конец фразы ${config.endpointing} мс`;
      const missing = [config.finalEngine, config.draftEngine].find((engine) => missingKey(keys, engine));
      if (missing) { console.log(`— ${label}: пропущено, нет ключа ${missing}`); continue; }
      console.log(`▶ ${label} (≈${Math.round((timings.durationMs + TAIL_MS) / 1000)} с)`);
      const prefs = { source: timings.source, target: timings.target, draftEngine: config.draftEngine, finalEngine: config.finalEngine,
        endpointing: config.endpointing, tts: false, subtitles: false };
      const result = await runOnce({ extDir, keys, prefs, durationMs: timings.durationMs, headed: options.headed });
      if (result.error) {
        console.log(`  ошибка: ${result.error}`);
        report.runs.push({ config, error: result.error, errors: result.errors });
        continue;
      }
      const score = scoreRun({ lines: timings.lines, phrases: result.phrases });
      report.runs.push({ config, score, metrics: result.metrics, phrases: result.phrases, rows: result.rows, errors: result.errors });
      const { recognition, latency, translation } = score;
      console.log(`  распознавание: WER ${(recognition.wer * 100).toFixed(1)}% (${recognition.words} слов: ` +
        `замен ${recognition.substitutions}, пропусков ${recognition.deletions}, лишних ${recognition.insertions})`);
      console.log(`  от конца реплики до перевода: p50 ${seconds(latency.p50Ms)}, p95 ${seconds(latency.p95Ms)}, ` +
        `макс ${seconds(latency.maxMs)} (измерено ${latency.measured} из ${latency.lines})`);
      console.log(`  перевод: chrF ${translation.chrF.toFixed(1)}; фраз: ${result.phrases.length}; ошибок в консоли: ${result.errors.length}`);
      const clock = result.audioClock;
      console.log(`  звук в Deepgram: ${clock.sentSeconds.toFixed(1)} с за ${clock.wallSeconds.toFixed(1)} с по часам, WAV ${clock.wavSeconds.toFixed(1)} с проигран за ${clock.playbackSeconds.toFixed(1)} с (AudioContext ${clock.sampleRate} Гц), ` +
        `макс. очередь сокета ${clock.maxBufferedSeconds.toFixed(2)} с, вкладка ${clock.visibility}`);
      console.log(`  панель: ${result.metrics}`);
      if (options.verbose) {
        for (const line of score.perLine) {
          console.log(`    ${String(line.index + 1).padStart(2)}. ${seconds(line.latencyMs).padStart(8)}  ${timings.lines[line.index].text}`);
        }
      }
    }
  } finally {
    rmSync(extDir, { recursive: true, force: true });
  }
  const reportPath = join(outDir, `report-${report.startedAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Отчёт: ${reportPath}`);
}

main().catch((error) => { console.error(error.message); process.exit(1); });
