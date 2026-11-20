import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../backend/dist/app.js';
import { request, setupAccount, signIn } from './account-fixture.js';
import { serveFrontend } from './frontend-server.js';

test('same-origin proxy preserves host for CSRF logout', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bimage-proxy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s = await createApp({ dir, worker: false });
  const server = s.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const apiBase = `http://127.0.0.1:${server.address().port}`;
    const installer = await setupAccount(apiBase, dir);
    await request(apiBase, '/api/logout', { method: 'POST', headers: installer.headers });
    const front = await serveFrontend(server);
    const base = `http://127.0.0.1:${front.address().port}`;
    const { headers } = await signIn(base, 'admin');
    const out = await request(base, '/api/logout', { method: 'POST', headers: { ...headers, origin: base } });
    assert.equal(out.status, 200);
    assert.equal((await request(base, '/api/me', { headers })).status, 401);
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM account_sessions').get().n, 0);
  } finally {
    // serveFrontend wires proxy shutdown into the API server's close method.
    await new Promise(resolve => server.close(resolve));
    await s.close();
  }
});
