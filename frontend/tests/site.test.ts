import { it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import SiteSettings from "../src/components/SiteSettings.vue";
it("keeps independent square preview beside the label and custom upload control, with separate save", async () => {
  const api = vi.fn().mockResolvedValue({ title: "My studio", icon: "" });
  const w = mount(SiteSettings, {
    props: {
      site: { title: "Bimage" },
      api,
      run: async (fn: () => Promise<unknown>) => fn(),
    },
  });
  expect(w.get(".site-icon-preview").attributes("src")).toBe("/Bimage.png");
  expect(w.get("input[type=file]").classes()).toContain("visually-hidden");
  expect(w.get("button.upload-icon").text()).toContain("上传图标");
  expect(w.get(".site-icon-row").find("button[type=submit]").exists()).toBe(
    false,
  );
  expect(w.get(".site-save").text()).toContain("保存站点设置");
  await w.get('input[aria-label="站点标题"]').setValue("My studio");
  await w.get("form").trigger("submit");
  expect(api).toHaveBeenCalledWith(
    "/admin/site",
    { title: "My studio", icon: "" },
    "PUT",
  );
});
