import { expect, test, type Page } from "@playwright/test";
import type { Model, Provider } from "../../src/types";

const catalog: Model[] = [
  { id: "unknown-model", types: [], reason: "未知模型：请手动指定用途" },
  { id: "image-model", types: ["image", "text"], reason: "上游模型元数据" },
  { id: "text-model", types: ["text"] },
];

async function fixture(page: Page, role: "admin" | "user" = "admin", initial: Provider[] = []) {
  const state = {
    providers: initial,
    discovery: catalog,
    writes: [] as { method: string; path: string; body: Record<string, unknown> }[],
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.slice(4);
    const method = request.method();
    const body = method === "GET" ? null : request.postDataJSON();
    if (body) state.writes.push({ path, method, body });
    if (path === "/site") return route.fulfill({ json: { title: "Bimage" } });
    if (path === "/setup") return route.fulfill({ json: { required: false } });
    if (path === "/me") return route.fulfill({ json: { id: role, name: "Fixture", role, csrf: "fixture-csrf" } });
    if (path === "/settings") return route.fulfill({ json: {} });
    if (path === "/jobs" && method === "GET") return route.fulfill({ json: [] });
    if (path === "/providers" && method === "GET") return route.fulfill({ json: state.providers });
    if (method === "POST" && /^\/providers(?:\/p)?\/models$/.test(path)) {
      return route.fulfill({ json: { data: state.discovery } });
    }
    if ((path === "/providers" && method === "POST") || (path === "/providers/p" && method === "PATCH")) {
      const provider: Provider = {
        id: "p", owner: role, name: body.name, baseUrl: body.baseUrl,
        hasKey: !!body.apiKey || !!state.providers[0]?.hasKey,
        shared: body.shared, canManage: true, models: body.models,
      };
      state.providers = [provider];
      return route.fulfill({ json: provider });
    }
    return route.fulfill({ status: 500, json: { error: `Unexpected fixture request: ${method} ${path}` } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "系统设置", exact: true }).click();
  return state;
}

test("adding a provider saves unknown models as text and saves keyboard changes", async ({ page }) => {
  const state = await fixture(page);
  const add = page.getByRole("button", { name: "添加供应商", exact: true });
  await expect(page.getByText("OpenAI-compatible API · API Key 仅保存在服务端。", { exact: true })).toHaveCount(0);
  await expect(page.getByText("共享供应商仅提供固定配置的使用权；只有所有者或管理员能修改、刷新目录。", { exact: true })).toHaveCount(0);
  await add.click();
  const dialog = page.getByRole("dialog", { name: "添加供应商" });
  const key = dialog.getByLabel("API Key", { exact: true });
  await expect(key).toHaveAttribute("placeholder", "请输入API Key");
  await expect(key).toHaveAttribute("type", "password");
  await key.fill("fixture-key-not-real");
  await expect(dialog.getByText("高级配置", { exact: true })).toHaveCount(0);
  const share = dialog.getByRole("switch", { name: "开放共享供应商" });
  await expect(share).toHaveAccessibleDescription("设置为共享将让此供应商配置被所有用户可见并使用。");
  await share.click();
  await dialog.getByRole("textbox", { name: "名称" }).fill("Fixture provider");
  await dialog.getByRole("textbox", { name: "Base URL" }).fill("https://provider.invalid/v1");
  await dialog.getByRole("button", { name: "获取模型", exact: true }).click();
  const unknown = dialog.getByRole("switch", { name: "unknown-model 用途", exact: true });
  const image = dialog.getByRole("switch", { name: "image-model 用途", exact: true });
  const text = dialog.getByRole("switch", { name: "text-model 用途", exact: true });
  await expect(unknown).toHaveAttribute("aria-checked", "false", { timeout: 3000 });
  await expect(dialog.getByText("文本", { exact: true })).toHaveCount(2);
  await expect(image).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByText("图像", { exact: true })).toHaveCount(1);
  await expect(dialog.getByText(/上游模型元数据|未知模型：|可手动指定用途/)).toHaveCount(0);
  await expect(dialog.getByRole("combobox")).toHaveCount(0);
  await unknown.focus();
  await page.keyboard.press("Tab");
  await expect(image).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(text).toBeFocused();
  await page.keyboard.press("Space");
  await expect(text).toHaveAttribute("aria-checked", "true");
  await dialog.getByRole("button", { name: "保存供应商" }).click();
  await expect(dialog).toHaveCount(0);
  const saves = state.writes.filter(({ path }) => path === "/providers");
  expect(saves).toHaveLength(1);
  expect(saves[0].body).toMatchObject({ shared: true, apiKey: "fixture-key-not-real" });
  expect(saves[0].body.models).toMatchObject([
    { id: "unknown-model", types: ["text"] },
    { id: "image-model", types: ["image"] },
    { id: "text-model", types: ["image"] },
  ]);
  expect(Object.keys(saves[0].body).sort()).toEqual(["apiKey", "baseUrl", "kind", "models", "name", "shared"]);
  await expect(page.getByText("Fixture provider", { exact: true })).toBeVisible();
  await expect(page.getByText("fixture-key-not-real", { exact: true })).toHaveCount(0);
  await expect(add).toBeFocused();
  expect(state.writes.some(({ path }) => path === "/jobs")).toBe(false);
});

const saved: Provider = {
  id: "p", owner: "admin", name: "Fixture provider", baseUrl: "https://provider.invalid/v1",
  canManage: true, hasKey: true, shared: true,
  models: [
    { id: "legacy-dual", types: ["text", "image"] },
    { id: "image-model", types: ["text"], reason: "手动指定用途" },
    { id: "text-model", types: ["text"] },
  ],
};

for (const width of [1440, 320]) {
  test(`provider divider is separated from add button at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page, "admin", [saved]);
    const add = page.getByRole("button", { name: "添加供应商", exact: true });
    const row = page.locator(".provider-row").first();
    const buttonBounds = (await add.boundingBox())!;
    const rowBounds = (await row.boundingBox())!;
    expect(rowBounds.y - (buttonBounds.y + buttonBounds.height)).toBeGreaterThanOrEqual(15);
    expect(rowBounds.y - (buttonBounds.y + buttonBounds.height)).toBeLessThanOrEqual(25);
    await page.screenshot({ path: testInfo.outputPath(`provider-spacing-${width}.png`), animations: "disabled" });
  });
}

test("rediscovery and editing retain saved and unsaved manual choices and untouched dual models", async ({ page }) => {
  const state = await fixture(page, "admin", [saved]);
  state.discovery = [...catalog, { id: "legacy-dual", types: ["image"] }];
  const edit = page.getByRole("button", { name: "编辑", exact: true });
  await edit.click();
  const dialog = page.getByRole("dialog", { name: "编辑供应商" });
  const key = dialog.getByLabel("新 API Key（留空保持原值）", { exact: true });
  const purposes = (id: string) => dialog.getByRole("switch", { name: `${id} 用途`, exact: true });
  await expect(key).toHaveValue("");
  await expect(key).toHaveAttribute("placeholder", "请输入API Key");
  await expect(purposes("legacy-dual")).toHaveAttribute("aria-checked", "true");
  await purposes("text-model").click();
  await dialog.getByRole("button", { name: "获取模型", exact: true }).click();
  await expect(purposes("unknown-model")).toHaveAttribute("aria-checked", "false");
  await expect(purposes("image-model")).toHaveAttribute("aria-checked", "false");
  await expect(purposes("text-model")).toHaveAttribute("aria-checked", "true");
  await expect(purposes("legacy-dual")).toHaveAttribute("aria-checked", "true");
  await dialog.getByRole("button", { name: "保存修改" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("4 个模型 · 密钥已保存")).toBeVisible();
  expect(state.writes.map(({ method, path }) => `${method} ${path}`)).toEqual(["POST /providers/p/models", "PATCH /providers/p"]);
  expect(state.writes[1].body).toMatchObject({ apiKey: "", models: [
    { id: "unknown-model", types: ["text"] },
    { id: "image-model", types: ["text"] },
    { id: "text-model", types: ["image"] },
    { id: "legacy-dual", types: ["text", "image"] },
  ] });
  await edit.click();
  await expect(purposes("text-model")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(edit).toBeFocused();
});

test("a shared consumer can select models but cannot see connection details or edit the provider", async ({ page }) => {
  // Deliberately include connection metadata in the fixture to verify the UI gate,
  // even though the actual API redacts the address on this response.
  const state = await fixture(page, "user", [{ ...saved, canManage: false }]);
  const row = page.locator(".provider-row");
  await expect(row.getByText("Fixture provider", { exact: true })).toBeVisible();
  await expect(row.getByText("只读目录", { exact: true })).toBeVisible();
  await expect(row.getByText(saved.baseUrl!, { exact: true })).toHaveCount(0);
  await expect(row.getByText(/密钥已保存|无密钥/)).toHaveCount(0);
  await expect(row.getByRole("button", { name: /编辑|删除/ })).toHaveCount(0);
  const imageDefault = page.getByRole("combobox", { name: "生图模型", exact: true });
  await imageDefault.click();
  await page.getByRole("option", { name: "legacy-dual Fixture provider", exact: true }).click();
  await expect(imageDefault).toContainText("legacy-dual");
  expect(state.writes).toHaveLength(0);
});

for (const { width, height, theme } of [
  { width: 1440, height: 900, theme: "light" },
  { width: 320, height: 670, theme: "dark" },
]) {
  test(`provider dialog has a single scroll surface at ${width}px in ${theme}`, async ({ page }, testInfo) => {
    const longId = `model-${"long-identifier".repeat(12)}`;
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript((value) => localStorage.setItem("bimage-theme", value), theme);
    const models = [
      { id: longId, types: ["image"] },
      ...Array.from({ length: 30 }, (_, i) => ({ id: `fixture-model-${i + 1}`, types: ["text"] })),
    ];
    await fixture(page, "admin", [{ ...saved, models }]);
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "编辑供应商" });
    const share = dialog.getByRole("switch", { name: "开放共享供应商" });
    const catalog = dialog.locator(".model-catalog");
    const geometry = await dialog.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width, top: rect.top, bottom: rect.bottom, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, clientWidth: el.clientWidth, scrollWidth: el.scrollWidth };
    });
    expect(geometry.left).toBeGreaterThan(0);
    expect(geometry.right).toBeLessThan(width);
    expect(geometry.top).toBeGreaterThan(0);
    expect(geometry.bottom).toBeLessThan(height);
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
    expect(geometry.scrollWidth).toBe(geometry.clientWidth);
    expect(geometry.width / width).toBeGreaterThan(width === 320 ? 0.9 : 0.5);
    expect(geometry.width / width).toBeLessThan(width === 320 ? 1 : 0.8);
    expect(await catalog.evaluate(el => el.scrollHeight === el.clientHeight)).toBe(true);

    const first = dialog.getByRole("switch", { name: `${longId} 用途`, exact: true });
    const knob = (element: typeof first) => element.evaluate(el => {
      const track = el.getBoundingClientRect();
      const thumb = el.firstElementChild!.getBoundingClientRect();
      return [track.width, track.height, thumb.width, thumb.height, thumb.left - track.left];
    });
    expect(await knob(share)).toEqual([44, 26, 20, 20, 21]);
    expect(await knob(first)).toEqual([44, 26, 20, 20, 21]);
    expect(await knob(dialog.getByRole("switch", { name: "fixture-model-1 用途", exact: true }))).toEqual([44, 26, 20, 20, 3]);
    await page.screenshot({ path: testInfo.outputPath(`provider-${width}-${theme}.png`), animations: "disabled" });

    const last = dialog.getByRole("switch", { name: "fixture-model-30 用途", exact: true });
    await last.focus();
    await expect(last).toBeInViewport();
    expect(await dialog.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    expect(await catalog.evaluate(el => el.scrollTop)).toBe(0);
    await page.keyboard.press("Space");
    await expect(last).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath(`provider-${width}-${theme}-scrolled.png`), animations: "disabled" });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });
}
