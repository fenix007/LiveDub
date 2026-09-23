// Скользящее окно задержек перевода по движкам. Тексты реплик не сохраняются.
export function createLatencyStats(window = 50) {
  const samples = new Map();

  function record(engine, kind, durationMs, ok) {
    const list = samples.get(engine) ?? [];
    list.push({ kind, durationMs, ok });
    if (list.length > window) list.shift();
    samples.set(engine, list);
  }

  function summarize(list) {
    const durations = list.map((sample) => sample.durationMs).sort((a, b) => a - b);
    const percentile = (p) => durations.length ? durations[Math.ceil(durations.length * p) - 1] : null;
    return { count: list.length, errors: list.filter((sample) => !sample.ok).length, p50Ms: percentile(0.5), p95Ms: percentile(0.95) };
  }

  function summary(engine) {
    const list = samples.get(engine) ?? [];
    return {
      all: summarize(list),
      draft: summarize(list.filter((sample) => sample.kind === 'draft')),
      final: summarize(list.filter((sample) => sample.kind === 'final')),
    };
  }

  return { record, summary };
}
