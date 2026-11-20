import { mkdirSync, writeFileSync } from 'node:fs';
import { test, expect, Page } from "@playwright/test";
const initialForm = {
  providerId: "p",
  model: "image-model",
  prompt: "历史原文\n保留第二行",
  count: 1,
  autoSize: true,
  size: "1024x1024",
  ratio: "1:1",
  resolution: "1K",
  quality: "auto",
  output_format: "png",
  references: [],
};
function historyPage(items: any[], query = '', token = 'fixture') {
  const matches = items.filter(job => job.form.prompt.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return { items: matches.slice(0, 30), total: matches.length, active: items.some(job => job.tasks.some((task: any) => ['queued', 'running'].includes(task.status))), token, unchanged: false, nextCursor: null, removedIds: [] };
}
async function fixture(page: Page) {
  const image = await page.request.get('/Bimage.png').then(r => r.body());
  const state = {
    site: { title: "Bimage", icon: "" },
    settings: {},
    jobs: [
      {
        id: "j",
        form: initialForm,
        status: "succeeded",
        created: "2026-11-17T08:00:00Z",
        startedAt: "2026-11-17T08:00:00Z",
        finishedAt: "2026-11-17T08:00:05Z",
        tasks: [
          {
            id: "t",
            asset: "art",
            status: "succeeded",
            width: 512,
            height: 512,
            mime: "image/png",
          },
        ],
      },
    ],
    posts: [] as { path: string; body: any }[],
    providers: [
      {
        id: "p",
        owner: "admin",
        name: "Mock studio",
        baseUrl: "https://mock.invalid/v1",
        canManage: true,
        hasKey: true,
        shared: false,
        models: [
          { id: "image-model", types: ["image"] },
          { id: "text-model", types: ["text"] },
        ],
      },
    ],
  };
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname.slice(4),
      method = req.method(),
      body = ["GET", "HEAD"].includes(method) ? null : req.postDataJSON();
    if (!["GET", "HEAD"].includes(method)) state.posts.push({ path, body });
    if (path.startsWith("/assets/"))
      return route.fulfill({
        status: 200,
        contentType: "image/png",
        body: image,
      });
    let out: any = {};
    if (path === "/site") out = state.site;
    else if (path === "/setup") out = { required: false };
    else if (path === "/me" || path === "/login")
      out = {
        id: "admin",
        name: "Test admin",
        role: "admin",
        csrf: "test-csrf",
      };
    else if (path === "/providers") out = state.providers;
    else if (path === "/settings") {
      if (method === "PUT") state.settings = body;
      out = state.settings;
    } else if (path === "/jobs") {
      if (method === "POST") {
        const job = {
          ...state.jobs[0],
          id: "new",
          form: body,
          status: "queued",
          tasks: [{ id: "queued", status: "queued" }],
        };
        state.jobs.unshift(job as any);
        out = job;
      } else {
        const url = new URL(req.url());
        const known = JSON.parse(url.searchParams.get('known') || '[]') as string[];
        out = { ...historyPage(state.jobs, url.searchParams.get('q') || ''), removedIds: known.filter(id => !state.jobs.some(job => job.id === id)) };
      }
    } else if (path === "/assets") out = { id: "uploaded" };
    else if (path === "/rewrite") out = { text: "润色结果\n第二行" };
    else if (path === "/admin/site") {
      state.site = body;
      out = body;
    } else if (path.endsWith("/models"))
      out = { data: state.providers[0].models };
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(out),
    });
  });
  return state;
}
async function overflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
}
test('queue cancellation responds immediately and applies the returned job without waiting for history', async ({ page }, testInfo) => {
  const state = await fixture(page);
  const job = {
    ...state.jobs[0], status: 'running', finishedAt: undefined,
    form: { ...initialForm, count: 2 },
    tasks: [{ id: 't', status: 'running' }, { id: 'queued', status: 'queued' }],
  };
  const updated = { ...job, tasks: [job.tasks[0], { id: 'queued', status: 'cancelled' }] };
  let historyReady!: () => void, resumeHistory!: () => void, cancelReady!: () => void, resumeCancel!: () => void;
  const staleRequest = new Promise<void>(resolve => historyReady = resolve);
  const releaseHistory = new Promise<void>(resolve => resumeHistory = resolve);
  const cancelRequest = new Promise<void>(resolve => cancelReady = resolve);
  const releaseCancel = new Promise<void>(resolve => resumeCancel = resolve);
  let passedStale = false, cancels = 0, jobReads = 0;
  await page.route('**/api/jobs?*', async route => {
    if (passedStale) return route.fulfill({ json: historyPage([updated]) });
    passedStale = true;
    historyReady();
    await releaseHistory;
    return route.fulfill({ json: historyPage([job]) });
  });
  await page.route('**/api/jobs/j', async route => {
    jobReads++;
    return route.fulfill({ json: updated });
  });
  await page.route('**/api/jobs/j/cancel', async route => {
    cancels++;
    cancelReady();
    await releaseCancel;
    return route.fulfill({ json: { ...updated, cancelledCount: 1 } });
  });
  await page.route('**/api/jobs?*', route => route.fulfill({ json: historyPage([job]) }), { times: 1 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const card = page.locator('.job');
  try {
    await staleRequest;
    const button = card.getByRole('button', { name: '取消排队', exact: true });
    await button.click({ timeout: 4000 });
    await cancelRequest;
    await expect(card.getByRole('button', { name: '取消中…' })).toBeDisabled();
    await expect(card.getByText('排队中', { exact: true })).toBeVisible();
    await expect(card.locator('.job-head .status')).toContainText('生成中');
    await page.screenshot({ path: testInfo.outputPath('queue-cancel-pending.png') });
    resumeCancel();
    await expect(card.getByText('已取消', { exact: true })).toBeVisible();
    await expect(card.locator('.job-head .status')).toContainText('生成中');
    await expect(page.getByText('已取消 1 项排队任务。', { exact: true })).toBeVisible();
    await expect(button).toHaveCount(0);
    expect(jobReads).toBe(0);
    expect(cancels).toBe(1);
    const pollVerified = page.waitForResponse(r => new URL(r.url()).pathname === '/api/me');
    resumeHistory();
    await pollVerified;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(card.getByText('已取消', { exact: true })).toBeVisible();
    await expect(button).toHaveCount(0);
    await overflow(page);
  } finally {
    resumeCancel();
    resumeHistory();
  }
});
test('queue cancellation failure unlocks the action and a task that starts first is not marked cancelled', async ({ page }) => {
  await fixture(page);
  const job = { id: 'race', form: initialForm, status: 'queued', created: new Date().toISOString(), tasks: [{ id: 'r', status: 'queued' }] };
  let state = job, cancels = 0;
  await page.route('**/api/jobs?*', route => route.fulfill({ json: historyPage([state]) }));
  await page.route('**/api/jobs/race/cancel', route => {
    if (++cancels === 1) return route.fulfill({ status: 503, json: { error: '测试：取消请求失败' } });
    state = { ...job, status: 'running', tasks: [{ id: 'r', status: 'running' }] };
    return route.fulfill({ json: { ...state, cancelledCount: 0 } });
  });
  await page.goto('/');
  const card = page.locator('.job'), button = card.getByRole('button', { name: '取消排队', exact: true });
  await button.click({ timeout: 4000 });
  await expect(page.getByText('测试：取消请求失败')).toBeVisible();
  await expect(button).toBeEnabled();
  await expect(card.locator('.job-head .status')).toHaveText('排队中');
  await button.click();
  await expect(card.locator('.job-head .status')).toHaveText('生成中');
  await expect(button).toHaveCount(0);
  await expect(page.getByText('没有可取消的排队任务。')).toBeVisible();
  expect(cancels).toBe(2);
});
for (const reduced of [false,true]) test(`dialog motion evidence ${reduced}`, async ({page}, testInfo) => {
  await fixture(page); await page.emulateMedia({reducedMotion:reduced ? 'reduce' : 'no-preference'}); await page.goto('/');
  await page.getByRole('button',{name:'系统设置',exact:true}).click();
  const dir = testInfo.outputPath('dialog-motion');
  mkdirSync(dir,{recursive:true});
  await page.screenshot({path:`${dir}/before.png`});
  await page.getByRole('button',{name:'编辑',exact:true}).click();
  const report: any = {reducedMotion:reduced,interaction:'provider dialog entrance and exit',limitations:['animation timelines sampled by Playwright; not a frame-rate or physical-device measurement'],frames:[]};
  const timing = await page.getByRole('dialog').evaluate(el => el.getAnimations({subtree:true}).map(a => { a.pause(); return a.effect!.getTiming(); }));
  report.timing = timing;
  for (const ms of [0,40,100,180,220]) {
    await page.getByRole('dialog').evaluate((el, ms) => el.getAnimations({subtree:true}).forEach(a => {a.pause(); a.currentTime = ms;}),ms);
    const path = `${dir}/enter-${ms}.png`; await page.screenshot({path}); report.frames.push({path,time:ms});
  }
  await page.clock.install(); await page.clock.pauseAt(new Date());
  await page.getByRole('button',{name:'关闭弹窗'}).click();
  for (const ms of [0,40,100,120]) {
    await page.getByRole('dialog').evaluate((el, ms) => el.getAnimations({subtree:true}).forEach(a => {a.pause(); a.currentTime = ms;}),ms);
    const path = `${dir}/exit-${ms}.png`; await page.screenshot({path}); report.frames.push({path,time:ms});
  }
  await page.clock.fastForward(130); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.screenshot({path:`${dir}/settled.png`});
  writeFileSync(`${dir}/report.json`,JSON.stringify(report,null,2));
});
for (const theme of ['light','dark']) test(`semantic toast colors meet text contrast ${theme}`, async ({page}) => {
  await fixture(page); await page.addInitScript(t => localStorage.setItem('bimage-theme', t),theme); await page.goto('/');
  await page.getByRole('button',{name:'重试',exact:true}).click();
  await expect(page.locator('.toast')).toHaveCSS('opacity','1');
  for (const type of ['success','error','warning']) {
    const ratio = await page.locator('.toast').evaluate((el, type) => {
      (el as HTMLElement).dataset.type = type;
      const style = getComputedStyle(el);
      const lum = (color: string) => { const rgb = color.match(/[\d.]+/g)!.slice(0,3).map(Number).map(v => {v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055)/1.055)**2.4;}); return rgb[0]*.2126 + rgb[1]*.7152 + rgb[2]*.0722; };
      const a = lum(style.color), b = lum(style.backgroundColor);
      return (Math.max(a,b) + .05)/(Math.min(a,b) + .05);
    },type);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  }
});
test('custom selects support keyboard, typeahead, escape, outside click, disabled controls and long model names', async ({page}) => {
  const state = await fixture(page);
  state.providers[0].models.push({id:'long-model-' + 'identifier-'.repeat(20),types:['image']});
  await page.goto('/');
  await expect(page.getByRole('combobox',{name:'比例',exact:true})).toBeDisabled();
  const quality = page.getByRole('combobox',{name:'质量',exact:true});
  await quality.focus(); await page.keyboard.press('Home');
  await expect(quality).toHaveAttribute('aria-expanded','true');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(quality).toHaveAttribute('data-value','low');
  await page.keyboard.press('End'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('Enter');
  await expect(quality).toHaveAttribute('data-value','standard');
  await page.keyboard.type('med'); await page.keyboard.press('Enter');
  await expect(quality).toHaveAttribute('data-value','medium');
  await quality.click(); await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0); await expect(quality).toBeFocused();
  await quality.click(); await page.getByRole('heading',{name:'任务记录',exact:true}).click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
  const model = page.getByRole('combobox',{name:'图像模型',exact:true});
  await model.click(); await page.getByRole('option').filter({hasText:'long-model-'}).click();
  await expect(model).toHaveText(state.providers[0].models[2].id);
  await expect(model).toHaveAttribute('title','Mock studio');
  expect(state.posts.filter(p => p.path === '/jobs')).toHaveLength(0);
  await overflow(page);
});
for (const reduced of [false, true]) test(`motion is restrained and reduced-motion aware ${reduced}`, async ({page}) => {
  await fixture(page); await page.emulateMedia({reducedMotion: reduced ? 'reduce' : 'no-preference'}); await page.goto('/');
  await page.getByRole('button',{name:'系统设置',exact:true}).click();
  await page.getByRole('button',{name:'编辑',exact:true}).click();
  const duration = await page.getByRole('dialog').evaluate(el => getComputedStyle(el).animationDuration);
  const backdropDuration = await page.getByRole('dialog').evaluate(el => getComputedStyle(el, '::backdrop').animationDuration);
  if (reduced) expect(parseFloat(backdropDuration)).toBeLessThan(.01);
  expect(parseFloat(duration)).toBeGreaterThan(0);
  if (reduced) expect(parseFloat(duration)).toBeLessThan(.01);
  else expect(parseFloat(duration)).toBeGreaterThan(.1);
  await page.getByRole('button',{name:'关闭弹窗'}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button',{name:'图像工作台',exact:true}).click();
  const pageMotion = await page.locator('.workspace').evaluate(el => getComputedStyle(el).animationDuration);
  if (reduced) await expect(page.locator('.workspace')).toHaveCSS('animation-name', 'none');
  else expect(parseFloat(pageMotion)).toBeGreaterThan(.1);
});
for (const reduced of [false, true]) test(`view and inline prompt transitions respect reduced motion ${reduced}`, async ({ page }, testInfo) => {
  await fixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
  await page.goto('/');
  await expect(page.locator('.workspace')).toBeVisible();
  const settings = page.getByRole('button', { name: '系统设置', exact: true });
  const entry = await settings.evaluate(async (el) => {
    (el as HTMLElement).click();
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const panel = document.querySelector('.provider-settings')!;
    return { active: panel.getAnimations({ subtree: true }).filter(a => a instanceof CSSAnimation && a.animationName === 'view-in').length, opacity: Number(getComputedStyle(panel).opacity) };
  });
  if (reduced) expect(entry).toEqual({ active: 0, opacity: 1 });
  else {
    expect(entry.active).toBe(1);
    expect(entry.opacity).toBeLessThan(.9);
  }
  await page.getByRole('button', { name: '图像工作台', exact: true }).click();
  const prompt = page.getByRole('textbox', { name: '提示词', exact: true });
  const motion = await prompt.evaluate(async (el) => {
    const field = el as HTMLTextAreaElement;
    field.focus();
    field.value = '123';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const button = document.querySelector('.prompt-optimize')!;
    return { active: button.getAnimations().some(a => a instanceof CSSAnimation), opacity: Number(getComputedStyle(button).opacity) };
  });
  if (reduced) expect(motion.opacity).toBe(1);
  else {
    expect(motion.active).toBe(true);
    expect(motion.opacity).toBeLessThan(1);
  }
  await expect(page.getByRole('button', { name: '优化', exact: true })).toHaveCSS('opacity', '1');
  await expect(prompt).toBeFocused();
  await expect(prompt).toHaveCSS('border-bottom-width', '0px');
  await expect(prompt).toHaveCSS('outline-style', 'none');
  const outer = page.locator('.prompt-box');
  await expect(outer).toHaveCSS('border-bottom-color', 'rgb(141, 106, 213)');
  await expect(outer).toHaveCSS('border-bottom-width', '1px');
  await outer.screenshot({ path: testInfo.outputPath('prompt-single-edge.png'), animations: 'disabled' });
});
test('history searches full multiline prompts on server, clears and resets with tenant', async ({page}) => {
  const state = await fixture(page);
  state.jobs.push({...state.jobs[0],id:'second',form:{...initialForm,prompt:'Moonlight\nHidden Full Prompt Tail'}});
  let requests = 0; page.on('request', r => {if (r.url().includes('/api/')) requests++;});
  await page.goto('/');
  await expect(page.locator('.job')).toHaveCount(2);
  expect(await page.locator('body').innerText()).not.toContain('每张图片独立请求，任务持久保存。');
  await page.clock.install();
  const baseline = requests, posts = state.posts.length;
  const search = page.getByRole('searchbox',{name:'搜索任务提示词'});
  await search.fill('hidden full prompt tail');
  await page.clock.fastForward(250);
  await expect(page.locator('.job')).toHaveCount(1);
  await expect(page.locator('.history-count')).toHaveText('1 个记录');
  await search.fill('unmatched keyword');
  await page.clock.fastForward(250);
  await expect(page.getByText('没有匹配的任务')).toBeVisible();
  await page.getByRole('button',{name:'清除搜索'}).first().click();
  await page.clock.fastForward(250);
  await expect(page.locator('.job')).toHaveCount(2);
  await search.fill('保留第二行'); await page.clock.fastForward(250); await expect(page.locator('.job')).toHaveCount(1);
  expect(requests).toBeGreaterThan(baseline); expect(state.posts.length).toBe(posts);
  await page.getByRole('button',{name:'退出登录'}).click();
  await expect(search).toHaveCount(0);
  await page.getByLabel('邮箱', { exact: true }).fill('admin');
  await page.getByLabel('密码', { exact: true }).fill('fixture-password');
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('searchbox',{name:'搜索任务提示词'})).toHaveValue('');
});
test('logout failure is a transient typed warning, never a persistent login error', async ({page}) => {
  await page.clock.install();
  await fixture(page); await page.goto('/');
  await page.route('**/api/logout', route => route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'fixture logout failure'})}));
  await page.getByRole('button',{name:'退出登录'}).click();
  await expect(page.locator('.app-shell')).toHaveCount(0);
  await expect(page.locator('.login-error')).toHaveCount(0);
  await expect(page.locator('.toast')).toHaveAttribute('data-type','warning');
  await expect(page.locator('.toast')).toContainText('退出未确认');
  await page.clock.fastForward(6500);
  await expect(page.locator('.toast')).toHaveCount(0);
});
test('typed success and error notifications are top-centered, live and copy waits for the actual clipboard promise', async ({page}) => {
  await fixture(page);
  await page.addInitScript(() => {
    const state = window as Window & { clipboardWrites?: number; finishCopy?: () => void; failCopy?: () => void };
    state.clipboardWrites = 0;
    Object.defineProperty(navigator, 'clipboard', {value: { write: () => new Promise<void>((resolve, reject) => { state.clipboardWrites = (state.clipboardWrites ?? 0) + 1; state.finishCopy = resolve; state.failCopy = () => reject(new Error('fixture clipboard denied')); }) }});
    if (!window.ClipboardItem) (window as any).ClipboardItem = class { constructor(_: unknown) {} };
  });
  await page.goto('/');
  await page.getByRole('button',{name:'重试',exact:true}).click();
  const toast = page.locator('.toast');
  await expect(toast).toHaveAttribute('data-type','success');
  await expect(toast).toHaveAttribute('aria-live','polite');
  const box = (await toast.boundingBox())!;
  expect(box.y).toBeLessThan(70);
  expect(Math.abs(box.x + box.width / 2 - 640)).toBeLessThan(2);
  expect(await toast.locator('svg').count()).toBeGreaterThan(0);
  await page.getByRole('button',{name:'关闭通知'}).click();
  await page.getByRole('button',{name:'查看图片',exact:true}).click();
  await page.getByRole('button',{name:'复制',exact:true}).click();
  await expect(toast).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => typeof (window as any).failCopy)).toBe('function');
  await page.evaluate(() => (window as any).failCopy());
  await expect(toast).toHaveAttribute('data-type','error');
  await expect(toast).toHaveAttribute('aria-live','assertive');
  await expect(toast).toContainText('剪贴板权限被拒绝');
  await page.getByRole('button',{name:'关闭通知'}).click();
  await expect(toast).toHaveCount(0);
  await page.getByRole('button',{name:'复制',exact:true}).click();
  await expect(toast).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as Window & { clipboardWrites?: number }).clipboardWrites)).toBe(2);
  await page.evaluate(() => (window as any).finishCopy());
  await expect(toast).toHaveAttribute('data-type','success');
  await expect(toast).toContainText('复制成功');
});
test('repair output image picker is custom', async ({ page }) => {
  const state = await fixture(page);
  state.jobs[0].tasks.push({...state.jobs[0].tasks[0], id:'t2', asset:'art2'});
  await page.goto('/');
  await page.getByRole('button', {name:'局部修复',exact:true}).click();
  const picker = page.getByRole('combobox', {name:'修复图片'});
  await expect(page.locator('select')).toHaveCount(0);
  await picker.click(); await page.getByRole('option',{name:'图片 2',exact:true}).click();
  await expect(picker).toContainText('图片 2');
});

for (const failed of [false, true]) {
  test(`quick prompt locks edits and dismissal until ${failed ? 'error' : 'result'}`, async ({ page }, testInfo) => {
    await fixture(page);
    if (failed) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.addInitScript(() => localStorage.setItem('bimage-theme', 'dark'));
    }
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let requests = 0;
    await page.route('**/api/rewrite', async (route) => {
      requests++;
      await hold;
      await route.fulfill(failed ? { status: 422, json: { error: '测试：生成失败' } } : { json: { text: '测试生成结果' } });
    });
    try {
      await page.goto('/');
      await page.getByRole('button', { name: '快速生成提示词', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '快速生成提示词' });
      const intent = dialog.getByLabel('简短意图');
      const file = dialog.getByLabel('快速提示词参考图');
      await intent.fill('测试意图');
      await file.setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer: await page.request.get('/Bimage.png').then(r => r.body()) });
      await expect(dialog.getByRole('button', { name: '移除参考图' })).toBeVisible();
      await dialog.getByRole('button', { name: '生成提示词', exact: true }).click();
      await expect(dialog.getByRole('button', { name: '补写中…', exact: true })).toBeDisabled();
      await expect(intent).toBeDisabled({ timeout: 1500 });
      await expect(file).toBeDisabled();
      for (const name of ['添加参考图', '查看参考图', '移除参考图', '复制参考图', '关闭弹窗', '取消', '填入提示词']) {
        await expect(dialog.getByRole('button', { name }).first()).toBeDisabled();
      }
      await page.keyboard.press('Escape');
      await page.mouse.click(2, 2);
      await page.waitForTimeout(180); // longer than the normal close transition
      await expect(dialog).toBeVisible();
      expect(requests).toBe(1);
      await page.screenshot({ path: testInfo.outputPath('quick-prompt-locked.png'), animations: 'disabled' });
      release();
      if (failed) await expect(page.getByRole('alert')).toContainText('测试：生成失败');
      else await expect(dialog.getByLabel('生成结果')).toHaveValue('测试生成结果');
      await expect(intent).toBeEnabled();
      await expect(dialog.getByRole('button', { name: '移除参考图' })).toBeEnabled();
      await expect(dialog.getByRole('button', { name: '关闭弹窗' })).toBeEnabled();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    } finally { release(); }
  });
}

test('accepted generation shows the exact queue copy in a pill toast', async ({ page }, testInfo) => {
  await fixture(page);
  await page.goto('/');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  const restored = page.getByRole('status').filter({ hasText: '完整参数和参考图已恢复' });
  await expect(restored).toBeVisible();
  await expect(restored).not.toHaveAttribute('data-shape', 'pill');
  await page.getByRole('button', { name: '生成 1 张图片', exact: true }).click();
  const toast = page.getByRole('status').filter({ has: page.getByText('已将请求加入队列。', { exact: true }) });
  await expect(toast.locator('span')).toHaveText('已将请求加入队列。', { timeout: 2000 });
  expect(await toast.evaluate(el => parseFloat(getComputedStyle(el).borderTopLeftRadius) >= el.getBoundingClientRect().height / 2)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('queued-toast.png'), animations: 'disabled' });
});

test('inline optimization uses current prompt and references and applies only edited suggestions', async ({ page }, testInfo) => {
  const state = await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('bimage-theme', 'dark'));
  const composer = page.getByRole('region', { name: '创作参数' });
  const prompt = composer.getByRole('textbox', { name: '提示词', exact: true });
  const original = '雨夜的街道。\n一只黑猫。';
  const optimized = '路灯照亮雨夜的街道。\n一只白猫伏在窗边。';
  let finish!: () => void;
  const hold = new Promise<void>(resolve => { finish = resolve; });
  await page.route('**/api/rewrite', async route => {
    state.posts.push({ path: '/rewrite', body: route.request().postDataJSON() });
    await hold;
    await route.fulfill({ json: { text: optimized } });
  });
  try {
    await page.goto('/');
    await expect(composer.getByRole('button', { name: '优化', exact: true })).toHaveCount(0);
    await prompt.fill(original);
    await composer.locator('input[type=file]').setInputFiles({
      name: 'reference.png', mimeType: 'image/png', buffer: await page.request.get('/Bimage.png').then(r => r.body()),
    });
    await expect(composer.getByRole('button', { name: '查看参考图' })).toBeVisible();
    await composer.getByRole('button', { name: '优化', exact: true }).click();
    await expect(composer.getByText('正在优化提示词中，请耐心等待...', { exact: true })).toBeVisible();
    await expect(composer.getByRole('button', { name: '优化', exact: true })).toHaveCount(0);
    await expect(prompt).toBeDisabled();
    await expect(composer.locator('input[type=file]')).toBeDisabled();
    for (const name of ['查看参考图', '复制参考图', '移除参考图', '添加参考图', '清空提示词和参考图', '快速生成提示词', '生成 1 张图片']) {
      await expect(composer.getByRole('button', { name })).toBeDisabled();
    }
    await expect.poll(() => state.posts.filter(post => post.path === '/rewrite').map(post => post.body))
      .toEqual([{ providerId: 'p', model: 'text-model', prompt: original, references: ['uploaded'] }]);
    await page.screenshot({ path: testInfo.outputPath('inline-optimizing.png'), animations: 'disabled' });
  } finally { finish(); }
  await expect(prompt).toHaveValue('路灯照亮雨夜的街道。\n一只黑白猫伏在窗边。');
  await expect(composer.locator('.prompt-box textarea')).toHaveCount(1);
  await expect(composer.locator('.prompt-diff-added')).toHaveText(['路灯照亮', '白', '伏在窗边']);
  await expect(composer.locator('.prompt-diff-removed')).toHaveText('黑');
  await expect(composer.locator('.prompt-diff-added').first()).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(composer.getByRole('button', { name: '查看参考图' })).toBeEnabled();
  await expect(composer.getByRole('button', { name: '生成 1 张图片' })).toBeDisabled();
  await overflow(page);
  await page.screenshot({ path: testInfo.outputPath('inline-review-mobile-dark.png'), animations: 'disabled' });
  await prompt.evaluate((el: HTMLTextAreaElement) => {
    const start = el.value.indexOf('白');
    el.setSelectionRange(start, start + 1);
  });
  await page.keyboard.insertText('灰');
  await expect(composer.locator('.prompt-diff-added')).toHaveText(['路灯照亮', '灰', '伏在窗边']);
  await page.keyboard.press('Control+z');
  await expect(composer.locator('.prompt-diff-added')).toHaveText(['路灯照亮', '白', '伏在窗边']);
  await page.keyboard.press('Control+Shift+z');
  await expect(composer.locator('.prompt-diff-added')).toHaveText(['路灯照亮', '灰', '伏在窗边']);
  await expect.poll(() => (state.settings as { form?: { prompt: string } }).form?.prompt).toBe(original);
  await composer.getByRole('button', { name: '应用', exact: true }).click();
  await expect(prompt).toHaveValue('路灯照亮雨夜的街道。\n一只灰猫伏在窗边。');
  await expect(prompt).toBeFocused();
  await expect.poll(() => (state.settings as { form?: { prompt: string } }).form?.prompt).toBe('路灯照亮雨夜的街道。\n一只灰猫伏在窗边。');
  expect(state.posts.filter(post => post.path === '/jobs')).toHaveLength(0);
});

test('inline optimization errors unlock the original, and cancel restores it without saving edits', async ({ page }, testInfo) => {
  const state = await fixture(page);
  let requests = 0;
  await page.route('**/api/rewrite', route => ++requests === 1
    ? route.fulfill({ status: 422, json: { error: '测试：优化失败' } })
    : route.fulfill({ json: { text: '改写后的原句。追加建议。' } }));
  await page.goto('/');
  const prompt = page.getByRole('textbox', { name: '提示词', exact: true });
  const optimize = page.getByRole('button', { name: '优化', exact: true });
  await prompt.fill('原来的提示词。');
  await optimize.click();
  await expect(page.getByRole('alert')).toContainText('测试：优化失败');
  await expect(prompt).toHaveValue('原来的提示词。');
  await expect(prompt).toBeEnabled();
  await optimize.click();
  await expect(page.getByRole('button', { name: '应用', exact: true })).toBeVisible();
  await prompt.fill('不应被保存。');
  await page.screenshot({ path: testInfo.outputPath('inline-review-desktop.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(prompt).toHaveValue('原来的提示词。');
  await expect(prompt).toBeFocused();
  await expect.poll(() => (state.settings as { form?: { prompt: string } }).form?.prompt).toBe('原来的提示词。');
  expect(requests).toBe(2);
});

test('inline optimization keeps highlight aligned with the native editor on wrap and scroll', async ({ page }, testInfo) => {
  await fixture(page);
  await page.setViewportSize({ width: 320, height: 780 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const long = '保留　　窗台与花瓶的细节。'.repeat(48) + '\n\n';
  await page.route('**/api/rewrite', route => route.fulfill({ json: { text: long + '一只白猫。\n' } }));
  await page.goto('/');
  const prompt = page.getByRole('textbox', { name: '提示词', exact: true });
  await prompt.fill(long + '一只黑猫。\n');
  await page.getByRole('button', { name: '优化', exact: true }).click();
  await expect(prompt).toHaveValue(long + '一只黑白猫。\n');
  await prompt.focus();
  await page.keyboard.press('Control+End');
  const measure = () => prompt.evaluate((el: HTMLTextAreaElement) => {
    const mirror = el.parentElement!.querySelector<HTMLElement>('.prompt-highlight')!;
    return { editorWidth: el.clientWidth, mirrorWidth: mirror.clientWidth, editorHeight: el.clientHeight, mirrorHeight: mirror.clientHeight,
      editorScroll: el.scrollTop, mirrorScroll: mirror.scrollTop, editorScrollHeight: el.scrollHeight, mirrorScrollHeight: mirror.scrollHeight };
  });
  await expect.poll(async () => { const s = await measure(); return s.editorScroll > 0 && s.editorScroll === s.mirrorScroll; }).toBe(true);
  const size = await measure();
  expect(size.mirrorWidth).toBe(size.editorWidth);
  expect(size.mirrorHeight).toBe(size.editorHeight);
  expect(Math.abs(size.mirrorScrollHeight - size.editorScrollHeight)).toBeLessThanOrEqual(1);
  await page.locator('.prompt-box').screenshot({ path: testInfo.outputPath('inline-wrapped-scroll.png') });
  await page.getByRole('button', { name: '应用', exact: true }).click();
  await expect(prompt).toHaveValue(long + '一只白猫。\n');
});

test('job deletion requires confirmation, handles errors and evicts the cached preview', async ({ page }, testInfo) => {
  const state = await fixture(page);
  let finishPoll!: () => void;
  let pollStarted!: () => void;
  const pendingPoll = new Promise<void>(resolve => { finishPoll = resolve; });
  const startedPoll = new Promise<void>(resolve => { pollStarted = resolve; });
  let attempts = 0;
  await page.route('**/api/jobs/j', async route => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    attempts++;
    if (attempts === 1) return route.fulfill({ status: 409, json: { error: '测试：任务仍在结束中' } });
    state.jobs.splice(0, 1);
    return route.fulfill({ json: { deletedAssetIds: ['art'] } });
  });
  await page.goto('/');
  const card = page.locator('.job');
  const image = card.getByRole('img', { name: '生成图片 1' });
  await expect(image).toHaveAttribute('src', /^blob:/);
  const previewUrl = (await image.getAttribute('src'))!;
  const deleteButton = card.getByRole('button', { name: '删除', exact: true });
  const dialog = page.getByRole('dialog', { name: '删除任务' });
  await deleteButton.click();
  await expect(dialog).toContainText('无法撤销');
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('delete-confirmation.png'), animations: 'disabled' });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(deleteButton).toBeFocused();
  expect(attempts).toBe(0);
  await deleteButton.click();
  await dialog.getByRole('button', { name: '永久删除' }).click();
  await expect(page.getByRole('alert')).toContainText('测试：任务仍在结束中');
  await expect(card).toBeVisible();
  const listUrl = '**/api/jobs?*';
  const staleJobs = JSON.stringify(historyPage(state.jobs));
  await page.route(listUrl, async route => {
    pollStarted();
    await pendingPoll;
    await route.fulfill({ contentType: 'application/json', body: staleJobs });
  }, { times: 1 });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await startedPoll;
  try {
    await dialog.getByRole('button', { name: '永久删除' }).click();
    await expect(card).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: '任务已删除' })).toBeVisible();
    // Observe the stale poll's subsequent identity check before testing the list.
    const pollVerified = page.waitForResponse(response => new URL(response.url()).pathname === '/api/me');
    finishPoll();
    await pollVerified;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  } finally { finishPoll(); }
  await expect(card).toHaveCount(0);
  expect(attempts).toBe(2);
  expect(await page.evaluate(async url => fetch(url).then(() => true, () => false), previewUrl)).toBe(false);
  await page.reload();
  await expect(page.getByRole('heading', { name: '暂无任务记录' })).toBeVisible();
});

test('deletion clears cached previews in a second tab', async ({ page, context }) => {
  const state = await fixture(page);
  const sibling = await context.newPage();
  await fixture(sibling);
  await sibling.route('**/api/jobs?*', route => route.fulfill({ json: { ...historyPage(state.jobs), removedIds: state.jobs.length ? [] : ['j'] } }));
  await page.route('**/api/jobs/j', route => {
    state.jobs.splice(0, 1);
    return route.fulfill({ json: { deletedAssetIds: ['art'] } });
  });
  await page.goto('/');
  await sibling.goto('/');
  const preview = sibling.getByRole('img', { name: '生成图片 1' });
  await expect(preview).toHaveAttribute('src', /^blob:/);
  const url = (await preview.getAttribute('src'))!;
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('button', { name: '永久删除', exact: true }).click();
  await sibling.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(sibling.locator('.job')).toHaveCount(0);
  expect(await sibling.evaluate(url => fetch(url).then(() => true, () => false), url)).toBe(false);
});

test("desktop: real SFC workspace, retry refill, automatic submit, quick prompt, repair and tenant reset", async ({
  page,
}) => {
  const state = await fixture(page),
    errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "创作参数" })).toBeVisible();
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "提示词", exact: true }),
  ).toHaveValue(initialForm.prompt);
  expect(state.posts.filter((p) => p.path === "/jobs")).toHaveLength(0);
  await page
    .getByRole("button", { name: "快速生成提示词", exact: true })
    .click();
  await page.getByRole("button", { name: "生成提示词", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "生成结果" })).toHaveValue(
    "润色结果\n第二行",
  );
  await page.getByRole("button", { name: "填入提示词" }).click();
  await expect(
    page.getByRole("textbox", { name: "提示词", exact: true }),
  ).toHaveValue("润色结果\n第二行");
  await page
    .getByRole("button", { name: "生成 1 张图片", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "提示词", exact: true }),
  ).toHaveValue("");
  const submitted = state.posts.find((p) => p.path === "/jobs")!;
  expect(submitted.body).not.toHaveProperty("size");
  expect(submitted.body).not.toHaveProperty("ratio");
  expect(submitted.body).not.toHaveProperty("resolution");
  await page
    .getByRole("button", { name: "局部修复", exact: true })
    .last()
    .click();
  const canvas = page.getByLabel("标注画布");
  await expect(canvas).toBeVisible();
  await page.waitForFunction(() => {
    const c = document.querySelector("canvas");
    return c && c.width === 512;
  });
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 80);
  await page.mouse.up();
  await page.getByRole("textbox", { name: "修改需求" }).fill("第一行\n第二行");
  await page.getByRole("button", { name: "确认回填" }).click();
  await expect(
    page.getByRole("textbox", { name: "提示词", exact: true }),
  ).toContainText("");
  await expect(
    page.getByRole("textbox", { name: "提示词", exact: true }),
  ).toHaveValue(/第一行\n第二行/);
  expect(state.posts.filter((p) => p.path === "/jobs")).toHaveLength(1);
  await page.getByRole("button", { name: "系统设置", exact: true }).click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(page.getByRole("heading", { name: "编辑供应商" })).toBeVisible();
  await page.getByRole("button", { name: "关闭弹窗" }).click();
  await overflow(page);
  expect(errors).toEqual([]);
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByLabel("密码", { exact: true })).toHaveValue("");
  await expect(
    page.getByRole("heading", { name: "Bimage", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "提示词", exact: true }),
  ).toHaveCount(0);
});
for (const width of [1440, 390, 320])
  for (const theme of ["light", "dark"])
    test(`site logo layout ${width} ${theme}`, async ({ page }, testInfo) => {
      const state = await fixture(page);
      await page.setViewportSize({ width, height: 960 });
      await page.addInitScript(
        (t) => localStorage.setItem("bimage-theme", t),
        theme,
      );
      await page.goto("/");
      await expect(
        page.getByRole("heading", { name: "创作参数" }),
      ).toBeVisible();
      await overflow(page);
      await page.getByRole('button', {name:'查看图片',exact:true}).scrollIntoViewIfNeeded();
      await expect(page.locator('.image-open img')).toHaveAttribute('src', /^blob:/);
      await page.evaluate(()=>window.scrollTo(0,0));
      await page.screenshot({
        path: testInfo.outputPath(`workbench-${width}-${theme}.png`),
        fullPage: true,
      });
      await page.getByRole('searchbox', {name:'搜索任务提示词'}).fill('保留第二行');
      await expect(page.locator('.history-count')).toHaveText('1 个记录');
      await page.locator('.history').scrollIntoViewIfNeeded();
      await page.screenshot({path:testInfo.outputPath(`ui-v011-search-${width}-${theme}.png`),fullPage:true});
      await page.getByRole('button', {name:'重试',exact:true}).click();
      const combo = page.getByRole('combobox',{name:'图像模型',exact:true});
      await combo.click();
      const list = page.getByRole('listbox',{name:'图像模型',exact:true});
      await expect(list).toBeVisible();
      const lb = (await list.boundingBox())!;
      expect(lb.x).toBeGreaterThanOrEqual(0); expect(lb.x + lb.width).toBeLessThanOrEqual(width);
      expect(lb.y).toBeGreaterThanOrEqual(0); expect(lb.y + lb.height).toBeLessThanOrEqual(960);
      await expect(page.locator('.toast')).toHaveAttribute('data-type','success');
      await expect(page.locator('.toast')).toHaveCSS('opacity','1');
      await expect(list).toHaveCSS('opacity','1');
      await page.screenshot({path:testInfo.outputPath(`ui-v011-select-toast-${width}-${theme}.png`)});
      await page.keyboard.press('Escape');
      if (width === 1440) {
        const c = (await page.locator(".composer").boundingBox())!,
          h = (await page.locator(".history").boundingBox())!;
        expect(Math.abs(c.width - h.width)).toBeLessThan(1);
      }
      await page.getByRole("button", { name: "系统设置", exact: true }).click();
      await page.getByRole("tab", { name: "站点样式" }).click();
      const image = page.getByAltText("站点图标预览"),
        upload = page.getByRole("button", { name: "上传图标" });
      await expect(image).toBeVisible();
      const ib = (await image.boundingBox())!,
        ub = (await upload.boundingBox())!;
      expect(ib.width).toBe(80);
      expect(ib.height).toBe(80);
      expect(ub.x).toBeGreaterThan(ib.x + ib.width);
      const save = (await page
        .getByRole("button", { name: "保存站点设置" })
        .boundingBox())!;
      expect(save.y).toBeGreaterThan(ib.y + ib.height);
      await page.getByRole("textbox", { name: "站点标题" }).fill("My Bimage");
      await page.getByRole("button", { name: "保存站点设置" }).click();
      await expect(page).toHaveTitle(/My Bimage/);
      expect(state.site.title).toBe("My Bimage");
      await overflow(page);
      await page.screenshot({
        path: testInfo.outputPath(`site-${width}-${theme}.png`),
        fullPage: true,
      });
    });
