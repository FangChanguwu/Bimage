import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../backend/dist/app.js';
import { fixturePassword, request, setupAccount, signIn } from './account-fixture.js';

function legacyFixture(t, admins) {
  const dir = mkdtempSync(join(tmpdir(), 'bimage-migration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'studio.sqlite');
  const legacyKey = 'fixture-only legacy bootstrap';
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      CREATE TABLE keys(id TEXT PRIMARY KEY, hash TEXT UNIQUE, name TEXT, role TEXT, disabled INTEGER DEFAULT 0, expires TEXT);
      CREATE TABLE settings(owner TEXT PRIMARY KEY, json TEXT);
    `);
    const insert = db.prepare("INSERT INTO keys(id,hash,name,role) VALUES(?,?,?,'admin')");
    for (const [i, id] of admins.entries()) {
      const hash = createHash('sha256').update(i === 0 ? legacyKey : `${legacyKey}-${i}`).digest('hex');
      insert.run(id, hash, id);
    }
    db.prepare('INSERT INTO settings VALUES(?,?)').run(admins[0], '{"form":{"prompt":"legacy draft"}}');
  } finally {
    db.close();
  }
  return { dir, file, legacyKey };
}

async function serve(dir, run) {
  const s = await createApp({ dir, worker: false });
  const server = s.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await s.close();
  }
}

test('ambiguous legacy migration refuses startup without selecting or disabling administrators', async (t) => {
  const { dir, file } = legacyFixture(t, ['legacy-admin-a', 'legacy-admin-b']);
  await assert.rejects(() => createApp({ dir, worker: false }), /Multiple legacy administrators/);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare("SELECT id FROM keys WHERE role='admin' AND disabled=0 ORDER BY id").all();
    assert.deepEqual(rows.map(row => row.id), ['legacy-admin-a', 'legacy-admin-b']);
  } finally {
    db.close();
  }
});

test('installed admin password and workspace survive restart, while the legacy key stays invalid', async (t) => {
  const id = 'legacy-admin';
  const { dir, legacyKey } = legacyFixture(t, [id]);
  await serve(dir, async base => {
    const account = await setupAccount(base, dir);
    assert.equal(account.identity.id, id);
  });
  await serve(dir, async base => {
    const setupStatus = await request(base, '/api/setup');
    assert.deepEqual(await setupStatus.json(), { required: false });
    assert.equal((await request(base, '/api/login', { body: { key: legacyKey } })).status, 401);
    assert.equal((await request(base, '/api/login', { body: { login: 'admin', password: legacyKey } })).status, 401);
    assert.equal((await request(base, '/api/me', { headers: { authorization: `Bearer ${legacyKey}` } })).status, 401);
    const account = await signIn(base, 'admin', fixturePassword);
    assert.equal(account.identity.id, id);
    const settings = await request(base, '/api/settings', { headers: account.headers });
    assert.equal(settings.status, 200);
    assert.deepEqual(await settings.json(), { form: { prompt: 'legacy draft' } });
  });
});
