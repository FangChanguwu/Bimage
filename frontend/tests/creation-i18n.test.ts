import { afterEach, expect, it, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import Composer from "../src/components/Composer.vue";
import QuickPrompt from "../src/components/QuickPrompt.vue";
import ModelSelect from "../src/components/ModelSelect.vue";
import SelectControl from "../src/components/SelectControl.vue";
import { emptyForm } from "../src/domain";
import { setLocale, t } from "../src/i18n";
import { uploadReferences } from "../src/composables/useReferences";
import { rewritePrompt } from "../src/composables/promptRewrite";
import type { Api, GenerationForm, Run } from "../src/types";

const wrappers: VueWrapper[] = [];
const run: Run = async action => action();
const signal = () => new AbortController().signal;
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount());
  setLocale("zh-CN");
  document.body.innerHTML = "";
});

it("switches Composer copy and aria without changing the draft, references or open selection", async () => {
  setLocale("zh-CN");
  const api = vi.fn();
  let form: GenerationForm = { ...emptyForm(), prompt: "自动 · 用户原文 🐈", references: ["original-reference"], providerId: "p", model: "历史模型", autoSize: false, quality: "high", count: 3 };
  const wrapper = mount(Composer, {
    attachTo: document.body,
    props: { form, providers: [{ id: "p", name: "供应商原名", models: [{ id: "历史模型", types: ["image"] }] }], api, signal: signal(), run, busy: false, settings: {},
      "onUpdate:form": (next: GenerationForm) => { form = next; void wrapper.setProps({ form }); } },
    global: { stubs: { AssetImage: true, Lightbox: true } },
  });
  wrappers.push(wrapper);
  const prompt = wrapper.get<HTMLTextAreaElement>("#composer-prompt");
  prompt.element.focus();
  prompt.element.setSelectionRange(3, 5);
  const quality = wrapper.get('[role="combobox"][aria-label="质量"]');
  await quality.trigger("click");
  expect(wrapper.text()).toContain("创作参数");
  expect(wrapper.get('[aria-label="清空提示词和参考图"]')).toBeDefined();
  const original = structuredClone(form);

  setLocale("en");
  await nextTick();
  expect(wrapper.text()).toContain("Creation settings");
  expect(wrapper.get('[aria-label="Clear prompt and references"]').attributes("title")).toBe("Clear prompt and references");
  expect(prompt.attributes("placeholder")).toBe("Describe the scene, subject, lighting and details…");
  expect(wrapper.get('[role="combobox"][aria-label="Quality"]').attributes("aria-expanded")).toBe("true");
  expect(document.querySelector('[role="listbox"][aria-label="Quality"]')).not.toBeNull();
  expect(wrapper.get('[aria-label="Remove reference image"]')).toBeDefined();
  expect(wrapper.text()).toContain("Generate 3 images");
  expect(prompt.element.value).toBe(original.prompt);
  expect([prompt.element.selectionStart, prompt.element.selectionEnd]).toEqual([3, 5]);
  expect(form).toEqual(original);
  expect(wrapper.get('[role="combobox"][aria-label="Image model"]').text()).toContain("历史模型");
  expect(api).not.toHaveBeenCalled();
  expect(wrapper.emitted("generate")).toBeUndefined();
  expect(wrapper.emitted("update:form")).toBeUndefined();

  setLocale("zh-CN");
  await nextTick();
  expect(wrapper.get('[role="combobox"][aria-label="质量"]').attributes("data-value")).toBe("high");
  expect(wrapper.text()).toContain("生成 3 张图片");
  expect(prompt.element.value).toBe(original.prompt);
  await wrapper.setProps({ form: { ...form, count: 1 } });
  setLocale("en");
  await nextTick();
  expect(wrapper.get('button[type="submit"]').text()).toBe("Generate 1 image");
});

it("switches QuickPrompt labels and busy/result states without issuing a rewrite or changing user text", async () => {
  setLocale("zh-CN");
  let resolve!: (value: { text: string }) => void;
  const api = vi.fn(() => new Promise<{ text: string }>(done => { resolve = done; }));
  const wrapper = mount(QuickPrompt, {
    props: { form: { ...emptyForm(), prompt: "创作者原始意图", references: ["reference-id"] }, settings: { quickProvider: "provider-id", quickModel: "模型原名" }, api: api as Api, signal: signal(), run },
    global: { stubs: { Modal: { props: ["title", "locked"], template: '<section><h2>{{ title }}</h2><slot /></section>' }, AssetImage: true, Lightbox: true } },
  });
  wrappers.push(wrapper);
  const intent = wrapper.get<HTMLTextAreaElement>('[aria-label="简短意图"]');
  await intent.setValue("更新的用户意图\n保持原文");
  intent.element.setSelectionRange(2, 6);
  expect(wrapper.text()).toContain("快速生成提示词");
  setLocale("en");
  await nextTick();
  expect(wrapper.text()).toContain("Quick prompt");
  expect(wrapper.get('[aria-label="Quick prompt reference images"]')).toBeDefined();
  expect(wrapper.get('[aria-label="Brief intent"]').attributes("placeholder")).toBe("For example: a cat on a rainy street at night, cinematic lighting");
  expect(intent.element.value).toBe("更新的用户意图\n保持原文");
  expect([intent.element.selectionStart, intent.element.selectionEnd]).toEqual([2, 6]);
  expect(wrapper.text()).toContain("Quick prompt model · 模型原名");
  expect(api).not.toHaveBeenCalled();
  await wrapper.findAll("button").find(button => button.text().includes("Generate prompt"))!.trigger("click");
  expect(wrapper.text()).toContain("Writing…");
  expect(wrapper.get('[role="status"]').text()).toBe("Writing the prompt. Please wait.");
  expect(api).toHaveBeenCalledTimes(1);
  expect(api.mock.calls[0]).toEqual(["/rewrite", { providerId: "provider-id", model: "模型原名", prompt: "更新的用户意图\n保持原文", references: ["reference-id"] }, undefined, expect.any(AbortSignal)]);
  setLocale("zh-CN");
  await nextTick();
  expect(wrapper.get('[role="status"]').text()).toBe("正在补写提示词，请稍候。");
  expect(api).toHaveBeenCalledTimes(1);
  resolve({ text: "模型返回原文" });
  await flushPromises();
  setLocale("en");
  await nextTick();
  expect(wrapper.get<HTMLTextAreaElement>('[aria-label="Generated prompt"]').element.value).toBe("模型返回原文");
  await wrapper.findAll("button").find(button => button.text() === "Use prompt")!.trigger("click");
  expect(wrapper.emitted("apply")).toEqual([["模型返回原文", ["reference-id"]]]);
  expect(api).toHaveBeenCalledTimes(1);
});

it("translates built-in model/select hints but preserves model IDs and provider names", async () => {
  setLocale("zh-CN");
  const model = mount(ModelSelect, { props: { providers: [], kind: "image", label: "Model", providerId: "old-provider", model: "选择模型" } });
  const empty = mount(SelectControl, { props: { label: "Choice", options: [], modelValue: "" } });
  wrappers.push(model, empty);
  expect(empty.text()).toContain("请选择");
  setLocale("en");
  await nextTick();
  expect(empty.text()).toContain("Please select");
  expect(model.get('[role="combobox"]').text()).toContain("选择模型");
  expect(model.get('[role="combobox"]').attributes("title")).toBe("Historical model");
  expect(model.emitted("change")).toBeUndefined();
});

it("localizes reference validation and rewrite errors without translating API payloads", async () => {
  const api = vi.fn();
  setLocale("zh-CN");
  await expect(uploadReferences([new File(["x"], "x.txt", { type: "text/plain" })], [], api, signal())).rejects.toThrow("仅支持 PNG、JPEG、WebP");
  setLocale("en");
  const displayError = (operation: Promise<unknown>) => operation.catch((error: Error) => t(error.message));
  await expect(displayError(uploadReferences([new File(["x"], "x.txt", { type: "text/plain" })], [], api, signal()))).resolves.toBe("Only PNG, JPEG and WebP are supported");
  await expect(displayError(uploadReferences([new File(["x"], "x.png", { type: "image/png" })], Array.from({ length: 16 }, (_, index) => `ref-${index}`), api, signal()))).resolves.toBe("You can use up to 16 reference images. Remove some and try again.");
  const huge = new File(["x"], "huge.png", { type: "image/png" });
  Object.defineProperty(huge, "size", { value: 8 * 1024 * 1024 + 1 });
  await expect(displayError(uploadReferences([huge], [], api, signal()))).resolves.toBe("Each reference image must be 8 MB or smaller");
  await expect(displayError(rewritePrompt(api, {}, "用户原文", [], signal()))).resolves.toBe("Configure a default text model for prompt optimization in provider settings first");
  await expect(displayError(rewritePrompt(api, {}, "用户原文", [], signal(), "quick"))).resolves.toBe("Configure a quick prompt model in provider settings first");
  expect(api).not.toHaveBeenCalled();
  const invalid = vi.fn(async () => ({ text: "" }));
  await expect(displayError(rewritePrompt(invalid as Api, { textProvider: "供应商id", textModel: "模型id" }, "用户原文", ["参考id"], signal()))).resolves.toBe("The text model did not return a valid prompt");
  expect(invalid.mock.calls[0]).toEqual(["/rewrite", { providerId: "供应商id", model: "模型id", prompt: "用户原文", references: ["参考id"] }, undefined, expect.any(AbortSignal)]);
});
