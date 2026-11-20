import { expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import AssetImage from "../src/components/AssetImage.vue";
import { assetCache } from "../src/composables/assetCache";

it("retained thumbnail is cleared on explicit asset eviction or session invalidation", async () => {
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
    observe() { this.callback([{ isIntersecting: true }]); }
    disconnect() {}
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new Blob(["image"])));
  const controller = new AbortController();
  const wrapper = mount(AssetImage, { props: { asset: "invalidated", alt: "preview", signal: controller.signal } });
  try {
    await flushPromises();
    expect(wrapper.attributes("src")).toMatch(/^blob:/);
    await assetCache(controller.signal).evict("invalidated");
    await flushPromises();
    expect(wrapper.attributes("src")).toBeUndefined();
    expect(wrapper.attributes("alt")).toContain("图片加载失败");
  } finally { wrapper.unmount(); controller.abort(); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});

it("keeps loaded thumbnail source when it leaves and re-enters the viewport", async () => {
  let observe!: (entries: { isIntersecting: boolean }[]) => void;
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: typeof observe) { observe = callback; }
    observe() {}
    disconnect() {}
  });
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Blob(["image"])));
  const controller = new AbortController();
  const wrapper = mount(AssetImage, { props: { asset: "scroll", alt: "preview", signal: controller.signal } });
  try {
    observe([{ isIntersecting: true }]); await flushPromises();
    const source = wrapper.attributes("src");
    expect(source).toMatch(/^blob:/);
    observe([{ isIntersecting: false }]); await flushPromises();
    expect(wrapper.attributes("src")).toBe(source);
    observe([{ isIntersecting: true }]); await flushPromises();
    expect(wrapper.attributes("src")).toBe(source);
    expect(fetcher).toHaveBeenCalledOnce();
  } finally { wrapper.unmount(); controller.abort(); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});

it("loads original eagerly even when dialog intersection is initially empty", async () => {
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Blob(["original"])));
  const controller = new AbortController();
  const wrapper = mount(AssetImage, { props: { asset: "dialog", alt: "original", original: true, signal: controller.signal } });
  try {
    await flushPromises();
    expect(fetcher).toHaveBeenCalledWith('/api/assets/dialog', expect.anything());
    expect(wrapper.attributes("src")).toMatch(/^blob:/);
  } finally { wrapper.unmount(); controller.abort(); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});

it("first preview fetches only a server thumbnail; opening original downloads it once", async () => {
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
    observe() { this.callback([{ isIntersecting: true }]); }
    disconnect() {}
  });
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new Blob(["image"])));
  const controller = new AbortController();
  const preview = mount(AssetImage, { props: { asset: "one", alt: "preview", signal: controller.signal } });
  let original: ReturnType<typeof mount> | undefined;
  try {
    await flushPromises();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/assets/one?variant=thumbnail"]);
    expect(preview.attributes("src")).toMatch(/^blob:/);
    original = mount(AssetImage, { props: { asset: "one", alt: "original", original: true, signal: controller.signal } });
    await flushPromises();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/assets/one?variant=thumbnail", "/api/assets/one"]);
    original.unmount(); original = undefined;
    original = mount(AssetImage, { props: { asset: "one", alt: "original", original: true, signal: controller.signal } });
    await flushPromises();
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    preview.unmount(); original?.unmount(); controller.abort(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  }
});
