import { test } from 'node:test';
import { loopbackProvider } from './loopback-provider.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../backend/dist/app.js';
import { request, setupAccount } from './account-fixture.js';

test('persistent 429 stops after three attempts instead of charging forever', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bimage-throttle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let calls = 0;
  const mock = createServer(async (req, res) => {
    for await (const chunk of req) { /* consume the request */ }
    calls++;
    res.writeHead(429).end('{}');
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const s = await createApp({ dir, retryMs: 10, providerNetwork: loopbackProvider(mock) });
  const server = s.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { headers } = await setupAccount(base, dir);
    const call = async (pathname, body) => {
      const r = await request(base, '/api' + pathname, { headers, body });
      assert.equal(r.status, 200, pathname);
      return r.json();
    };
    const provider = await call('/providers', {
      name: 'test429', baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, kind: 'image', allowPrivate: true,
    });
    const job = await call('/jobs', {
      providerId: provider.id, model: 'image', prompt: 'test', count: 1, size: '1024x1024',
      ratio: '1:1', quality: 'auto', output_format: 'png', references: [],
    });
    let result;
    for (let i = 0; i < 100; i++) {
      result = await call(`/jobs/${job.id}`);
      if (result.status === 'failed') break;
      await delay(50);
    }
    assert.equal(result.status, 'failed');
    assert.equal(calls, 3);
    assert.equal(result.tasks[0].attempts, 3);
    await delay(300);
    assert.equal(calls, 3);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await s.close();
    await new Promise(resolve => mock.close(resolve));
  }
});
