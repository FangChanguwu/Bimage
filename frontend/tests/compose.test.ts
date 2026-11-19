import { it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import Composer from "../src/components/Composer.vue";
import { emptyForm } from "../src/domain";
it("clear only clears prompt and references without resetting chosen output", async () => {
  const form = {
    ...emptyForm(),
    prompt: "draft",
    references: [],
    count: 4,
    model: "chosen",
  };
  const w = mount(Composer, {
    props: {
      form,
      providers: [],
      signal: new AbortController().signal,
      api: vi.fn(),
      run: async (fn: () => Promise<unknown>) => fn(),
      busy: false,
    },
  });
  await w.get('button[aria-label="清空提示词和参考图"]').trigger("click");
  const result = w.emitted("update:form")?.[0][0] as typeof form;
  expect(result.prompt).toBe("");
  expect(result.references).toEqual([]);
  expect(result.count).toBe(4);
  expect(result.model).toBe("chosen");
});
