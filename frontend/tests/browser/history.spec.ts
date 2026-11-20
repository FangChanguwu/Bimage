import { expect, test, type Page } from '@playwright/test';

const form = { providerId: 'p', model: 'image', prompt: '', count: 1, size: '1024x1024', autoSize: true, ratio: '1:1', quality: 'auto', output_format: 'png', references: [] };
async function fixture(page: Page) {
  const jobs = Array.from({ length: 65 }, (_, i) => ({ id: String(65 - i).padStart(3, '0'), created: `2026-01-01T00:00:${String(65 - i).padStart(2, '0')}Z`, status: 'succeeded', form: { ...form, prompt: i === 64 ? 'first line\nMiXeD %_ literal full tail' : `prompt ${i}` }, tasks: [{ id: `t${i}`, status: 'succeeded' }] }));
  const requests: URL[] = [];
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname.slice(4);
    let result: unknown = {};
    if (path === '/site') result = { title: 'History fixture' };
    else if (path === '/setup') result = { required: false };
    else if (path === '/me') result = { id: 'admin', name: 'Fixture', role: 'admin', csrf: 'fixture-csrf' };
    else if (path === '/providers') result = [{ id: 'p', owner: 'admin', name: 'Fixture', models: [{ id: 'image', types: ['image'] }, { id: 'text', types: ['text'] }] }];
    else if (path === '/settings') result = {};
    else if (path === '/jobs') {
      requests.push(url);
      const query = url.searchParams.get('q') ?? '';
      const filtered = jobs.filter(j => j.form.prompt.toLowerCase().includes(query.toLowerCase()));
      const cursor = url.searchParams.get('cursor');
      const offset = cursor ? filtered.findIndex(j => j.id === cursor) + 1 : 0;
      const items = filtered.slice(offset, offset + 30);
      const token = `${jobs.length}:${query}`;
      result = url.searchParams.get('token') === token
        ? { unchanged: true, token, total: filtered.length, active: false }
        : { items, total: filtered.length, active: false, nextCursor: offset + 30 < filtered.length ? items.at(-1)!.id : null, token, unchanged: false };
    }
    await route.fulfill({ json: result });
  });
  return { jobs, requests };
}

test('bounded server history, load more, whole-prompt search and refresh retain loaded windows', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/');
  await expect(page.locator('.job')).toHaveCount(30);
  await expect(page.locator('.history-count')).toHaveText('65 个记录');
  expect(state.requests[0].searchParams.get('limit')).toBe('30');
  await page.getByRole('button', { name: '加载更多', exact: true }).click();
  await expect(page.locator('.job')).toHaveCount(60);
  state.jobs.unshift({ ...state.jobs[0], id: 'new', created: '2026-02-01T00:00:00Z' });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.job')).toHaveCount(61);
  await expect(page.locator('.history-count')).toHaveText('66 个记录');
  const search = page.getByRole('searchbox', { name: '搜索任务提示词' });
  await search.fill('mixed %_ literal full tail');
  await expect(page.locator('.job')).toHaveCount(1);
  await expect(page.locator('.history-count')).toHaveText('1 个记录');
  expect(state.requests.at(-1)!.searchParams.get('q')).toBe('mixed %_ literal full tail');
  await page.getByRole('button', { name: '清除搜索', exact: true }).click();
  await expect(page.locator('.job')).toHaveCount(30);
  await expect(page.locator('.history-count')).toHaveText('66 个记录');
});

test('idle history does not poll for five seconds and focus/online coalesce immediately', async ({ page }) => {
  const state = await fixture(page);
  await page.clock.install();
  await page.goto('/');
  await expect(page.locator('.job')).toHaveCount(30);
  const before = state.requests.length;
  await page.clock.fastForward(5000);
  expect(state.requests.length).toBe(before);
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); });
  await expect.poll(() => state.requests.length).toBe(before + 1);
  expect(state.requests.at(-1)!.searchParams.get('token')).toBeTruthy();
});
