import { expect, test, type Page } from '@playwright/test';

const admin = { id: 'shell-admin', name: 'admin', email: 'admin', role: 'admin', concurrency: 1, csrf: 'shell-fixture' };
async function fixture(page: Page, setup = false, signedIn = false) {
  const state = { setup, signedIn, writes: [] as { path: string; body: Record<string, unknown> }[], settings: {} as Record<string, unknown> };
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname.slice(4), method = request.method();
    const body = method === 'GET' ? null : request.postDataJSON();
    if (body) state.writes.push({ path, body });
    const send = (json: unknown, status = 200) => route.fulfill({ json, status });
    if (path === '/site') return send({ title: '我的 Bimage', icon: '' });
    if (path === '/setup') {
      if (method === 'GET') return send({ required: state.setup });
      state.setup = false; state.signedIn = true; return send(admin);
    }
    if (path === '/login') {
      if (body.password === 'wrong') return send({ error: '账号或密码无效' }, 401);
      state.signedIn = true; return send(admin);
    }
    if (path === '/me') return state.signedIn ? send(admin) : send({ error: '请登录' }, 401);
    if (path === '/providers') return send([{ id: 'p', owner: admin.id, name: '我的供应商', canManage: true, hasKey: true, models: [{ id: 'image-model', types: ['image'] }, { id: 'text-model', types: ['text'] }] }]);
    if (path === '/jobs') return send({ items: [], total: 0, nextCursor: null, token: 'shell-history', active: false, unchanged: false });
    if (path === '/settings') {
      if (method === 'PUT') state.settings = body;
      return send(state.settings);
    }
    if (path === '/admin/users') return send({ users: [admin] });
    return send({ error: `Unexpected fixture: ${method} ${path}` }, 500);
  });
  return state;
}

async function toggle(page: Page) { await page.getByRole('button', { name: 'English', exact: true }).click(); }

test('login switches in place, keeps credentials, and persists English after reload', async ({ page }) => {
  await fixture(page);
  await page.goto('/');
  await page.getByLabel('邮箱', { exact: true }).fill('admin');
  await page.getByLabel('密码', { exact: true }).fill('private-draft');
  await toggle(page);
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('admin');
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('private-draft');
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page).toHaveTitle('我的 Bimage | Sign in');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '简体中文', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '简体中文', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
});

test('workspace switches without losing the mounted draft, session, or translated title', async ({ page }) => {
  const state = await fixture(page, false, true);
  await page.goto('/');
  await page.getByRole('textbox', { name: '提示词', exact: true }).fill('保留我的创作 draft');
  await toggle(page);
  await expect(page.getByRole('heading', { name: 'Image studio', exact: true })).toBeVisible();
  await expect(page).toHaveTitle('我的 Bimage | Image studio');
  await expect(page.locator('textarea').first()).toHaveValue('保留我的创作 draft');
  await expect(page.getByText('0 records', { exact: true })).toBeVisible();
  expect(state.signedIn).toBe(true);
  expect(state.writes.filter(write => ['/login', '/logout', '/setup', '/jobs'].includes(write.path))).toHaveLength(0);
});

test('settings and account labels update while unsaved selections remain intact', async ({ page }) => {
  await fixture(page, false, true);
  await page.goto('/');
  await toggle(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connected providers' })).toBeVisible();
  await expect(page.getByText('我的供应商', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Quick prompt', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add provider', exact: true }).click();
  const provider = page.getByRole('dialog', { name: 'Add provider' });
  await provider.getByLabel('Name', { exact: true }).fill('私人 provider draft');
  await provider.getByLabel('API Key', { exact: true }).fill('fixture-key');
  // The native modal intentionally makes sidebar controls inert; a locale event
  // from another app entry point must still update the same mounted editor.
  await page.evaluate(async () => { const modulePath = '/src/i18n.ts'; const { toggleLocale } = await import(/* @vite-ignore */ modulePath); toggleLocale(); });
  await expect(page.getByRole('dialog', { name: '添加供应商' }).getByLabel('名称', { exact: true })).toHaveValue('私人 provider draft');
  await expect(page.getByRole('dialog').getByLabel('API Key', { exact: true })).toHaveValue('fixture-key');
  await page.keyboard.press('Escape');
  await toggle(page);
  await page.getByRole('tab', { name: 'Local cache', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Local image cache' })).toBeVisible();
  await page.getByRole('tab', { name: 'Site appearance', exact: true }).click();
  await page.getByLabel('Site title', { exact: true }).fill('自定义品牌 draft');
  await page.getByRole('button', { name: '简体中文', exact: true }).click();
  await expect(page.getByLabel('站点标题', { exact: true })).toHaveValue('自定义品牌 draft');
  await page.getByRole('button', { name: '用户管理', exact: true }).click();
  await toggle(page);
  await expect(page.getByRole('heading', { name: 'Users 1 users' })).toBeVisible();
  await page.getByRole('button', { name: 'Create user', exact: true }).click();
  const account = page.getByRole('dialog', { name: 'Create user' });
  await account.getByLabel('Email', { exact: true }).fill('draft@example.test');
  await account.getByRole('combobox', { name: 'Role', exact: true }).click();
  await account.getByRole('option', { name: 'Administrator', exact: true }).click();
  await page.evaluate(async () => { const modulePath = '/src/i18n.ts'; const { toggleLocale } = await import(/* @vite-ignore */ modulePath); toggleLocale(); });
  await expect(page.getByRole('dialog', { name: '创建用户' }).getByLabel('邮箱', { exact: true })).toHaveValue('draft@example.test');
  await expect(page.getByRole('combobox', { name: '角色', exact: true })).toContainText('管理员');
});

test('setup retains entered values and validation when language changes', async ({ page }) => {
  await fixture(page, true);
  await page.goto('/');
  await page.getByLabel('一次性初始化代码').fill('fixture-setup-code');
  await page.getByLabel('新密码', { exact: true }).fill('fixture-password');
  await page.getByLabel('确认密码').fill('mismatch');
  await page.getByRole('button', { name: '创建管理员并登录', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('两次输入的密码不一致');
  await toggle(page);
  await expect(page.getByRole('heading', { name: 'Set up administrator' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText('The passwords do not match');
  await expect(page.getByLabel('One-time setup code')).toHaveValue('fixture-setup-code');
  await expect(page.getByLabel('New password', { exact: true })).toHaveValue('fixture-password');
  await expect(page.getByLabel('Confirm password')).toHaveValue('mismatch');
  await expect(page).toHaveTitle('我的 Bimage | Set up administrator');
});

test('an already displayed server error changes language without a second request', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/');
  await page.getByLabel('邮箱', { exact: true }).fill('admin');
  await page.getByLabel('密码', { exact: true }).fill('wrong');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('账号或密码无效');
  await toggle(page);
  await expect(page.getByRole('alert')).toHaveText('Invalid account or password');
  expect(state.writes.filter(write => write.path === '/login')).toHaveLength(1);
});

test('default model selections and saved status react to locale without draft loss', async ({ page }) => {
  const state = await fixture(page, false, true);
  await page.goto('/');
  await page.getByRole('textbox', { name: '提示词', exact: true }).fill('原始创作 draft');
  await page.getByRole('button', { name: '系统设置', exact: true }).click();
  await page.getByRole('combobox', { name: '生图模型', exact: true }).click();
  await page.getByRole('option', { name: 'image-model 我的供应商', exact: true }).click();
  await toggle(page);
  await expect(page.getByRole('combobox', { name: 'Image model', exact: true })).toContainText('image-model');
  await page.getByRole('button', { name: 'Save default models', exact: true }).click();
  await expect(page.locator('.form-footer [role=status]')).toHaveText('Default models saved');
  await page.getByRole('button', { name: '简体中文', exact: true }).click();
  await expect(page.locator('.form-footer [role=status]')).toHaveText('默认模型已保存');
  await page.getByRole('button', { name: '图像工作台', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '提示词', exact: true })).toHaveValue('原始创作 draft');
  expect(state.settings.imageModel).toBe('image-model');
  expect(state.settings.form).toMatchObject({ prompt: '原始创作 draft' });
});

test('unsupported persisted locale falls back to Chinese', async ({ page }) => {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem('bimage-language', 'fr'));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
});

for (const setup of [false, true]) {
  test(`English ${setup ? 'setup' : 'login'} fits at 320px`, async ({ page }, testInfo) => {
    await fixture(page, setup);
    await page.setViewportSize({ width: 320, height: 760 });
    await page.goto('/');
    await toggle(page);
    await expect(page.getByRole('heading', { name: setup ? 'Set up administrator' : 'Sign in', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await expect(page.getByRole('button', { name: setup ? 'Create administrator and sign in' : 'Sign in', exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`shell-${setup ? 'setup' : 'login'}-en-320.png`), animations: 'disabled' });
  });
}

test('English workspace, settings, and account modal fit at 320px', async ({ page }, testInfo) => {
  await fixture(page, false, true);
  await page.setViewportSize({ width: 320, height: 760 });
  await page.goto('/');
  await toggle(page);
  await expect(page.getByRole('heading', { name: 'Image studio', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.screenshot({ path: testInfo.outputPath('shell-workspace-en-320.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.getByRole('button', { name: 'Add provider', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Add provider' });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('shell-provider-en-320.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'User management', exact: true }).click();
  await page.getByRole('button', { name: 'Create user', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Create user' });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('shell-account-en-320.png'), animations: 'disabled' });
});

for (const width of [1440, 900, 320]) {
  for (const signedIn of [false, true]) {
    test(`icon-only language and theme controls align in ${signedIn ? 'workspace' : 'login'} at ${width}px`, async ({ page }, testInfo) => {
      await fixture(page, false, signedIn);
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/');
      await expect(page.getByRole('heading', { name: signedIn ? '图像工作台' : '登录', exact: true })).toBeVisible();
      const language = page.locator('.language-switch');
      const theme = page.locator(signedIn ? '.theme-toggle' : '.login-theme');
      await expect(language).toHaveCount(1);
      await expect(language).toHaveAccessibleName('English');
      await expect(language.locator('svg')).toBeVisible();
      await expect(language).toHaveText('', { timeout: 1000 });
      const left = (await language.boundingBox())!, right = (await theme.boundingBox())!;
      expect(left.width).toBe(right.width);
      expect(left.height).toBe(right.height);
      expect(left.y).toBe(right.y);
      expect(right.x - (left.x + left.width)).toBeGreaterThanOrEqual(4);
      expect(right.x - (left.x + left.width)).toBeLessThanOrEqual(12);
      const shell = (await page.locator(signedIn ? '.sidebar' : '.login').boundingBox())!;
      expect(left.x).toBeGreaterThan(shell.x);
      expect(right.x + right.width).toBeLessThan(shell.x + shell.width);
      await language.focus();
      await page.keyboard.press('Enter');
      await expect(language).toHaveAccessibleName('简体中文');
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await page.keyboard.press('Tab');
      await expect(theme).toBeFocused();
      await page.keyboard.press('Space');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await page.screenshot({ path: testInfo.outputPath('controls-dark.png'), animations: 'disabled' });
    });
  }
}
