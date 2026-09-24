// Доступ к серверу по токенам. На VPS сервер распознаёт речь и переводит за счёт
// ваших ключей, поэтому каждый компьютер получает свой именованный токен:
//   LIVEDUB_STT_TOKENS=laptop:<токен>,work:<токен>
// Один токен можно отозвать, не трогая остальные, а в логе видно, кто подключался.
// Токен передаётся в Sec-WebSocket-Protocol (браузер не даёт ставить заголовки
// WebSocket), поэтому допустимы только символы токена HTTP; openssl rand -hex 32 подходит.
import { createHash, timingSafeEqual } from 'node:crypto';

export const TOKEN_PROTOCOL = 'livedub';
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{32,256}$/;
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

// «имя:токен,имя:токен» и старый одиночный LIVEDUB_STT_TOKEN (имя default).
export function parseTokens(list = '', single = '') {
  const entries = [];
  for (const item of list.split(',').map((part) => part.trim()).filter(Boolean)) {
    const at = item.indexOf(':');
    const name = at > 0 ? item.slice(0, at) : '';
    const token = at > 0 ? item.slice(at + 1) : '';
    if (!NAME_PATTERN.test(name)) throw new Error(`LIVEDUB_STT_TOKENS: неверное имя токена «${name || item.slice(0, 8)}…»`);
    if (!TOKEN_PATTERN.test(token)) throw new Error(`LIVEDUB_STT_TOKENS: токен «${name}» — от 32 символов, только латиница, цифры и . _ ~ -`);
    if (entries.some((entry) => entry.name === name)) throw new Error(`LIVEDUB_STT_TOKENS: имя «${name}» повторяется`);
    entries.push({ name, token });
  }
  if (single) {
    if (!TOKEN_PATTERN.test(single)) throw new Error('LIVEDUB_STT_TOKEN — от 32 символов, только латиница, цифры и . _ ~ -');
    entries.push({ name: 'default', token: single });
  }
  return entries;
}

// Сравнение по SHA-256 в постоянном времени: длина и содержимое токена не утекают через тайминг.
const digest = (value) => createHash('sha256').update(String(value)).digest();

export function createAuthorizer(entries, { required = false } = {}) {
  const hashed = entries.map(({ name, token }) => ({ name, hash: digest(token) }));
  return {
    // Нужна ли проверка: токены заданы или сервер обязан их требовать (продакшн).
    enabled: required || hashed.length > 0,
    // Имя токена или null.
    check(token) {
      if (!token) return null;
      const candidate = digest(token);
      let match = null;
      for (const entry of hashed) if (timingSafeEqual(entry.hash, candidate) && !match) match = entry.name;
      return match;
    },
  };
}

// Sec-WebSocket-Protocol: "livedub, <токен>" → токен.
export function tokenFromProtocols(header = '') {
  const protocols = header.split(',').map((part) => part.trim()).filter(Boolean);
  return protocols[0] === TOKEN_PROTOCOL && protocols.length === 2 ? protocols[1] : '';
}

// Authorization: Bearer <токен> → токен.
export const tokenFromAuthorization = (header = '') => /^Bearer\s+(\S+)$/i.exec(header)?.[1] ?? '';

export const isValidToken = (token) => TOKEN_PATTERN.test(token);
