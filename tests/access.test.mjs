import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { test } from 'node:test';
import WebSocket from 'ws';
import { createAuthorizer, parseTokens, tokenFromAuthorization, tokenFromProtocols } from '../access.js';

const LAPTOP = 'a'.repeat(64), WORK = 'b'.repeat(64);

test('named tokens are parsed and validated', () => {
  assert.deepEqual(parseTokens(`laptop:${LAPTOP}, work:${WORK}`),
    [{ name: 'laptop', token: LAPTOP }, { name: 'work', token: WORK }]);
  assert.deepEqual(parseTokens('', LAPTOP), [{ name: 'default', token: LAPTOP }]);
  assert.deepEqual(parseTokens(''), []);
  assert.throws(() => parseTokens('laptop:short'), /от 32 символов/);
  assert.throws(() => parseTokens(`${LAPTOP}`), /неверное имя/);
  assert.throws(() => parseTokens(`x:${LAPTOP},x:${WORK}`), /повторяется/);
  assert.throws(() => parseTokens(`bad name:${LAPTOP}`), /неверное имя/);
});

test('authorizer returns the token name and is enabled when tokens are required', () => {
  const access = createAuthorizer(parseTokens(`laptop:${LAPTOP},work:${WORK}`));
  assert.equal(access.enabled, true);
  assert.equal(access.check(WORK), 'work');
  assert.equal(access.check('b'.repeat(63)), null);
  assert.equal(access.check(''), null);
  assert.equal(createAuthorizer([]).enabled, false);
  const locked = createAuthorizer([], { required: true });
  assert.equal(locked.enabled, true);
  assert.equal(locked.check(LAPTOP), null);
});

test('token is read from the WebSocket subprotocol and the bearer header', () => {
  assert.equal(tokenFromProtocols(`livedub, ${LAPTOP}`), LAPTOP);
  assert.equal(tokenFromProtocols(LAPTOP), '');
  assert.equal(tokenFromProtocols(`other, ${LAPTOP}`), '');
  assert.equal(tokenFromAuthorization(`Bearer ${LAPTOP}`), LAPTOP);
  assert.equal(tokenFromAuthorization(LAPTOP), '');
});

const freePort = () => new Promise((resolve) => {
  const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

async function startServer(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [new URL('../server.js', import.meta.url).pathname], {
    env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', YANDEX_SPEECHKIT_API_KEY: 'test-key', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  for (let i = 0; i < 100 && !log.includes('Открой http'); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match(log, /Открой http/, log);
  return { base: `127.0.0.1:${port}`, log: () => log, stop: () => child.kill() };
}

// Результат рукопожатия: код ответа сервера или выбранный протокол после открытия.
const handshake = (base, protocols) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://${base}/api/stt/yandex?language=en&endpointing=300`, protocols);
  ws.on('unexpected-response', (req, res) => { resolve({ status: res.statusCode }); req.destroy(); });
  ws.on('open', () => { resolve({ status: 101, protocol: ws.protocol }); ws.terminate(); });
  ws.on('error', () => {});
});

test('server requires a valid named token for recognition and every /api/ route', async () => {
  const server = await startServer({ LIVEDUB_STT_TOKENS: `laptop:${LAPTOP}` });
  try {
    assert.equal((await fetch(`http://${server.base}/healthz`)).status, 200);
    assert.equal((await fetch(`http://${server.base}/api/config`)).status, 401);
    assert.equal((await fetch(`http://${server.base}/api/config`, { headers: { authorization: `Bearer ${WORK}` } })).status, 401);
    assert.equal((await fetch(`http://${server.base}/api/config`, { headers: { authorization: `Bearer ${LAPTOP}` } })).status, 200);

    assert.deepEqual(await handshake(server.base), { status: 401 });
    assert.deepEqual(await handshake(server.base, ['livedub', WORK]), { status: 401 });
    assert.deepEqual(await handshake(server.base, ['livedub', LAPTOP]), { status: 101, protocol: 'livedub' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.match(server.log(), /\[stt\] подключение: laptop/);
    assert.doesNotMatch(server.log(), new RegExp(LAPTOP), 'токен не должен попадать в журнал');
  } finally {
    server.stop();
  }
});

test('production mode without any token rejects everyone', async () => {
  const server = await startServer({ LIVEDUB_REQUIRE_TOKEN: '1' });
  try {
    assert.equal((await fetch(`http://${server.base}/api/config`)).status, 401);
    assert.deepEqual(await handshake(server.base, ['livedub', LAPTOP]), { status: 401 });
  } finally {
    server.stop();
  }
});

test('local server without tokens stays open as before', async () => {
  const server = await startServer({});
  try {
    assert.equal((await fetch(`http://${server.base}/api/config`)).status, 200);
    assert.equal((await handshake(server.base)).status, 101);
  } finally {
    server.stop();
  }
});
