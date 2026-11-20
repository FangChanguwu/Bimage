import { expect, test, type Page } from "@playwright/test";
import { emptyForm } from "../../src/domain";
import type { Provider, Settings } from "../../src/types";

const providers: Provider[] = [
  { id: "q", owner: "member", name: "Quick provider", models: [{ id: "fast-text", types: ["text"] }] },
  { id: "o", owner: "member", name: "Optimize provider", models: [{ id: "quality-text", types: ["text"] }] },
  { id: "i", owner: "member", name: "Image provider", models: [{ id: "default-image", types: ["image"] }, { id: "restored-image", types: ["image"] }] },
];
async function fixture(page: Page) {
  const state = {
    settings: { form: { ...emptyForm(), providerId: "i", model: "restored-image", prompt: "草稿原句。", size: "2048x1024", autoSize: false }, unrelated: "retained" } as Settings,
    writes: [] as { path: string; body: Record<string, unknown> }[],
  };
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname.slice(4), method = request.method();
    const body = method === "GET" ? undefined : request.postDataJSON();
    if (body) state.writes.push({ path, body });
    if (path === "/setup") return route.fulfill({ json: { required: false } });
    if (path === "/site") return route.fulfill({ json: { title: "Bimage" } });
    if (path === "/me") return route.fulfill({ json: { id: "member", name: "Fixture", role: "user", csrf: "fixture" } });
    if (path === "/providers") return route.fulfill({ json: providers });
    if (path === "/jobs" && method === "GET") return route.fulfill({ json: [] });
    if (path === "/settings") {
      if (method === "PUT") state.settings = body;
      return route.fulfill({ json: state.settings });
    }
    if (path === "/rewrite") return route.fulfill({ json: { text: "草稿优化结果。" } });
    return route.fulfill({ status: 500, json: { error: `Unexpected fixture request: ${method} ${path}` } });
  });
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "提示词", exact: true })).toHaveValue("草稿原句。");
  return state;
}

for (const { width, theme } of [{ width: 1440, theme: "light" }, { width: 320, theme: "dark" }]) {
  test(`three provider defaults persist and reload without replacing restored draft at ${width}px ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(value => localStorage.setItem("bimage-theme", value), theme);
    const state = await fixture(page);
    await page.getByRole("button", { name: "系统设置", exact: true }).click();
    await expect(page.getByRole("tab", { name: "默认模型", exact: true })).toHaveCount(0);
    const section = page.locator(".provider-settings");
    const quick = section.getByRole("combobox", { name: "快速提示词", exact: true });
    const optimize = section.getByRole("combobox", { name: "提示词优化", exact: true });
    const image = section.getByRole("combobox", { name: "生图模型", exact: true });
    await quick.focus();
    await page.keyboard.press("End");
    await expect(page.getByRole("option", { name: /image/ })).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(quick).toContainText("quality-text");
    await quick.click();
    await page.getByRole("option", { name: "fast-text Quick provider", exact: true }).click();
    await optimize.click();
    await page.getByRole("option", { name: "quality-text Optimize provider", exact: true }).click();
    await image.click();
    await expect(page.getByRole("option", { name: /text/ })).toHaveCount(0);
    await page.getByRole("option", { name: "default-image Image provider", exact: true }).click();
    await page.getByRole("button", { name: "保存默认模型", exact: true }).click();
    await expect(section.getByRole("status")).toHaveText("默认模型已保存");
    expect(state.settings).toMatchObject({ quickProvider: "q", quickModel: "fast-text", textProvider: "o", textModel: "quality-text", imageProvider: "i", imageModel: "default-image", unrelated: "retained", form: { model: "restored-image", prompt: "草稿原句。", size: "2048x1024" } });
    await page.reload();
    await expect(page.getByRole("combobox", { name: "图像模型", exact: true })).toContainText("restored-image");
    await expect(page.getByRole("textbox", { name: "提示词", exact: true })).toHaveValue("草稿原句。");
    await page.getByRole("button", { name: "系统设置", exact: true }).click();
    await expect(quick).toContainText("fast-text");
    await expect(optimize).toContainText("quality-text");
    await expect(image).toContainText("default-image");
    const save = page.getByRole("button", { name: "保存默认模型", exact: true });
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeInViewport();
    const panels = section.locator(":scope > section");
    const listBounds = (await panels.nth(0).boundingBox())!;
    const defaultsBounds = (await panels.nth(1).boundingBox())!;
    expect(defaultsBounds.y - listBounds.y - listBounds.height).toBeGreaterThanOrEqual(20);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`defaults-${width}-${theme}.png`), animations: "disabled" });
    await page.getByRole("button", { name: "图像工作台", exact: true }).click();
    await page.getByRole("button", { name: "快速生成提示词", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "快速生成提示词" });
    await expect(dialog.getByText("快速提示词模型 · fast-text", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "生成提示词", exact: true }).click();
    await expect(dialog.getByRole("textbox", { name: "生成结果", exact: true })).toHaveValue("草稿优化结果。");
    expect(state.writes.filter(write => write.path === "/rewrite").map(write => write.body)).toEqual([{ providerId: "q", model: "fast-text", prompt: "草稿原句。", references: [] }]);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: "优化", exact: true }).click();
    await expect(page.getByRole("button", { name: "应用", exact: true })).toBeVisible();
    expect(state.writes.filter(write => write.path === "/rewrite").map(write => write.body)).toEqual([
      { providerId: "q", model: "fast-text", prompt: "草稿原句。", references: [] },
      { providerId: "o", model: "quality-text", prompt: "草稿原句。", references: [] },
    ]);
    expect(state.writes.some(write => write.path === "/jobs")).toBe(false);
  });
}
