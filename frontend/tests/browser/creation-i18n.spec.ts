/// <reference types="node" />
import { test, expect } from "@playwright/test";
import { Buffer } from 'node:buffer';

for (const width of [1280, 320]) {
  test(`creation translations retain draft and dialog inputs at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 980 });
    const writes: { path: string; body: unknown }[] = [];
    const form = { providerId: "fixture-provider", model: "图像模型原名", prompt: "用户原文\n保留第二行", references: ["fixture-reference"], autoSize: true, ratio: "1:1", resolution: "1K", size: "1024x1024", quality: "high", count: 3, output_format: "png" };
    const settings = { form, quickProvider: "fixture-provider", quickModel: "文本模型原名", textProvider: "fixture-provider", textModel: "文本模型原名" };
    const image = await page.request.get("/Bimage.png").then(response => response.body());
    await page.route("**/api/**", async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname.slice(4);
      if (!["GET", "HEAD"].includes(request.method())) writes.push({ path, body: request.postDataJSON() });
      if (path.startsWith("/assets/")) return route.fulfill({ status: 200, contentType: "image/png", body: image });
      const response = path === "/site" ? { title: "Bimage", icon: "" }
        : path === "/setup" ? { required: false }
        : path === "/me" ? { id: "fixture-user", name: "Test creator", role: "user", csrf: "fixture" }
        : path === "/settings" ? settings
        : path === "/providers" ? [{ id: "fixture-provider", owner: "fixture-user", name: "供应商原名", models: [{ id: "图像模型原名", types: ["image"] }, { id: "文本模型原名", types: ["text"] }] }]
        : path === "/jobs" ? { items: [], total: 0, active: false, token: "fixture", unchanged: false, nextCursor: null, removedIds: [] }
        : {};
      await route.fulfill({ json: response });
    });
    await page.goto("/");
    const prompt = page.locator("#composer-prompt");
    await expect(prompt).toHaveValue(form.prompt);
    await page.getByRole("button", { name: "English", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Creation settings" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Clear prompt and references" })).toHaveAttribute("title", "Clear prompt and references");
    await expect(page.getByRole("combobox", { name: "Image model", exact: true })).toContainText("图像模型原名");
    await expect(page.getByRole("button", { name: "Remove reference image" })).toBeVisible();
    await expect(prompt).toHaveValue(form.prompt);
    await expect(page.getByRole("button", { name: "Generate 3 images" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`creation-en-${width}.png`) });

    if (width === 1280) {
      await page.locator('.composer input[type=file]').setInputFiles({ name: 'unsupported.txt', mimeType: 'text/plain', buffer: Buffer.from('fixture') });
      const notice = page.locator('.toast[data-type="error"]');
      await expect(notice).toContainText('Only PNG, JPEG and WebP are supported');
      await page.getByRole('button', { name: '简体中文', exact: true }).click();
      await expect(notice.filter({ hasText: '仅支持 PNG、JPEG、WebP' })).toBeVisible();
      await page.getByRole('button', { name: 'English', exact: true }).click();
    }

    await page.getByRole("button", { name: "Quick prompt", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const intent = dialog.getByRole("textbox", { name: "Brief intent" });
    await intent.fill("我的草稿意图 🐈");
    await intent.evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(2, 5));
    await expect(dialog.getByText("Quick prompt model · 文本模型原名", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Generate prompt", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`quick-prompt-en-${width}.png`) });
    await page.evaluate(async () => {
      const sourceModule = "/src/i18n.ts";
      const module = await import(/* @vite-ignore */ sourceModule);
      module.setLocale("zh-CN");
    });
    await expect(dialog.getByRole("heading", { name: "快速生成提示词", exact: true })).toBeVisible();
    const zhIntent = dialog.getByRole("textbox", { name: "简短意图" });
    await expect(zhIntent).toHaveValue("我的草稿意图 🐈");
    expect(await zhIntent.evaluate((field: HTMLTextAreaElement) => [field.selectionStart, field.selectionEnd])).toEqual([2, 5]);
    await expect(dialog.getByRole("button", { name: "移除参考图" })).toBeVisible();
    expect(writes.filter(write => ["/rewrite", "/jobs", "/assets"].includes(write.path))).toEqual([]);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(prompt).toHaveValue(form.prompt);
    await expect(page.getByRole("combobox", { name: "图像模型", exact: true })).toContainText("图像模型原名");
  });
}
