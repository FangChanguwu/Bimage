import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../backend/dist/app.js';
import { serveFrontend } from './frontend-server.js';

// Real cookie-sharing tabs, isolated SQLite and loopback proxy; no upstream models.
const evidence = path.resolve(process.env.BIMAGE_UI_EVIDENCE || '.impeccable/review');
mkdirSync(evidence, { recursive: true });
const scratch = mkdtempSync(path.join(tmpdir(), 'bimage-tabs-'));
const adminKey = 'tab-isolation-admin-fixture-only';
const service = await createApp({ dir: scratch, adminKey });
const server = service.app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const front = await serveFrontend(server);
const base = `http://127.0.0.1:${front.address().port}`;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const a = await context.newPage(), b = await context.newPage();
const passes = [], errors = [];
for (const page of [a, b]) {
  page.setDefaultTimeout(8000);
  page.on('pageerror', e => errors.push(e.message));
}
await context.route('**/*', route => {
  const url = route.request().url();
  if (url.startsWith(base + '/') || /^(blob:|data:)/.test(url)) return route.continue();
  errors.push('Non-local request blocked');
  return route.abort();
});
const pass = name => { passes.push(name); console.log('PASS ' + name); };
async function login(page, key) {
  await expect(page.getByLabel('访问密钥')).toBeEnabled();
  await page.getByLabel('访问密钥').fill(key);
  await page.getByRole('button', { name: '进入', exact: true }).click();
  await expect(page.getByLabel('载入工作台')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible();
}
async function keys(page) {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '密钥', exact: true }).click();
}
const screenshot = name => a.screenshot({ path: path.join(evidence, 'tab-isolation-' + name + '.png'), fullPage: true, mask: [a.locator('.secret')] });
try {
  await a.goto(base);
  await login(a, adminKey);
  await keys(a);
  await a.locator('input[name=name]').fill('隔离测试成员');
  await a.getByRole('button', { name: '创建访问密钥', exact: true }).click();
  const memberKey = await a.locator('.secret').textContent();
  await a.getByRole('button', { name: '图像工作台', exact: true }).click();
  await a.getByLabel('提示词', { exact: true }).fill('管理员私密草稿：不得留在另一个会话');
  await keys(a);
  await a.locator('input[name=name]').fill('一次性私密密钥');
  await a.getByRole('button', { name: '创建访问密钥', exact: true }).click();
  await expect(a.locator('.secret')).toBeVisible();
  await b.goto(base);
  await expect(b.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
  await screenshot('before');
  await b.getByRole('button', { name: '退出登录', exact: true }).click();
  await login(b, memberKey);
  await b.waitForTimeout(3000); // At least one visible-tab polling interval.
  await screenshot('after');
  await expect(a.locator('.app-shell'), 'tab A must unmount all admin/private state after tab B changes cookie identity').toHaveCount(0);
  await expect(a.getByRole('dialog')).toHaveCount(0);
  await expect(a.locator('.secret')).toHaveCount(0);
  await expect(a.getByLabel('访问密钥')).toBeEnabled();
  await expect(b.getByLabel('提示词', { exact: true })).toHaveValue('');
  await b.getByRole('button', { name: '设置', exact: true }).click();
  await expect(b.getByRole('tab', { name: '密钥', exact: true })).toHaveCount(0);
  pass('shared-cookie logout/account change clears stale admin UI, one-time key and private draft in other tab');

  // Cookie changes without app notices must still be detected before authenticated refreshes.
  const quiet = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await quiet.addInitScript(() => {
    Object.defineProperty(window, 'BroadcastChannel', { value: undefined });
    window.addEventListener('storage', event => event.stopImmediatePropagation(), true);
  });
  const q = await quiet.newPage();
  q.setDefaultTimeout(8000);
  q.on('pageerror', e => errors.push(e.message));
  await q.goto(base);
  await login(q, adminKey);
  await keys(q);
  let releaseJobs, jobsHeld;
  const held = new Promise(resolve => { jobsHeld = resolve; });
  const gate = new Promise(resolve => { releaseJobs = resolve; });
  await q.route('**/api/jobs', async route => {
    const response = await route.fetch();
    jobsHeld();
    await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  await held; // A real admin response is now in flight from the real backend.
  await q.evaluate(async key => {
    const response = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) });
    if (!response.ok) throw Error('Fixture member login failed');
  }, memberKey);
  releaseJobs();
  await expect(q.locator('.app-shell'), 'a late admin refresh must re-check /me, not commit under a member cookie').toHaveCount(0, { timeout: 1200 });
  await q.unroute('**/api/jobs');
  pass('no-notice cookie identity change rejects late authenticated refresh before committing tenant state');

  // Real FileReader continuation held across a logout and a new identity.
  await login(q, adminKey);
  const writes = [];
  q.on('request', request => {
    if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/'))
      writes.push({ path: new URL(request.url()).pathname, body: request.postData() || '' });
  });
  await q.evaluate(() => {
    const original = FileReader.prototype.readAsDataURL;
    window.__releaseReader = null;
    FileReader.prototype.readAsDataURL = function (blob) {
      window.__releaseReader = () => original.call(this, blob);
    };
  });
  const upload = { name: 'held.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64') };
  await q.getByLabel('参考图', { exact: true }).setInputFiles(upload);
  await q.waitForFunction(() => !!window.__releaseReader);
  await q.getByRole('button', { name: '退出登录', exact: true }).click();
  await login(q, memberKey);
  const beforeRelease = writes.length;
  await q.evaluate(() => window.__releaseReader());
  await q.waitForTimeout(800);
  assert.equal(writes.slice(beforeRelease).some(w => w.path === '/api/assets'), false, 'old FileReader must never upload with new member credentials');
  await expect(q.locator('.composer .references img')).toHaveCount(0);
  await expect(q.getByLabel('提示词', { exact: true })).toHaveValue('');
  pass('held real FileReader is aborted across logout/login and sends no asset write under the new tenant');

  // Expiry must revoke cached object URLs, close teleported dialogs and destroy the draft.
  await q.reload();
  await expect(q.getByLabel('提示词', { exact: true })).toBeVisible();
  await q.evaluate(() => {
    window.__createdURLs = []; window.__revokedURLs = [];
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); window.__createdURLs.push(url); return url; };
    URL.revokeObjectURL = url => { window.__revokedURLs.push(url); revoke(url); };
  });
  // The browser-generated canvas produces a valid local PNG, no fixture image decoder assumptions.
  const png = await q.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 16; c.height = 16;
    c.getContext('2d').fillRect(0, 0, 16, 16);
    return c.toDataURL('image/png').split(',')[1];
  });
  await q.getByLabel('参考图', { exact: true }).setInputFiles({ name: 'local.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect(q.locator('.composer .references img')).toHaveAttribute('src', /^blob:/);
  await q.getByLabel('提示词', { exact: true }).fill('过期成员私密草稿');
  await q.getByRole('button', { name: '快速生成提示词', exact: true }).click();
  await expect(q.getByRole('dialog')).toBeVisible();
  service.db.prepare("UPDATE keys SET expires=? WHERE name=?").run('2000-01-01T00:00:00Z', '隔离测试成员');
  await expect(q.locator('.app-shell')).toHaveCount(0, { timeout: 10000 });
  await expect(q.getByRole('dialog')).toHaveCount(0);
  await expect(q.getByLabel('访问密钥')).toBeEnabled();
  assert.equal(await q.evaluate(() => window.__createdURLs.length > 0 && window.__createdURLs.every(url => window.__revokedURLs.includes(url))), true);
  assert.equal(await q.evaluate(() => sessionStorage.getItem('bimage-signed-out')), 'true');
  await q.screenshot({ path: path.join(evidence, 'tab-isolation-expired-cleared.png'), fullPage: true });
  pass('real expired-key 401 clears draft, teleported dialog, cached images/object URLs and local restore');
  service.db.prepare("UPDATE keys SET expires=NULL WHERE name=?").run('隔离测试成员');
  await quiet.close();

  const storageOnly = await browser.newContext();
  await storageOnly.addInitScript(() => Object.defineProperty(window, 'BroadcastChannel', { value: undefined }));
  const s1 = await storageOnly.newPage(), s2 = await storageOnly.newPage();
  await s1.goto(base); await login(s1, adminKey);
  await s2.goto(base); await expect(s2.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
  await s2.getByRole('button', { name: '退出登录', exact: true }).click();
  await login(s2, memberKey);
  await expect(s1.locator('.app-shell')).toHaveCount(0);
  const payload = JSON.stringify({ id: 'attacker-admin', role: 'admin', csrf: 'untrusted' });
  await s1.evaluate(value => localStorage.setItem('bimage-session-change', value), payload);
  await expect(s2.locator('.app-shell')).toHaveCount(0);
  await expect(s2.getByLabel('访问密钥')).toBeEnabled();
  assert.equal(await s1.evaluate(() => localStorage.getItem('bimage-session-change')), payload, 'notices do not echo any secret or adopt the payload');
  await storageOnly.close();
  pass('storage-only fallback clears sibling tab; forged identity payload can only invalidate, never authenticate');
  assert.deepEqual(errors, []);
  writeFileSync(path.join(evidence, 'tab-isolation-green.json'), JSON.stringify({ status: 'passed', passed: passes.length, checks: passes, errors, paidCalls: 0 }, null, 2));
  console.log(`BIMAGE TAB ISOLATION: ${passes.length} checks passed, zero paid calls`);
} catch (e) {
  await screenshot('failure').catch(() => {});
  writeFileSync(path.join(evidence, 'tab-isolation-red.json'), JSON.stringify({ status: 'failed', error: e.message, passed: passes, errors }, null, 2));
  throw e;
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  await service.close();
  rmSync(scratch, { recursive: true, force: true });
}
