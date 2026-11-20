import { expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import AssetImage from "../src/components/AssetImage.vue";

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
