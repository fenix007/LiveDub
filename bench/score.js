// Оценка прогона: точность распознавания (WER), задержка от конца реплики
// до финального перевода на экране и сходство перевода с эталоном (chrF).
// Числа Deepgram пишет цифрами (smart_format), поэтому в сценарии они тоже цифрами.
export const normalizeWords = (text) => text.normalize('NFC').toLocaleLowerCase()
  .replaceAll('ё', 'е').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/(^|\s)['-]+|['-]+(?=\s|$)/g, ' ')
  .split(/\s+/).filter(Boolean);

// Выравнивание Левенштейна по словам. Пары { ref, hyp } — индексы или null.
export function alignWords(ref, hyp) {
  const rows = ref.length + 1, cols = hyp.length + 1;
  const cost = Array.from({ length: rows }, (_, i) => new Uint32Array(cols).fill(0).map((_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      cost[i][j] = Math.min(cost[i - 1][j] + 1, cost[i][j - 1] + 1, cost[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    }
  }
  const pairs = [];
  let i = ref.length, j = hyp.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && cost[i][j] === cost[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) pairs.push({ ref: --i, hyp: --j });
    else if (i > 0 && cost[i][j] === cost[i - 1][j] + 1) pairs.push({ ref: --i, hyp: null });
    else pairs.push({ ref: null, hyp: --j });
  }
  return pairs.reverse();
}

export function wordErrorRate(refText, hypText) {
  const ref = normalizeWords(refText), hyp = normalizeWords(hypText);
  const pairs = alignWords(ref, hyp);
  const counts = { substitutions: 0, deletions: 0, insertions: 0 };
  for (const { ref: r, hyp: h } of pairs) {
    if (r === null) counts.insertions++;
    else if (h === null) counts.deletions++;
    else if (ref[r] !== hyp[h]) counts.substitutions++;
  }
  const errors = counts.substitutions + counts.deletions + counts.insertions;
  return { wer: ref.length ? errors / ref.length : 0, words: ref.length, ...counts };
}

export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
}

// lines: [{ text, endMs }] — эталонные реплики и конец речи в звуке.
// phrases: [{ source, shownMs }] — фразы расширения и момент первого финального
// перевода, в той же шкале времени, что и звук.
// Задержка реплики = момент, когда на экране появился перевод фразы с её
// последним точно распознанным словом, минус конец реплики в звуке.
export function lineLatencies(lines, phrases) {
  const ref = [], refLine = [];
  lines.forEach((line, index) => {
    for (const word of normalizeWords(line.text)) { ref.push(word); refLine.push(index); }
  });
  const hyp = [], hypShown = [];
  for (const phrase of phrases) {
    for (const word of normalizeWords(phrase.source)) { hyp.push(word); hypShown.push(phrase.shownMs); }
  }
  const lastMatch = new Array(lines.length).fill(null);
  // Только точные совпадения: замена могла сопоставить слово с чужой репликой.
  for (const { ref: r, hyp: h } of alignWords(ref, hyp)) {
    if (r !== null && h !== null && ref[r] === hyp[h]) lastMatch[refLine[r]] = h;
  }
  return lines.map((line, index) => {
    const h = lastMatch[index];
    const shownMs = h === null ? null : hypShown[h];
    return { index, endMs: line.endMs, latencyMs: shownMs == null ? null : shownMs - line.endMs };
  });
}

// chrF (β = 2): F-мера по символьным n-граммам 1…6 без пробелов, по всему тексту сразу.
export function chrF(reference, hypothesis, maxN = 6, beta = 2) {
  const clean = (text) => text.normalize('NFC').toLocaleLowerCase().replaceAll('ё', 'е').replace(/\s+/g, '');
  const ref = clean(reference), hyp = clean(hypothesis);
  const grams = (text, n) => {
    const map = new Map();
    for (let i = 0; i + n <= text.length; i++) map.set(text.slice(i, i + n), (map.get(text.slice(i, i + n)) ?? 0) + 1);
    return map;
  };
  let precision = 0, recall = 0, orders = 0;
  for (let n = 1; n <= maxN; n++) {
    const r = grams(ref, n), h = grams(hyp, n);
    const refTotal = ref.length - n + 1, hypTotal = hyp.length - n + 1;
    if (refTotal <= 0 || hypTotal <= 0) continue;
    let common = 0;
    for (const [gram, count] of h) common += Math.min(count, r.get(gram) ?? 0);
    precision += common / hypTotal;
    recall += common / refTotal;
    orders++;
  }
  if (!orders) return 0;
  precision /= orders; recall /= orders;
  if (!precision && !recall) return 0;
  return 100 * (1 + beta ** 2) * precision * recall / (beta ** 2 * precision + recall);
}

export function scoreRun({ lines, phrases }) {
  const latencies = lineLatencies(lines, phrases);
  const measured = latencies.filter((line) => line.latencyMs != null).map((line) => line.latencyMs);
  return {
    recognition: wordErrorRate(lines.map((line) => line.text).join(' '), phrases.map((phrase) => phrase.source).join(' ')),
    latency: { lines: lines.length, measured: measured.length, p50Ms: percentile(measured, 0.5), p95Ms: percentile(measured, 0.95), maxMs: percentile(measured, 1) },
    translation: { chrF: chrF(lines.map((line) => line.ref).join(' '), phrases.map((phrase) => phrase.translation ?? '').join(' ')) },
    perLine: latencies,
  };
}
