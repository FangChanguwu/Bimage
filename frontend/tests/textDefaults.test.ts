import { describe, expect, it } from "vitest";
import { resolveTextDefaults } from "../src/composables/textDefaults";
import { emptyForm } from "../src/domain";
import type { Provider } from "../src/types";

const providers: Provider[] = [
  { id: "a", name: "A", models: [{ id: "first", types: ["text"] }, { id: "optimized", types: ["text"] }] },
  { id: "b", name: "B", models: [{ id: "quick", types: ["text"] }, { id: "image", types: ["image"] }] },
];
describe("independent text defaults", () => {
  it("resolves separate choices without changing image defaults, draft or unrelated fields", () => {
    const form = emptyForm();
    const settings = { textProvider: "a", textModel: "optimized", quickProvider: "b", quickModel: "quick", imageProvider: "b", imageModel: "image", form, other: { retained: true } };
    const effective = resolveTextDefaults(providers, settings);
    expect(effective).toEqual(settings);
    expect(effective).not.toBe(settings);
    expect(effective.form).toBe(form);
  });
  it("inherits the legacy text choice only when neither quick field exists", () => {
    expect(resolveTextDefaults(providers, { textProvider: "a", textModel: "optimized" })).toMatchObject({ quickProvider: "a", quickModel: "optimized" });
  });
  it.each([
    { quickProvider: "gone", quickModel: "old" },
    { quickProvider: "", quickModel: "" },
    { quickModel: "quick" },
    { quickProvider: undefined },
    { quickProvider: "b", quickModel: "image" },
  ])("does not substitute optimization for explicit missing/stale quick fields: %j", quick => {
    expect(resolveTextDefaults(providers, { textProvider: "a", textModel: "optimized", ...quick })).toMatchObject({ textProvider: "a", textModel: "optimized", quickProvider: "", quickModel: "" });
  });
  it("uses the normal single-provider fallback independently", () => {
    expect(resolveTextDefaults([providers[0]], { textProvider: "a", textModel: "optimized", quickProvider: "gone", quickModel: "old" })).toMatchObject({ textModel: "optimized", quickProvider: "a", quickModel: "first" });
  });
  it("resolves stale optimization normally and preserves a valid quick choice", () => {
    expect(resolveTextDefaults(providers, { textProvider: "gone", textModel: "old", quickProvider: "b", quickModel: "quick" })).toMatchObject({ textProvider: "", textModel: "", quickProvider: "b", quickModel: "quick" });
  });
});
