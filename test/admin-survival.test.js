import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../backend/dist/app.js';
import { createAccount, fixturePassword, request, setupAccount, signIn } from './account-fixture.js';

async function withApi(t, run) {
  const dir = mkdtempSync(join(tmpdir(), 'bimage-sessions-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s = await createApp({ dir, worker: false });
  const server = s.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ db: s.db, base, dir });
  } finally {
    await new Promise(resolve => server.close(resolve));
    await s.close();
  }
}

test('switching cookie identities retires the replaced session without changing either workspace', (t) => withApi(t, async ({ base, dir }) => {
  const admin = await setupAccount(base, dir);
  const member = await createAccount(base, admin.headers);
  const secondAdmin = await createAccount(base, admin.headers, { email: 'backup@example.test', role: 'admin' });
  assert.equal(secondAdmin.identity.role, 'admin');
  assert.equal((await request(base, '/api/admin/users', { headers: secondAdmin.headers })).status, 200);
  const payload = { email: 'unauthorized@example.test', name: '', password: fixturePassword, role: 'admin', concurrency: 1 };
  assert.equal((await request(base, '/api/admin/users', { headers: member.headers, body: payload })).status, 403);

  const settings = { form: { prompt: 'admin draft' } };
  assert.equal((await request(base, '/api/settings', { method: 'PUT', headers: admin.headers, body: settings })).status, 200);
  const credentials = { login: member.identity.email, password: 'wrong fixture password' };
  const login = await request(base, '/api/login', { headers: { cookie: admin.headers.cookie }, body: credentials });
  assert.equal(login.status, 401);
  assert.equal((await request(base, '/api/me', { headers: admin.headers })).status, 200, 'failed login leaves the session intact');

  const switched = await request(base, '/api/login', {
    headers: { cookie: admin.headers.cookie }, body: { ...credentials, password: fixturePassword },
  });
  assert.equal(switched.status, 200);
  const setCookie = switched.headers.get('set-cookie');
  assert.match(setCookie, /; HttpOnly\b/i);
  assert.match(setCookie, /; SameSite=Strict\b/i);
  const cookie = setCookie.split(';')[0];
  const identity = await switched.json();
  assert.equal(identity.id, member.identity.id);
  assert.notEqual(cookie, admin.headers.cookie);
  assert.notEqual(identity.csrf, admin.identity.csrf);
  assert.equal((await request(base, '/api/me', { headers: admin.headers })).status, 401);
  assert.equal((await request(base, '/api/settings', {
    method: 'PUT', headers: { cookie, 'x-csrf-token': admin.identity.csrf }, body: settings,
  })).status, 403);
  assert.deepEqual(await (await request(base, '/api/settings', { headers: { cookie } })).json(), {});

  const restoredAdmin = await signIn(base, 'admin');
  assert.equal(restoredAdmin.identity.id, admin.identity.id);
  assert.deepEqual(await (await request(base, '/api/settings', { headers: restoredAdmin.headers })).json(), settings);
}));

test('expired logout clears cookie and server session; hostile origin is rejected', (t) => withApi(t, async ({ base, dir, db }) => {
  const admin = await setupAccount(base, dir);
  assert.equal((await request(base, '/api/logout', {
    method: 'POST', headers: { ...admin.headers, origin: 'https://evil.invalid' },
  })).status, 403);
  assert.equal((await request(base, '/api/me', { headers: admin.headers })).status, 200);
  db.prepare('UPDATE account_sessions SET expires=0 WHERE owner=?').run(admin.identity.id);
  assert.equal((await request(base, '/api/me', { headers: admin.headers })).status, 401);
  assert.equal((await request(base, '/api/logout', {
    method: 'POST', headers: { cookie: admin.headers.cookie },
  })).status, 403);
  assert.equal(db.prepare('SELECT count(*) AS n FROM account_sessions').get().n, 1);
  const response = await request(base, '/api/logout', { method: 'POST', headers: admin.headers });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /^canvas_session=;.*Expires=Thu, 01 Jan 1970/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM account_sessions').get().n, 0);
}));
