import { it, expect, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import ImageCacheSettings from "../src/components/ImageCacheSettings.vue";
import { assetCache } from "../src/composables/assetCache";
it("shows account cache usage and clears only on explicit click", async () => {
  const controller = new AbortController(), cache = assetCache(controller.signal);
  const usage = vi.spyOn(cache, "usage").mockResolvedValue({ bytes: 1048576, count: 2, limit: 134217728 });
  const clear = vi.spyOn(cache, "clear").mockResolvedValue();
  const wrapper = mount(ImageCacheSettings, { props: { signal: controller.signal } });
  try {
    await flushPromises();
    expect(wrapper.text()).toContain("1.0 MB");
    expect(clear).not.toHaveBeenCalled();
    await wrapper.get("button").trigger("click"); await flushPromises();
    expect(clear).toHaveBeenCalledOnce();
    expect(usage).toHaveBeenCalledTimes(2);
  } finally { wrapper.unmount(); controller.abort(); vi.restoreAllMocks(); }
});
