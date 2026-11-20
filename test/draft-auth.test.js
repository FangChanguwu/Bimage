import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../backend/dist/app.js';
import { createAccount, request, setupAccount } from './account-fixture.js';

test('member cannot grant draft private access and provider secrets never escape model discovery', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'draft-auth-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s = await createApp({ dir, worker: false });
  const server = s.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const admin = await setupAccount(base, dir);
    const member = await createAccount(base, admin.headers);
    const response = await request(base, '/api/providers/models', {
      headers: member.headers,
      body: { baseUrl: 'http://127.0.0.1/v1', apiKey: 'private-test', allowPrivate: true },
    });
    assert.equal(response.status, 400);
    assert.ok(!(await response.text()).includes('private-test'));
  } finally {
    await new Promise(resolve => server.close(resolve));
    await s.close();
  }
});
