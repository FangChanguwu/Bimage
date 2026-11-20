import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../backend/dist/app.js';
import { createAccount, fixturePassword, request, setupAccount } from './account-fixture.js';

test('account authentication, tenant isolation and password hashing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bimage-auth-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s = await createApp({ dir, worker: false });
  const server = s.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await request(base, '/api/me')).status, 401);
    const admin = await setupAccount(base, dir);
    const me = await request(base, '/api/me', { headers: { cookie: admin.headers.cookie } });
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), admin.identity);
    assert.equal(admin.identity.role, 'admin');

    const a = await createAccount(base, admin.headers, { email: 'a@example.test' });
    const b = await createAccount(base, admin.headers, { email: 'b@example.test' });
    assert.equal(a.identity.id, a.user.id);
    assert.notEqual(a.identity.id, b.identity.id);
    assert.equal((await request(base, '/api/admin/users', { headers: a.headers })).status, 403);
    const provider = await request(base, '/api/providers', {
      headers: a.headers,
      body: { name: 'Private', baseUrl: 'https://api.openai.com/v1', apiKey: 'fixture-provider-secret', kind: 'image' },
    });
    assert.equal(provider.status, 200);
    const { id } = await provider.json();
    assert.deepEqual(await (await request(base, '/api/providers', { headers: b.headers })).json(), []);
    const own = await (await request(base, '/api/providers', { headers: a.headers })).json();
    assert.equal(own[0].id, id);
    assert.ok(!JSON.stringify(own).includes('fixture-provider-secret'));
    assert.equal((await request(base, `/api/providers/${id}`, { method: 'DELETE', headers: b.headers })).status, 404);

    const rows = s.db.prepare('SELECT passwordHash FROM accounts').all();
    assert.equal(rows.length, 3);
    assert.equal(new Set(rows.map(row => row.passwordHash)).size, 3, 'the same password is salted per account');
    for (const { passwordHash } of rows) assert.notEqual(passwordHash, fixturePassword);
    const listing = await request(base, '/api/admin/users', { headers: admin.headers });
    assert.equal(listing.status, 200);
    for (const account of (await listing.json()).users) {
      assert.deepEqual(Object.keys(account).sort(), ['concurrency', 'email', 'id', 'name', 'role']);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    await s.close();
  }
});
