import { it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import Composer from "../src/components/Composer.vue";
import SelectControl from "../src/components/SelectControl.vue";
import { emptyForm } from "../src/domain";

it("uses accessible custom output controls and keyboard selection without submission", async () => {
  const w = mount(Composer, { attachTo: document.body, props: {
    form: { ...emptyForm(), autoSize: false }, providers: [],
    signal: new AbortController().signal, api: vi.fn(), run: async (fn: () => Promise<unknown>) => fn(), busy: false,
  }});
  expect(w.findAll("select")).toHaveLength(0);
  const quality = w.get('[role="combobox"][aria-label="质量"]');
  await quality.trigger("keydown", { key: "End" });
  expect(quality.attributes("aria-expanded")).toBe("true");
  await quality.trigger("keydown", { key: "Enter" });
  expect(w.emitted("update:form")?.[0][0]).toMatchObject({ quality: "hd" });
  expect(w.emitted("generate")).toBeUndefined();
  expect(quality.attributes("aria-expanded")).toBe("false");
  w.unmount();
});
it('skips disabled options initially and cycles repeated-character typeahead', async () => {
  const w = mount(SelectControl, {attachTo: document.body,props:{label:'choice',modelValue:'missing',options:[{value:'none',label:'Unavailable',disabled:true},{value:'a',label:'Alpha'},{value:'b',label:'Alpine'},{value:'z',label:'Zebra'}]}});
  const trigger = w.get('[role="combobox"]');
  await trigger.trigger('keydown',{key:'Enter'});
  expect(document.querySelector('[data-active="true"]')?.textContent).toContain('Alpha');
  await trigger.trigger('keydown',{key:'a'});
  await trigger.trigger('keydown',{key:'a'});
  await trigger.trigger('keydown',{key:'Enter'});
  expect(w.emitted('update:modelValue')?.[0]).toEqual(['b']);
  w.unmount();
});
