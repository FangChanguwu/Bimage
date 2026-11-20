/// <reference types="node" />
import { expect, test, type Page } from "@playwright/test";
import { Buffer } from "node:buffer";

const form = {
  providerId: "p",
  model: "image-model",
  prompt: "布局预览示例",
  count: 1,
  autoSize: true,
  size: "1024x1024",
  ratio: "1:1",
  resolution: "1K",
  quality: "auto",
  output_format: "png",
  references: [],
};

async function mockStudio(page: Page, jobs: object[] = [], assets = new Map<string, Buffer>()) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const asset = assets.get(path.split("/").pop()!);
    if (path.startsWith("/api/assets/") && asset)
      return route.fulfill({ contentType: "image/png", body: asset });
    switch (path) {
      case "/api/site": return route.fulfill({ json: { title: "Bimage" } });
      case "/api/setup": return route.fulfill({ json: { required: false } });
      case "/api/me": return route.fulfill({ json: { id: "demo", name: "Demo", role: "member", csrf: "fixture" } });
      case "/api/providers": return route.fulfill({ json: [{ id: "p", name: "Studio", owner: "demo", models: [{ id: "image-model", types: ["image"] }] }] });
      case "/api/settings": return route.fulfill({ json: {} });
      case "/api/jobs": {
        const query = new URL(route.request().url()).searchParams.get('q') || '';
        const items = jobs.filter(job => String((job as {form?:{prompt?:string}}).form?.prompt || '').toLowerCase().includes(query.toLowerCase()));
        return route.fulfill({ json: { items, total: items.length, nextCursor: null, token: JSON.stringify(items), unchanged: false, active: false } });
      }
      default: return route.fulfill({ status: 404, json: { error: "Unexpected fixture request" } });
    }
  });
}

async function bounds(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`Missing box for ${selector}`);
  return { ...box, right: box.x + box.width, bottom: box.y + box.height, cy: box.y + box.height / 2 };
}

for (const width of [1680, 1440, 851, 850, 560, 390, 320]) {
  test(`composer and history headers at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1050 });
    await mockStudio(page, [{ id: "layout", form, tasks: [], status: "queued", created: "2026-11-17T08:00:00Z" }]);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "创作参数" })).toBeVisible();
    const search = page.getByRole("searchbox", { name: "搜索任务提示词" });
    await search.fill("布局预览");
    await expect(page.locator('.history-count')).toHaveText('1 个记录');
    const composer = await bounds(page, ".composer");
    const composerHead = await bounds(page, ".composer .section-head");
    const composerTitle = await bounds(page, ".composer h2");
    const composerAction = await bounds(page, '.composer [aria-label="快速生成提示词"]');
    const formBox = await bounds(page, ".composer form");
    const history = await bounds(page, ".history");
    const historyHead = await bounds(page, ".history-head");
    const historyTitle = await bounds(page, ".history-head h2");
    const count = await bounds(page, ".history-head .history-count");
    const searchBox = await bounds(page, ".history-search");
    const clear = await bounds(page, '.history-search [aria-label="清除搜索"]');
    expect(composerHead.bottom).toBeLessThan(formBox.y);
    const backgrounds = await page.locator(".composer").evaluate((el) => [el, el.querySelector("form")!].map((node) => getComputedStyle(node).backgroundColor));
    expect(backgrounds[0]).toBe("rgba(0, 0, 0, 0)");
    expect(backgrounds[1]).toBe("rgb(255, 255, 255)");
    expect(Math.abs(composerTitle.cy - composerAction.cy)).toBeLessThan(1);
    expect(Math.abs(historyTitle.cy - searchBox.cy)).toBeLessThan(1);
    expect(Math.abs(composerHead.height - historyHead.height)).toBeLessThan(1);
    expect(count.x).toBeGreaterThan(historyTitle.right);
    expect(searchBox.x).toBeGreaterThan(count.right);
    expect(clear.right).toBeLessThan(searchBox.right);
    expect(searchBox.right).toBeLessThanOrEqual(history.right);
    if (width > 850) {
      expect(Math.abs(composer.width - history.width)).toBeLessThan(1);
      expect(Math.abs(composerTitle.cy - historyTitle.cy)).toBeLessThan(1);
      expect(Math.abs(composerHead.bottom - historyHead.bottom)).toBeLessThan(1);
      expect(Math.abs((await bounds(page, '.history .job')).y - formBox.y)).toBeLessThan(1);
    } else {
      expect(Math.abs(composer.x - history.x)).toBeLessThan(1);
      expect(Math.abs(composerTitle.x - historyTitle.x)).toBeLessThan(1);
      expect(composer.bottom).toBeLessThan(historyHead.y);
    }
    await page.getByRole("button", { name: "清除搜索", exact: true }).click();
    await expect(search).toHaveValue("");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if (width === 320) {
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: testInfo.outputPath("composer-320-light.png"), animations: "disabled" });
    }
  });
}

const artwork = (width: number, height: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 100 100" preserveAspectRatio="none"><path fill="#283751" d="M0 0h100v100H0z"/><circle fill="#ffc992" cx="73" cy="24" r="13"/><path fill="#637ea2" d="M0 67 25 34 54 66 80 43 100 63v37H0z"/><path fill="#455f78" d="M0 84 36 62 67 81 100 69v31H0z"/></svg>`;

async function artworkPng(page: Page, width: number, height: number) {
  const png = await page.evaluate(async (svg) => {
    const image = new Image();
    image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext("2d")!.drawImage(image, 0, 0);
    return canvas.toDataURL("image/png").split(",")[1];
  }, artwork(width, height));
  return Buffer.from(png, "base64");
}

test("two 1086 × 1448 portrait previews pack left and wrap when needed", async ({ page }, testInfo) => {
  const desktopWidth = 1440;
  await page.setViewportSize({ width: desktopWidth, height: 1050 });
  const width = 1086, height = 1448;
  const png = await artworkPng(page, width, height);
  const tasks = ["portrait-a", "portrait-b"].map((asset) => ({ id: asset, asset, width, height, status: "succeeded" }));
  await mockStudio(page, [{
    id: "portraits", form: { ...form, count: 2 }, tasks, status: "succeeded", created: "2026-11-17T08:00:00Z",
  }], new Map(tasks.map(({ asset }) => [asset, png])));
  await page.goto("/");
  const previews = page.getByRole("button", { name: "查看图片", exact: true });
  await expect(previews).toHaveCount(2);
  for (const preview of await previews.all()) {
    const image = preview.locator("img");
    await expect.poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await expect(image).toHaveCSS("object-fit", "contain");
  }

  const first = ".result-image:nth-child(1)";
  const second = ".result-image:nth-child(2)";
  for (const viewportWidth of [desktopWidth, 320, 300]) {
    await page.setViewportSize({ width: viewportWidth, height: 1050 });
    const a = await bounds(page, `${first} .image-open`);
    const b = await bounds(page, `${second} .image-open`);
    const meta = await bounds(page, ".job-meta");
    for (const box of [a, b]) {
      expect(box.width).toBeCloseTo(120, 0);
      expect(box.height).toBeCloseTo(160, 0);
      expect(box.right).toBeLessThanOrEqual(meta.right);
    }
    expect(a.x).toBeCloseTo(meta.x, 0);
    if (viewportWidth >= 320) {
      expect(b.y).toBeCloseTo(a.y, 0);
      expect(b.x - a.right, "gap between the visible portraits").toBeCloseTo(12, 0);
    } else {
      expect(b.x).toBeCloseTo(a.x, 0);
      expect(b.y - (await bounds(page, first)).bottom).toBeCloseTo(12, 0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewportWidth);
    if (viewportWidth === desktopWidth) {
      await page.locator(".job").screenshot({ path: testInfo.outputPath("packed-portraits-1440.png"), animations: "disabled" });
    }
  }
});

const results = [
  { asset: "portrait", width: 180, height: 320 },
  { asset: "square", width: 240, height: 240 },
  { asset: "landscape", width: 320, height: 180 },
  { asset: "unknown", width: 240, height: 180 },
];

for (const { width, theme } of [{ width: 1440, theme: "light" }, { width: 320, theme: "dark" }]) {
  test(`compact history previews at ${width}px in ${theme} theme`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1050 });
    await page.addInitScript((theme) => localStorage.setItem("bimage-theme", theme), theme);
    const task = ({ asset, width, height }: (typeof results)[number]) => ({
      id: asset, asset, status: "succeeded", ...(asset !== "unknown" ? { width, height } : {}),
    });
    const assets = new Map(await Promise.all(results.map(async ({ asset, width, height }) =>
      [asset, await artworkPng(page, width, height)] as const,
    )));
    const job = { id: "single", form, tasks: [task(results[0])], status: "succeeded", created: "2026-11-17T08:00:00Z" };
    await mockStudio(page, [job, {
      ...job, id: "mixed", form: { ...form, count: 4 },
      tasks: [...results.slice(1).map(task), { id: "failed", status: "failed", error: "示例错误" }],
    }], assets);
    const fetched: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/api/assets/")) fetched.push(req.url().split("/").pop()!);
    });
    await page.goto("/");
    const previews = page.getByRole("button", { name: "查看图片", exact: true });
    await expect(previews).toHaveCount(4);

    for (const [index, result] of results.entries()) {
      const preview = previews.nth(index);
      await preview.scrollIntoViewIfNeeded();
      const image = preview.locator("img");
      await expect.poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(result.width);
      await expect(image).toHaveCSS("object-fit", "contain");
      const box = (await preview.boundingBox())!;
      const ratio = result.asset === "unknown" ? 1 : result.width / result.height;
      expect(Math.abs(box.width - box.height * ratio)).toBeLessThan(1);
      expect(box.height).toBeLessThanOrEqual(160);
      expect(box.width).toBeLessThanOrEqual(288);
      const card = page.locator(".result-image").filter({ has: page.locator(".image-open") }).nth(index);
      await expect(card.locator(".actual-spec")).toHaveText(result.asset === "unknown" ? "规格未知" : `${result.width} × ${result.height}`);
      const itemBox = (await card.boundingBox())!;
      const specBox = (await card.locator(".actual-spec").boundingBox())!;
      expect(Math.abs(box.x - itemBox.x)).toBeLessThan(1);
      expect(Math.abs(specBox.x - itemBox.x)).toBeLessThan(1);
      if (index < 2) {
        const metadata = (await page.locator(".job-meta").nth(index).boundingBox())!;
        expect(Math.abs(box.x - metadata.x)).toBeLessThan(1);
      }
      const tools = card.locator(".image-tools");
      await expect(tools.getByRole("button", { name: "复制图片" })).toBeVisible();
      await expect(tools.getByRole("button", { name: "下载图片" })).toBeVisible();
      const caption = (await card.locator(".result-caption").boundingBox())!;
      const toolbar = (await tools.boundingBox())!;
      expect(caption.y - (box.y + box.height)).toBeCloseTo(6, 0);
      expect(toolbar.y).toBeGreaterThanOrEqual(caption.y);
      expect(toolbar.y).toBeLessThanOrEqual(specBox.y + specBox.height + 4);
      expect(toolbar.x + toolbar.width).toBeLessThanOrEqual(itemBox.x + itemBox.width);
    }
    await expect(page.locator(".result-placeholder")).toContainText("示例错误");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await previews.first().scrollIntoViewIfNeeded();
    await page.evaluate((width) => {
      if (width > 850) scrollTo(0, 0);
      else document.querySelector(".history")!.scrollIntoView({ block: "start" });
    }, width);
    await page.screenshot({ path: testInfo.outputPath(`history-${width}-${theme}.png`), animations: "disabled" });

    await previews.first().focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "图片预览" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("img")).toHaveAttribute("src", /^blob:/);
    expect(fetched.filter((id) => id === "portrait")).toHaveLength(1);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(previews.first()).toBeFocused();
  });
}
