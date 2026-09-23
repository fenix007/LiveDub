export const wordCount = (text) => text.split(/\s+/).filter(Boolean).length;
export const joinText = (...parts) => parts.filter(Boolean).join(' ').trim();
export const speechWords = (text) => text.trim().split(/\s+/).filter(Boolean);
export const comparableWord = (word) =>
  word.normalize('NFC').toLocaleLowerCase().replaceAll('ё', 'е').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

// Отрицания и числа нельзя считать «похожими»: пропуск «не» или замена 16 на 60 меняет смысл.
export const criticalSpeechWord = (word) => /\d|^(?:не|нет|ни|без|нельзя|ничего|никто|нигде|никогда|никого|неправда|неправильно|shouldn't|cannot|can't|won't|not|no|never|fifteen|fifty|sixteen|sixty|eighteen|eighty|шестнадцать|шестьдесят|восемнадцать|восемьдесят|девятнадцать|девяносто|девятьсот)$/u.test(word);

// Слова совпадают точно или отличаются только окончанием (готов/готовы).
export function sameSpeechWord(a, b) {
  const left = comparableWord(a), right = comparableWord(b);
  if (left === right) return true;
  if (criticalSpeechWord(left) || criticalSpeechWord(right)) return false;
  const prefix = Math.max(4, Math.max(left.length, right.length) - 3);
  return Math.abs(left.length - right.length) <= 3 && left.length >= 5 && right.length >= 5 &&
    left.slice(0, prefix) === right.slice(0, prefix);
}

export function commonSpeechWords(previous, current) {
  let count = 0;
  while (count < previous.length && count < current.length && sameSpeechWord(previous[count], current[count])) count++;
  return current.slice(0, count);
}

// С какого слова финала продолжить, если уже сказанное начало разошлось с финалом.
export function resumeFinalSpeech(committed, finalWords) {
  // Совпадение одного короткого слова ненадёжно: можно пропустить «не» или число.
  const critical = (words) => words.map(comparableWord).filter(criticalSpeechWord).join('|');
  for (let span = Math.min(3, committed.length); span >= 2; span--) {
    for (let start = Math.max(0, committed.length - span - 2);
      start + span <= finalWords.length && start <= committed.length - span + 2; start++) {
      if (committed.slice(-span).every((word, i) => sameSpeechWord(word, finalWords[start + i])) &&
          critical(committed.slice(0, -span)) === critical(finalWords.slice(0, start))) {
        return start + span;
      }
    }
  }
  if (committed.length === 1 && comparableWord(committed[0]).length >= 5 &&
      sameSpeechWord(committed[0], finalWords[0] || '')) return 1;
  return 0; // нет надёжного стыка: финал будет произнесён как исправление
}

// Берём только слова, которые совпали в двух последовательных interim-гипотезах.
export function stableWords(previous, current) {
  const a = previous.trim().split(/\s+/), b = current.trim().split(/\s+/);
  let count = 0;
  while (count < a.length && count < b.length &&
         a[count].toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') ===
         b[count].toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')) count++;
  return b.slice(0, count).join(' ');
}
