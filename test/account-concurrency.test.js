import { test } from 'node:test';
import { loopbackProvider } from './loopback-provider.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as wait } from 'node:timers/promises';
import { Store } from '../backend/dist/db.js';
import { Queue } from '../backend/dist/queue.js';
import { Assets } from '../backend/dist/assets.js';
import { Providers } from '../backend/dist/providers.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=';
async function eventually(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await wait(30);
  }
  assert.ok(check(), 'queue did not reach the expected state');
}

test('the worker fills global capacity without exceeding each account limit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bimage-account-queue-'));
  const store = new Store(dir);
  // Exercise scheduling against the real account schema; password login is tested separately.
  for (const [id, limit] of [['a', 1], ['b', 3]]) {
    store.run('INSERT INTO accounts(id,name,role,concurrency,email,passwordHash) VALUES(?,?,?,?,?,?)',
      id, id, 'user', limit, `${id}@example.test`, 'not-a-login-fixture');
  }
  const started = [];
  const held = new Map();
  const mock = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { prompt, n } = JSON.parse(body);
    assert.equal(n, 1);
    started.push(prompt);
    held.set(prompt, () => res.end(JSON.stringify({ data: [{ b64_json: png }] })));
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const enqueue = (owner, prompts) => {
    for (const prompt of prompts) {
      const form = { providerId: 'shared', model: 'test', prompt, autoSize: true, quality: 'auto', output_format: 'png', references: [] };
      store.run("INSERT INTO jobs(id,owner,form,status,created) VALUES(?,?,?,'queued',?)", prompt, owner, JSON.stringify(form), new Date().toISOString());
      store.run("INSERT INTO tasks(id,job,status) VALUES(?,?,'queued')", prompt, prompt);
    }
  };
  store.run("INSERT INTO providers(id,owner,name,baseUrl,kind,allowPrivate,shared) VALUES('shared','a','fixture',?,'image',1,1)", `http://127.0.0.1:${mock.address().port}/v1`);
  enqueue('not-activated', ['legacy']);
  enqueue('a', ['a1', 'a2', 'a3']);
  enqueue('b', ['b1', 'b2', 'b3', 'b4']);
  const queue = new Queue(store, new Providers(store, loopbackProvider(mock)), new Assets(store), 3);
  try {
    queue.start();
    await eventually(() => started.length >= 3);
    assert.deepEqual([...started].sort(), ['a1', 'b1', 'b2']);
    await wait(230);
    assert.equal(started.length, 3);
    held.get('b1')();
    await eventually(() => started.includes('b3'));
    assert.ok(!started.includes('a2'));
    held.get('a1')();
    await eventually(() => started.includes('a2'));
    assert.ok(!started.includes('a3'));
    for (const id of ['a2', 'b2', 'b3']) held.get(id)();
    await eventually(() => started.includes('a3') && started.includes('b4'));
    for (const id of ['a3', 'b4']) held.get(id)();
    await eventually(() => store.get("SELECT count(*) AS count FROM tasks WHERE status='succeeded'").count === 7);
  } finally {
    await queue.shutdown(() => store.db.close());
    mock.closeAllConnections();
    await new Promise(resolve => mock.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
