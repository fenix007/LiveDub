import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('records secret-free Gemini latency by draft and final request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tab-stats-'));
  const worker = join(dir, 'fake-worker');
  await writeFile(worker, `#!/usr/bin/env python3
import json, sys, time
print(json.dumps({'ready': True}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    time.sleep(0.02)
    print(json.dumps({'id': request['id'], 'translation': 'перевод', 'queueMs': 2, 'gatewayMs': 20, 'model': 'test-model', 'keyLabel': 'key-1'}), flush=True)
`);
  await chmod(worker, 0o700);
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), DEEPGRAM_API_KEY: 'test', GEMINI_API_KEYS: 'secret-test-key', GEMINI_PYTHON: worker, GEMINI_DRAFT_RPM: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(`http://127.0.0.1:${port}/api/stats`); if (r.ok) { ready = true; break; } } catch {}
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.ok(ready, 'server started');
    for (const kind of ['draft', 'final']) {
      const response = await fetch(`http://127.0.0.1:${port}/api/translate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'gemini', kind, text: 'private phrase', context: [], source: 'en', target: 'ru' }),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).translation, 'перевод');
    }
    const response = await fetch(`http://127.0.0.1:${port}/api/stats`);
    const { gemini } = await response.json();
    assert.equal(gemini.all.count, 2);
    assert.equal(gemini.draft.count, 1);
    assert.equal(gemini.final.count, 1);
    assert.equal(gemini.pending, 0);
    assert.ok(gemini.all.p95Ms >= 20);
    assert.equal(gemini.recent[0].keyLabel, 'key-1');
    assert.equal(gemini.recent[0].gatewayMs, 20);
    assert.ok(!JSON.stringify(gemini).includes('private phrase'));
    assert.ok(!JSON.stringify(gemini).includes('secret-test-key'));
    const skipped = await fetch(`http://127.0.0.1:${port}/api/translate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'gemini', kind: 'draft', text: 'another phrase', context: [], source: 'en', target: 'ru' }),
    });
    assert.equal(skipped.status, 429);
    const latest = await fetch(`http://127.0.0.1:${port}/api/stats`).then((r) => r.json());
    assert.equal(latest.gemini.skippedDrafts, 1);
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
