import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../backend/dist/app.js';
import { request, setupAccount } from './account-fixture.js';

test('provider can be updated without returning its API secret', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bimage-update-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s = await createApp({ dir, worker: false });
  const server = s.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { headers } = await setupAccount(base, dir);
    const baseUrl = 'https://api.openai.com/v1';
    const created = await request(base, '/api/providers', {
      headers, body: { name: 'a', baseUrl, apiKey: 'super-private', kind: 'image' },
    });
    assert.equal(created.status, 200);
    const { id } = await created.json();
    const response = await request(base, `/api/providers/${id}`, {
      method: 'PATCH', headers, body: { name: 'updated', baseUrl, kind: 'text' },
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.name, 'updated');
    assert.equal(data.hasKey, true);
    assert.ok(!JSON.stringify(data).includes('super-private'));
  } finally {
    await new Promise(resolve => server.close(resolve));
    await s.close();
  }
});
