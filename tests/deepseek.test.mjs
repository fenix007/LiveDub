import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { test } from 'node:test';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

test('DeepSeek translation disables thinking and records secret-free latency', async () => {
  const requests = [];
  const upstream = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
    if (requests.length === 3) await new Promise((resolve) => setTimeout(resolve, 300));
    res.writeHead(requests.length === 1 ? 200 : 503, { 'content-type': 'application/json' });
    res.end(requests.length === 1 ? JSON.stringify({ model: 'served-model', choices: [{ message: { content: 'Привет' } }] }) : '{}');
  });
  const upstreamPort = await listen(upstream);
  const probe = createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, PORT: String(port), DEEPGRAM_API_KEY: 'test',
      DEEPSEEK_API_KEY: 'secret-test-key', DEEPSEEK_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      DEEPSEEK_TIMEOUT_MS: '100',
      GEMINI_API_KEYS: '', GEMINI_API_KEY: '', LLM_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const root = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${root}/api/config`)).ok) { ready = true; break; } } catch {}
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.ok(ready, 'server started');
    const config = await fetch(`${root}/api/config`).then((r) => r.json());
    assert.equal(config.deepseek, true);
    assert.equal(config.deepseekModel, 'deepseek-flash');
    const translate = () => fetch(`${root}/api/translate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'deepseek', kind: 'final', text: 'private phrase', context: [], source: 'en', target: 'ru' }),
    });
    const first = await translate();
    assert.equal(first.status, 200);
    assert.equal((await first.json()).translation, 'Привет');
    assert.equal(requests[0].path, '/chat/completions');
    assert.equal(requests[0].auth, 'Bearer secret-test-key');
    assert.equal(requests[0].body.model, 'deepseek-flash');
    assert.deepEqual(requests[0].body.thinking, { type: 'disabled' });
    assert.equal(requests[0].body.max_tokens, 256);
    assert.ok(!('max_completion_tokens' in requests[0].body));
    assert.ok(!('reasoning_effort' in requests[0].body));
    const second = await translate();
    assert.equal(second.status, 500);
    assert.equal((await second.json()).error, 'DeepSeek HTTP 503');
    const third = await translate();
    assert.equal(third.status, 500);
    assert.equal((await third.json()).error, 'Таймаут DeepSeek (100 мс)');
    const { deepseek } = await fetch(`${root}/api/stats`).then((r) => r.json());
    assert.equal(deepseek.all.count, 3);
    assert.equal(deepseek.final.count, 3);
    assert.equal(deepseek.all.errors, 2);
    assert.equal(deepseek.recent[0].errorType, 'Timeout');
    assert.equal(deepseek.recent[2].model, 'served-model');
    assert.equal(deepseek.pending, 0);
    assert.ok(!JSON.stringify(deepseek).includes('private phrase'));
    assert.ok(!JSON.stringify(deepseek).includes('secret-test-key'));
  } finally {
    child.kill();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
