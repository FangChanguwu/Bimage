import { expect, test, type Page } from '@playwright/test';
import frontendPackage from '../../package.json' with { type: 'json' };

const admin = { id: 'admin-owner', email: 'admin', name: 'admin', role: 'admin', concurrency: 1, csrf: 'fixture-admin-csrf' };
const member = { id: 'member-owner', email: 'member@example.test', name: '工作室成员', role: 'user', concurrency: 1, csrf: 'fixture-member-csrf' };
const password = '12345';

async function fixture(page: Page, { setup = false, signedIn = false } = {}) {
  const state = { setup, session: signedIn ? admin : null, users: [admin, member], writes: [] as { path: string; body: unknown; csrf?: string }[] };
  await page.route('**/api/**', async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname.slice(4);
    const method = req.method();
    const send = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (method !== 'GET') state.writes.push({ path, body: req.postDataJSON(), csrf: req.headers()['x-csrf-token'] });
    if (path === '/site' && method === 'GET') return send({ title: 'Bimage', icon: '' });
    if (path === '/setup') {
      if (method === 'GET') return send({ required: state.setup });
      if (!state.setup) return send({ error: '初始化已完成' }, 409);
      if (req.postDataJSON().code !== 'fixture-one-time-code') return send({ error: '初始化验证码无效' }, 403);
      state.setup = false;
      return send(state.session = admin);
    }
    if (path === '/login' && method === 'POST') {
      const { login, password: submitted } = req.postDataJSON();
      if (submitted !== password) return send({ error: '账号或密码无效' }, 401);
      return send(state.session = login === 'admin' ? admin : member);
    }
    if (path === '/logout' && method === 'POST') { state.session = null; return send({ ok: true }); }
    if (!state.session) return send({ error: '请登录' }, 401);
    if (path === '/me' && method === 'GET') return send(state.session);
    if (['/providers', '/jobs'].includes(path) && method === 'GET') return send([]);
    if (path === '/settings' && method === 'GET') return send({});
    if (path === '/admin/users') {
      if (state.session.role !== 'admin') return send({ error: '无权访问' }, 403);
      if (method === 'GET') return send({ users: state.users.map(({ csrf, ...account }) => account) });
      if (req.headers()['x-csrf-token'] !== admin.csrf) return send({ error: '会话已失效' }, 403);
      const { email, name, role, concurrency } = req.postDataJSON();
      if (state.users.some(user => user.email === email)) return send({ error: '邮箱已被使用' }, 409);
      const account = { id: 'new-owner', email, name: name || email, role, concurrency };
      state.users.push({ ...account, csrf: 'fixture-new-csrf' });
      return send(account, 201);
    }
    return send({ error: 'Unexpected fixture request' }, 404);
  });
  return state;
}

async function withinViewport(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
}

test('first run uses a one-time code and sets the admin password', async ({ page }, testInfo) => {
  const state = await fixture(page, { setup: true });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '初始化管理员' })).toBeVisible({ timeout: 4000 });
  await expect(page.getByText('data/setup-code.txt', { exact: true })).toBeVisible();
  await expect(page.getByLabel('管理员账号')).toHaveValue('admin');
  const submit = page.getByRole('button', { name: '创建管理员并登录' });
  await expect(submit).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: testInfo.outputPath('setup-desktop.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 320, height: 760 });
  await page.getByRole('button', { name: '切换主题' }).click();
  await withinViewport(page);
  await page.screenshot({ path: testInfo.outputPath('setup-mobile-dark.png'), animations: 'disabled' });
  await expect(submit).toBeInViewport({ ratio: 1 });
  const code = page.getByLabel('一次性初始化代码');
  await expect(page.getByLabel('新密码', { exact: true })).toHaveAttribute('minlength', '5');
  await expect(page.getByText('至少 5 个字符。', { exact: true })).toBeVisible();
  await code.fill('wrong-fixture-code');
  await page.getByLabel('新密码', { exact: true }).fill(password);
  await page.getByLabel('确认密码').fill('different password');
  await submit.click();
  await expect(page.getByRole('alert')).toHaveText('两次输入的密码不一致');
  expect(state.writes).toHaveLength(0);
  await page.getByLabel('确认密码').fill(password);
  await submit.click();
  await expect(page.getByRole('alert')).toHaveText('初始化验证码无效');
  await code.fill('fixture-one-time-code');
  await submit.click();
  await expect(page.getByRole('heading', { name: '图像工作台' })).toBeVisible();
  expect(state.writes.at(-1)).toMatchObject({ path: '/setup', body: { code: 'fixture-one-time-code', password } });
  await expect(page.getByLabel('一次性初始化代码')).toHaveCount(0);
});

test('email/password login rejects incorrect credentials and a member never sees user management', async ({ page }, testInfo) => {
  const state = await fixture(page);
  const adminReads: string[] = [];
  page.on('request', req => { if (new URL(req.url()).pathname === '/api/admin/users') adminReads.push(req.method()); });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '登录' })).toBeVisible({ timeout: 4000 });
  await expect(page.getByRole('heading', { level: 1, name: 'Bimage', exact: true })).toBeVisible();
  await expect(page.locator('.login-brand').getByText(`v${frontendPackage.version}`, { exact: true })).toBeVisible();
  await expect(page.getByText('使用邮箱或管理员账号登录图像工作台。')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('login-desktop.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 320, height: 740 });
  await page.getByRole('button', { name: '切换主题' }).click();
  await withinViewport(page);
  await page.screenshot({ path: testInfo.outputPath('login-mobile-dark.png'), animations: 'disabled' });
  await page.getByLabel('邮箱', { exact: true }).fill(member.email);
  await page.getByLabel('密码', { exact: true }).fill('wrong-fixture-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('账号或密码无效');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByLabel('密码', { exact: true }).press('Enter');
  await expect(page.getByRole('heading', { name: '图像工作台' })).toBeVisible();
  await expect(page.getByRole('button', { name: '用户管理' })).toHaveCount(0);
  await page.getByRole('button', { name: '系统设置' }).click();
  await expect(page.getByRole('tab', { name: '供应商' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '站点样式' })).toHaveCount(0);
  expect(adminReads).toEqual([]);
  expect(state.writes.at(-1)).toMatchObject({ path: '/login', body: { login: member.email, password } });
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByLabel('密码', { exact: true })).toHaveValue('');
});

for (const reduced of [false, true]) {
  test(`login and logout animate only the arriving view (reduced motion: ${reduced})`, async ({ page }) => {
    const state = await fixture(page);
    await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
    await page.goto('/');
    await page.getByLabel('邮箱', { exact: true }).fill('admin');
    await page.getByLabel('密码', { exact: true }).fill(password);

    async function observeSwitch(entering: string, leaving: string) {
      // Observe the first rendered frame, before Playwright's normal action waits can miss it.
      return page.evaluateHandle(({ entering, leaving }) => ({ frame: new Promise<{
        outgoingPresent: boolean; active: boolean; opacity: number;
      }>(resolve => {
        const app = document.querySelector('#app')!;
        const observer = new MutationObserver(() => {
          const incoming = app.querySelector(entering);
          if (!incoming) return;
          observer.disconnect();
          requestAnimationFrame(() => resolve({
            outgoingPresent: Boolean(app.querySelector(leaving)),
            active: incoming.getAnimations().some(animation => animation instanceof CSSAnimation && animation.playState === 'running'),
            opacity: Number(getComputedStyle(incoming).opacity),
          }));
        });
        observer.observe(app, { childList: true, subtree: true });
      }) }), { entering, leaving });
    }

    const arriving = await observeSwitch('.app-shell', '.login');
    await page.getByLabel('密码', { exact: true }).press('Enter');
    const arrived = await arriving.evaluate(({ frame }) => frame);
    await arriving.dispose();
    expect(arrived.outgoingPresent).toBe(false);
    expect(arrived.active).toBe(!reduced);
    if (reduced) expect(arrived.opacity).toBe(1);
    else expect(arrived.opacity).toBeLessThan(.9);
    expect(state.writes.at(-1)).toMatchObject({ path: '/login', body: { login: 'admin' } });
    await expect(page.locator('.app-shell')).toHaveCSS('opacity', '1');
    await page.getByRole('textbox', { name: '提示词', exact: true }).fill('账号私有草稿');

    const returning = await observeSwitch('.login', '.app-shell');
    await page.getByRole('button', { name: '退出登录' }).click();
    const returned = await returning.evaluate(({ frame }) => frame);
    await returning.dispose();
    expect(returned.outgoingPresent).toBe(false);
    expect(returned.active).toBe(!reduced);
    if (reduced) expect(returned.opacity).toBe(1);
    else expect(returned.opacity).toBeLessThan(.9);
    await expect(page.locator('.login')).toHaveCSS('opacity', '1');
    await expect(page.getByLabel('邮箱', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('密码', { exact: true })).toHaveValue('');
  });
}

test('administrator creates a new account without retired workspace association controls', async ({ page }, testInfo) => {
  const state = await fixture(page, { signedIn: true });
  await page.goto('/');
  const users = page.getByRole('button', { name: '用户管理', exact: true });
  await expect(users).toBeVisible({ timeout: 4000 });
  expect(await users.evaluate(el => el.nextElementSibling?.getAttribute('aria-label'))).toBe('系统设置');
  await users.click();
  await expect(page.getByText(member.email, { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '待关联的旧工作区' })).toHaveCount(0);
  await expect(page.getByText('旧工作区', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('users-desktop.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 320, height: 740 });
  await page.getByRole('button', { name: '切换主题' }).click();
  const opener = page.getByRole('button', { name: '创建用户', exact: true });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: '创建用户' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('密码', { exact: true })).toHaveAttribute('minlength', '5');
  await expect(dialog.getByText('至少 5 个字符。', { exact: true })).toBeVisible();
  await withinViewport(page);
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  await page.screenshot({ path: testInfo.outputPath('create-user-mobile-dark.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await opener.click();
  await dialog.getByLabel('邮箱', { exact: true }).fill(member.email);
  await dialog.getByLabel('密码', { exact: true }).fill(password);
  await dialog.getByLabel('用户名（可选）').fill('新管理员');
  const role = dialog.getByRole('combobox', { name: '角色' });
  await role.press('Enter');
  await role.press('End');
  await role.press('Enter');
  await expect(role).toContainText('管理员');
  await dialog.getByRole('combobox', { name: '并发上限' }).click();
  await dialog.getByRole('option', { name: '8', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: '关联旧工作区（可选）' })).toHaveCount(0);
  await dialog.getByRole('button', { name: '创建用户', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('邮箱已被使用');
  await dialog.getByLabel('邮箱', { exact: true }).fill('new@example.test');
  await dialog.getByRole('button', { name: '创建用户', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const row = page.getByRole('listitem').filter({ hasText: 'new@example.test' });
  await expect(row).toContainText('新管理员');
  await expect(row).toContainText('管理员');
  await expect(row).toContainText('并发上限 8');
  await expect(page.getByText('旧工作区', { exact: true })).toHaveCount(0);
  expect(state.writes.at(-1)).toEqual({ path: '/admin/users', csrf: admin.csrf, body: { email: 'new@example.test', password, name: '新管理员', role: 'admin', concurrency: 8 } });
  await page.getByRole('button', { name: '关闭通知' }).click();
  await expect(page.getByRole('button', { name: '关闭通知' })).toHaveCount(0);
  await withinViewport(page);
  await page.screenshot({ path: testInfo.outputPath('users-mobile-dark.png'), animations: 'disabled' });
});
