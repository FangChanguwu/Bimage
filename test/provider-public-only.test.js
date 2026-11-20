import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../backend/dist/app.js';
import { setupAccount, request } from './account-fixture.js';

async function withApp(run) {
  const dir = mkdtempSync(join(tmpdir(), 'bimage-provider-network-'));
  const service = await createApp({ dir });
  const server = service.app.listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const admin = await setupAccount(base, dir);
    await run(service.db, admin, (path, options = {}) => request(base, '/api' + path, { headers: admin.headers, ...options }));
  } finally {
    await new Promise(resolve => server.close(resolve));
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('administrator provider writes only accept public addresses; the legacy private option is not honored', async () => {
  await withApp(async (db, admin, call) => {
    const legacy = { name: 'local-only', baseUrl: 'http://127.0.0.1:9/v1', allowPrivate: true };
    const response = await call('/providers', { body: legacy });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /不允许.*私网/);
    assert.equal(db.prepare('SELECT count(*) AS total FROM providers').get().total, 0);

    const good = await call('/providers', { body: { ...legacy, baseUrl: 'https://1.1.1.1/v1' } });
    assert.equal(good.status, 200);
    const saved = await good.json();
    assert.ok(!Object.hasOwn(saved, 'allowPrivate'));
    const edit = await call('/providers/' + saved.id, { method: 'PATCH', body: legacy });
    assert.equal(edit.status, 400);
    assert.equal(db.prepare('SELECT baseUrl FROM providers WHERE owner=?').get(admin.identity.id).baseUrl, 'https://1.1.1.1/v1');
    const discovery = await call('/providers/models', { body: legacy });
    assert.equal(discovery.status, 400);
    assert.match((await discovery.json()).error, /不允许.*私网/);
  });
});

test('existing stored private providers cannot discover, rewrite, or send queued image requests', async () => {
  await withApp(async (db, admin, call) => {
    db.prepare(`INSERT INTO providers(id,owner,name,baseUrl,apiKey,kind,allowPrivate,models) VALUES(?,?,?,?,?,?,?,?)`).run(
      'legacy', admin.identity.id, 'legacy', 'http://127.0.0.1:9/v1', 'fixture-only', 'mixed', 1, '[]',
    );
    for (const [path, options] of [
      ['/providers/legacy/models', {}],
      ['/providers/legacy/models', { body: {} }],
      ['/rewrite', { body: { providerId: 'legacy', model: 'fixture-text', prompt: 'cat' } }],
    ]) {
      const response = await call(path, options);
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /不允许.*私网/);
    }
    const job = await call('/jobs', { body: { providerId: 'legacy', model: 'fixture-image', prompt: 'cat', count: 1, autoSize: true, quality: 'auto', output_format: 'png', references: [] } });
    assert.equal(job.status, 200);
    const { id } = await job.json();
    let task;
    for (let attempt = 0; attempt < 30; attempt++) {
      task = db.prepare('SELECT status, error FROM tasks WHERE job=?').get(id);
      if (task?.status === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(task?.status, 'failed');
    assert.match(task?.error ?? '', /不允许.*私网/);
  });
});
