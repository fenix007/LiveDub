export const wordCount = (text) => text.split(/\s+/).filter(Boolean).length;
export const joinText = (...parts) => parts.filter(Boolean).join(' ').trim();
export const speechWords = (text) => text.trim().split(/\s+/).filter(Boolean);
export const comparableWord = (word) =>
  word.normalize('NFC').toLocaleLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

// Берём только слова, которые совпали в двух последовательных interim-гипотезах.
export function stableWords(previous, current) {
  const a = previous.trim().split(/\s+/), b = current.trim().split(/\s+/);
  let count = 0;
  while (count < a.length && count < b.length &&
         a[count].toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') ===
         b[count].toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')) count++;
  return b.slice(0, count).join(' ');
}
