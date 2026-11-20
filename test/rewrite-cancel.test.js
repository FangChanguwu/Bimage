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

test('text request disconnect cancels upstream rather than completing an old session', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bimage-rewrite-cancel-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seen = Promise.withResolvers();
  const ended = Promise.withResolvers();
  const mock = createServer((req, res) => {
    req.resume();
    res.once('close', ended.resolve);
    seen.resolve();
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const s = await createApp({ dir, worker: false, providerNetwork: loopbackProvider(mock) });
  const server = s.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const controller = new AbortController();
  const timers = new AbortController();
  const timeout = (message) => delay(3000, undefined, { signal: timers.signal }).then(() => assert.fail(message));
  try {
    const { headers } = await setupAccount(base, dir);
    const created = await request(base, '/api/providers', {
      headers, body: { name: 'mock', baseUrl: `http://127.0.0.1:${mock.address().port}`, apiKey: 'mock', allowPrivate: true },
    });
    assert.equal(created.status, 200);
    const provider = await created.json();
    const pending = fetch(base + '/api/rewrite', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: provider.id, model: 'vision', prompt: 'test' }),
      signal: controller.signal,
    }).then(response => ({ response }), error => ({ error }));
    await Promise.race([
      seen.promise,
      pending.then(({ response, error }) => assert.fail(`rewrite ended before reaching upstream: ${response?.status ?? error}`)),
      timeout('rewrite never reached upstream'),
    ]);
    controller.abort();
    assert.equal((await pending).error?.name, 'AbortError');
    await Promise.race([ended.promise, timeout('upstream not aborted')]);
  } finally {
    timers.abort();
    controller.abort();
    mock.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await s.close();
    await new Promise(resolve => mock.close(resolve));
  }
});
