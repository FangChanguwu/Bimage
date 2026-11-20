import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createApp } from '../dist/app.js';
import { setupAccount } from './account-fixture.js';

async function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bimage-history-'));
  const service = await createApp({ dir, worker: false });
  const server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(r => server.close(r)); await service.close(); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const { identity, headers } = await setupAccount(base, dir);
  const get = async query => fetch(base + '/api/jobs' + query, { headers });
  const job = (id, prompt = id, owner = identity.id, status = 'succeeded') => {
    service.db.prepare('INSERT INTO jobs(id,owner,form,status,created) VALUES(?,?,?,?,?)').run(id, owner, JSON.stringify({ prompt, references: [] }), status, '2026-01-01T00:00:00Z');
    service.db.prepare('INSERT INTO tasks(id,job,status) VALUES(?,?,?)').run('t-' + id, id, status);
  };
  return { get, job, db: service.db };
}

test('history uses bounded stable keyset pages while legacy clients retain arrays', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 65; i++) f.job(String(i).padStart(3, '0'));
  f.job('foreign', 'private', 'other');
  const first = await (await f.get('?limit=30')).json();
  assert.equal(first.items?.length, 30);
  assert.equal(first.total, 65);
  assert.equal(first.items[0].id, '064');
  assert.ok(first.nextCursor);
  f.job('999');
  const second = await (await f.get('?limit=30&cursor=' + first.nextCursor)).json();
  assert.equal(second.items.length, 30);
  assert.equal(new Set([...first.items, ...second.items].map(j => j.id)).size, 60);
  const last = await (await f.get('?limit=30&cursor=' + second.nextCursor)).json();
  assert.equal(last.items.length, 5);
  assert.equal(last.nextCursor, null);
  assert.equal((await (await f.get('')).json()).length, 66);
});

test('full multiline search is literal, case insensitive and owner scoped; busy is independent', async t => {
  const f = await fixture(t);
  f.job('found', 'prefix\nMiXeD %_\\ literal\n' + 'x'.repeat(15000));
  f.job('different', 'prefix\nmixed abc literal');
  f.job('foreign', 'prefix\nMiXeD %_\\ literal', 'other');
  f.job('active', 'not in search', undefined, 'queued');
  const result = await (await f.get('?q=' + encodeURIComponent('MIXED %_\\ literal'))).json();
  assert.deepEqual(result.items.map(j => j.id), ['found']);
  assert.equal(result.total, 1);
  assert.equal(result.active, true);
  assert.equal(result.activeCount, 1);
  assert.equal((await (await f.get('?q=' + 'x'.repeat(500))).json()).total, 1);
  for (const query of ['?cursor=garbage', '?cursor=', '?cursor=' + Buffer.from(JSON.stringify({ created: 'not-a-date', id: 'x' })).toString('base64url'), '?limit=0', '?limit=101', '?q=a&q=b']) assert.equal((await f.get(query)).status, 400, query);
});

test('unchanged polls use a JSON token and detect task changes outside the first page', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 35; i++) f.job(String(i).padStart(3, '0'));
  const first = await (await f.get('?limit=30')).json();
  assert.equal(typeof first.token, 'string');
  const read = await f.get('?limit=30');
  assert.equal(read.headers.get('cache-control'), 'private, no-store');
  assert.equal(read.headers.get('etag'), null);
  const unchanged = await (await f.get('?limit=30&token=' + first.token)).json();
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.items, undefined);
  f.db.prepare("UPDATE tasks SET status='queued' WHERE job='000'").run();
  const changed = await (await f.get('?limit=30&token=' + first.token)).json();
  assert.equal(changed.unchanged, false);
  assert.equal(changed.active, true);
  assert.equal(changed.items.length, 30);
  assert.notEqual(changed.token, first.token);
});

test('bounded known-id validation confirms deletions, never page absence or another tenant', async t => {
  const f = await fixture(t);
  f.job('kept'); f.job('deleted'); f.job('foreign', 'private', 'other');
  const first = await (await f.get('?limit=30')).json();
  f.db.prepare("DELETE FROM tasks WHERE job='deleted'").run();
  f.db.prepare("DELETE FROM jobs WHERE id='deleted'").run();
  const query = '?limit=30&known=' + encodeURIComponent(JSON.stringify(['kept', 'deleted', 'foreign']));
  const result = await (await f.get(query)).json();
  assert.deepEqual(result.removedIds, ['deleted', 'foreign']);
  const unchangedResponse = await f.get(query + '&token=' + result.token);
  assert.equal(unchangedResponse.status, 200);
  const unchanged = await unchangedResponse.json();
  assert.equal(unchanged.unchanged, true);
  assert.deepEqual(unchanged.removedIds, ['deleted', 'foreign']);
  for (const known of ['not-json', JSON.stringify(['x'.repeat(300)]), JSON.stringify(Array(101).fill('id')), JSON.stringify([1])]) {
    assert.equal((await f.get('?known=' + encodeURIComponent(known))).status, 400);
  }
  assert.equal(typeof first.token, 'string');
});
