import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../backend/dist/app.js';
import { request, setupAccount } from './account-fixture.js';

async function withApi(dir, run) {
  const s = await createApp({ dir, worker: false });
  const server = s.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await run(s.db, `http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await s.close();
  }
}

test('restart retains queued jobs and marks inflight interrupted without repeating charge', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bimage-restart-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { headers, form, id } = await withApi(dir, async (db, base) => {
    const { headers } = await setupAccount(base, dir);
    const provider = await request(base, '/api/providers', {
      headers, body: { name: 'fixture', baseUrl: 'https://1.1.1.1/v1' },
    });
    assert.equal(provider.status, 200);
    const asset = await request(base, '/api/assets', {
      headers, body: { mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=' },
    });
    assert.equal(asset.status, 200);
    const form = {
      providerId: (await provider.json()).id, model: 'mock-image', prompt: 'saved',
      count: 2, size: '1024x1024', quality: 'auto', output_format: 'png', references: [(await asset.json()).id],
    };
    const queued = await request(base, '/api/jobs', { headers, body: form });
    assert.equal(queued.status, 200);
    const { id, tasks } = await queued.json();
    assert.equal(tasks.length, 2);
    // Simulate an abrupt exit after the worker claimed the first slot.
    db.prepare("UPDATE tasks SET status='running', attempts=1 WHERE id=?").run(tasks[0].id);
    db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(id);
    return { headers, form, id };
  });
  await withApi(dir, async (_db, base) => {
    const response = await request(base, `/api/jobs/${id}`, { headers });
    assert.equal(response.status, 200);
    const job = await response.json();
    assert.deepEqual(job.form, form);
    assert.deepEqual(job.tasks.map(task => [task.status, task.attempts]), [['interrupted', 1], ['queued', 0]]);
    const unconfirmed = await request(base, `/api/jobs/${id}/retry`, { headers, body: {} });
    assert.equal(unconfirmed.status, 400);
  });
});
