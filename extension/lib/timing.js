// Задержки по этапам считаются по «аудиокурсорам», как советует Deepgram:
// сколько секунд звука уже отправлено против того, докуда дошла расшифровка.
// Звук вкладки идёт в реальном времени, поэтому разница — это отставание в секундах.
export const PCM_BYTES_PER_SECOND = 16000 * 2; // 16 кГц, 16 бит, моно

export function createAudioClock(bytesPerSecond = PCM_BYTES_PER_SECOND) {
  let sentBytes = 0;
  return {
    add(bytes) { sentBytes += bytes; },
    seconds: () => sentBytes / bytesPerSecond,
  };
}

// Докуда в звуке дошёл этот ответ Deepgram.
export const transcriptCursor = (msg) => (msg.start ?? 0) + (msg.duration ?? 0);

// Конец последнего распознанного слова; без слов — конец сегмента.
export function lastWordEnd(msg) {
  const words = msg.channel?.alternatives?.[0]?.words;
  return words?.length ? words.at(-1).end : transcriptCursor(msg);
}

export const lagMs = (audioSeconds, transcriptSeconds) => Math.max(0, (audioSeconds - transcriptSeconds) * 1000);
