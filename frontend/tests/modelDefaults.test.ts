import { describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import SettingsPanel from "../src/components/SettingsPanel.vue";
import ModelSelect from "../src/components/ModelSelect.vue";
import QuickPrompt from "../src/components/QuickPrompt.vue";
import Composer from "../src/components/Composer.vue";
import { emptyForm } from "../src/domain";
import type { Api, Provider, Run, Settings } from "../src/types";

const providers: Provider[] = [
  { id: "a", name: "A", models: [{ id: "opt", types: ["text"] }, { id: "image", types: ["image"] }] },
  { id: "b", name: "B", models: [{ id: "quick", types: ["text"] }] },
];
const run: Run = async fn => fn();
const defaults = { textProvider: "a", textModel: "opt", quickProvider: "b", quickModel: "quick", imageProvider: "a", imageModel: "image" };

describe("provider-page model defaults", () => {
  it("shows all three defaults inside Providers and saves only choices over fresh settings with a request lock", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let saved: Settings = {};
    const api = vi.fn(async (path: string, body?: unknown) => {
      if (body) { saved = body as Settings; await held; }
      return saved;
    }) as Api;
    const w = mount(SettingsPanel, { props: { providers, settings: defaults, signal: new AbortController().signal, site: { title: "Bimage" }, identity: { id: "me", name: "Me", role: "user", csrf: "fixture" }, api, run } });
    expect(w.find('[role="tab"]').text()).toBe("供应商");
    expect(w.findAll('[role="tab"]').map(tab => tab.text())).not.toContain("默认模型");
    const section = w.get(".provider-settings");
    const choices = section.findAllComponents(ModelSelect);
    expect(choices.map(select => [select.props("label"), select.props("kind")])).toEqual([["快速提示词", "text"], ["提示词优化", "text"], ["生图模型", "image"]]);
    choices[0].vm.$emit("change", "b", "quick");
    choices[1].vm.$emit("change", "a", "opt");
    choices[2].vm.$emit("change", "a", "image");
    const form = { ...emptyForm(), prompt: "最新草稿", model: "restored", references: ["latest-reference"] };
    await w.setProps({ settings: { ...defaults, form, unrelated: "fresh" } as Settings });
    const save = w.findAll("button").find(button => button.text() === "保存默认模型")!;
    await save.trigger("click");
    await save.trigger("click");
    expect(api).toHaveBeenCalledTimes(1);
    expect(save.attributes("disabled")).toBeDefined();
    expect(w.get('[role="status"]').text()).toContain("保存中");
    expect(saved).toEqual({ ...defaults, form, unrelated: "fresh" });
    release();
    await flushPromises();
    expect(api).toHaveBeenCalledTimes(2);
    expect(w.emitted("settings")?.[0]).toEqual([saved]);
    expect(w.get('[role="status"]').text()).toBe("默认模型已保存");
    expect(save.attributes("disabled")).toBeUndefined();
    w.unmount();
  });

  it("starts the editor at legacy effective choices and reports failed saves without remaining locked", async () => {
    const api = vi.fn(async () => { throw Error("fixture offline"); }) as Api;
    const safeRun: Run = async fn => { try { return await fn(); } catch { return undefined; } };
    const w = mount(SettingsPanel, { props: { providers, settings: { textProvider: "a", textModel: "opt" }, signal: new AbortController().signal, site: { title: "Bimage" }, identity: { id: "me", name: "Me", role: "user", csrf: "fixture" }, api, run: safeRun } });
    const quick = w.findAllComponents(ModelSelect).find(select => select.props("label") === "快速提示词")!;
    expect(quick.props()).toMatchObject({ providerId: "a", model: "opt" });
    const save = w.findAll("button").find(button => button.text() === "保存默认模型")!;
    await save.trigger("click");
    await flushPromises();
    expect(w.get('[role="status"]').text()).toContain("保存失败");
    expect(save.attributes("disabled")).toBeUndefined();
    w.unmount();
  });
});

it("sends quick and inline optimization to their distinct providers/models and leaves the image draft untouched", async () => {
  const api = vi.fn(async () => ({ text: "优化后。" })) as Api;
  const signal = new AbortController().signal;
  const form = { ...emptyForm(), providerId: "draft-provider", model: "restored-image", prompt: "原句。" };
  const quick = mount(QuickPrompt, { props: { form, settings: defaults, api, signal, run }, global: { stubs: { Modal: { template: '<div><slot /></div>' } } } });
  await quick.findAll("button").find(button => button.text().includes("生成提示词"))!.trigger("click");
  await flushPromises();
  expect(api).toHaveBeenLastCalledWith("/rewrite", { providerId: "b", model: "quick", prompt: "原句。", references: [] }, undefined, expect.any(AbortSignal));
  const composer = mount(Composer, { props: { form, settings: defaults, providers, api, signal, run, busy: false } });
  await composer.get(".prompt-optimize").trigger("click");
  await flushPromises();
  expect(api).toHaveBeenLastCalledWith("/rewrite", { providerId: "a", model: "opt", prompt: "原句。", references: [] }, undefined, expect.any(AbortSignal));
  expect(composer.emitted("update:form")).toBeUndefined();
  expect(form).toMatchObject({ providerId: "draft-provider", model: "restored-image", prompt: "原句。" });
  quick.unmount(); composer.unmount();
});
