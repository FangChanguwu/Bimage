import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../backend/dist/app.js';
import { request, setupAccount } from './account-fixture.js';

test('cancelling queued work retains the full job history', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bimage-cancel-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s = await createApp({ dir, worker: false });
  const server = s.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { headers } = await setupAccount(base, dir);
    const provider = await request(base, '/api/providers', {
      headers, body: { name: 'p', baseUrl: 'https://api.openai.com/v1', kind: 'image' },
    });
    assert.equal(provider.status, 200);
    const form = {
      providerId: (await provider.json()).id, model: 'image', prompt: 'full saved form',
      count: 4, size: '1024x1024', ratio: '1:1', quality: 'auto', output_format: 'png', references: [],
    };
    const queued = await request(base, '/api/jobs', { headers, body: form });
    assert.equal(queued.status, 200);
    const { id } = await queued.json();
    const response = await request(base, `/api/jobs/${id}/cancel`, { headers, body: {} });
    assert.equal(response.status, 200);
    const cancelled = await response.json();
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.tasks.filter(task => task.status === 'cancelled').length, 4);
    assert.deepEqual(cancelled.form, form);
    const [saved] = await (await request(base, '/api/jobs', { headers })).json();
    assert.equal(saved.id, id);
    assert.equal(saved.status, 'cancelled');
    assert.deepEqual(saved.form, form);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await s.close();
  }
});
