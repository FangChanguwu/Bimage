import { expect, test } from '@playwright/test';

for (const language of ['en', 'zh-CN'] as const) {
  test(`image dialogs retain user data and clipboard completion in ${language}`, async ({ page }) => {
    await page.addInitScript(language => {
      localStorage.setItem('bimage-language', language);
      const state = window as unknown as { copyWrites: number; finishCopy: () => void; failCopy: () => void };
      state.copyWrites = 0;
      Object.defineProperty(navigator, 'clipboard', { value: { write: () => new Promise<void>((resolve, reject) => {
        state.copyWrites++;
        state.finishCopy = resolve;
        state.failCopy = () => reject(new Error('fixture clipboard denied'));
      }) } });
      if (!window.ClipboardItem) (window as unknown as { ClipboardItem: unknown }).ClipboardItem = class {};
    }, language);
    const image = await page.request.get('/Bimage.png').then(response => response.body());
    const prompt = '保留原始提示词\n第二行 user text';
    const job = {
      id: 'image-i18n-job', status: 'succeeded', created: '2026-11-19T13:05:00Z',
      form: { providerId: 'fixture-provider', model: 'image-model-不翻译', prompt, count: 1, autoSize: true, size: '1024x1024', ratio: '1:1', resolution: '1K', quality: 'auto', output_format: 'png', references: [] },
      tasks: [{ id: 'task', asset: 'image-i18n-original', status: 'succeeded', width: 512, height: 512, mime: 'image/png' }],
    };
    const reads: string[] = [];
    await page.route('**/api/**', route => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname.slice(4);
      if (path.startsWith('/assets/')) {
        reads.push(request.method() + url.pathname + url.search);
        return route.fulfill({ contentType: 'image/png', body: request.method() === 'HEAD' ? undefined : image });
      }
      const fixtures: Record<string, unknown> = {
        '/site': { title: 'Fixture' }, '/setup': { required: false },
        '/me': { id: 'fixture-owner', role: 'admin', name: 'Fixture', csrf: 'fixture-csrf' },
        '/settings': {},
        '/providers': [{ id: 'fixture-provider', name: 'Fixture', owner: 'fixture-owner', models: [{ id: 'image-model-不翻译', types: ['image'] }] }],
        '/jobs': { items: [job], total: 1, nextCursor: null, removedIds: [], token: 'fixture', active: false, unchanged: false },
      };
      return route.fulfill({ json: fixtures[path] ?? {} });
    });
    await page.goto('/');
    const english = language === 'en';
    await page.getByRole('button', { name: english ? 'View image' : '查看图片', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: english ? 'Image preview' : '图片预览', exact: true });
    const original = dialog.locator('img');
    await expect.poll(() => original.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect(reads.filter(read => /^GET\/api\/assets\/[^?]+$/.test(read))).toHaveLength(1);
    await dialog.getByRole('button', { name: english ? 'Copy' : '复制', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { copyWrites: number }).copyWrites)).toBe(1);
    await expect(page.locator('.toast')).toHaveCount(0);
    await page.evaluate(() => (window as unknown as { failCopy: () => void }).failCopy());
    await expect(page.locator('.toast')).toContainText(english ? 'Clipboard access was denied' : '剪贴板权限被拒绝');
    await page.getByRole('button', { name: english ? 'Close notification' : '关闭通知' }).click();
    await expect(page.locator('.toast')).toHaveCount(0);
    await dialog.getByRole('button', { name: english ? 'Copy' : '复制', exact: true }).click();
    // Authorization can delay reuse of an original. Resolve the new write,
    // never the previous attempt's stale promise resolver.
    await expect.poll(() => page.evaluate(() => (window as unknown as { copyWrites: number }).copyWrites)).toBe(2);
    await expect(page.locator('.toast')).toHaveCount(0);
    await page.evaluate(() => (window as unknown as { finishCopy: () => void }).finishCopy());
    await expect(page.locator('.toast')).toHaveAttribute('data-type', 'success');
    await expect(page.locator('.toast')).toContainText(english ? 'Copied' : '复制成功');
    await page.getByRole('button', { name: english ? 'Close notification' : '关闭通知' }).click();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: english ? 'Local repair' : '局部修复', exact: true }).click();
    dialog = page.getByRole('dialog', { name: english ? 'Local repair' : '局部修复', exact: true });
    await expect(dialog.getByRole('button', { name: english ? 'Brush' : '画笔', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: english ? 'Fill draft' : '确认回填', exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: english ? 'Fill draft' : '确认回填', exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveText(english ? 'Add an annotation to the image first' : '请先在图内添加标注');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await page.locator('.delete-job').click();
    dialog = page.getByRole('dialog', { name: english ? 'Delete job' : '删除任务', exact: true });
    await expect(dialog.locator('.delete-prompt')).toHaveText(prompt);
    await expect(dialog.getByRole('button', { name: english ? 'Delete permanently' : '永久删除', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: english ? 'Cancel' : '取消', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.job-meta')).toContainText('image-model-不翻译');
  });
}
