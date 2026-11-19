import { describe, it, expect } from "vitest";
import {
  emptyForm,
  jobPayload,
  restoreForm,
  resolveChoice,
  repairPrompt,
} from "../src/domain";
describe("safe creation contracts", () => {
  it("starts automatic and omits all size parameters upstream", () => {
    const f = emptyForm();
    expect(f.autoSize).toBe(true);
    const p = jobPayload(f);
    expect(p).not.toHaveProperty("size");
    expect(p).not.toHaveProperty("ratio");
    expect(p).not.toHaveProperty("resolution");
    expect(p.manualSize?.size).toBe("1024x1024");
  });
  it("preserves legacy manual history and raw multiline prompt", () => {
    const f = restoreForm({
      ...emptyForm(),
      autoSize: undefined,
      prompt: "a\n b",
      size: "1536x1024",
    } as never);
    expect(f.autoSize).toBe(false);
    expect(f.size).toBe("1536x1024");
    expect(f.prompt).toBe("a\n b");
  });
  it("never invents defaults across multiple providers", () => {
    const p = [
      { id: "a", models: [{ id: "img", types: ["image"] }] },
      { id: "b", models: [] },
    ];
    expect(resolveChoice(p as never, "image").model).toBe("");
    expect(resolveChoice(p.slice(0, 1) as never, "image").model).toBe("img");
  });
  it("repair includes only used colors and preserves requirements verbatim", () => {
    const s = [
      { color: "#EF4444" },
      { color: "#EF4444" },
      { color: "#3B82F6" },
    ];
    const p = repairPrompt(s as never, "第一行\n 第二行");
    expect(p.split("\n")[0]).toBe(
      "根据参考图中的#EF4444、#3B82F6 颜色标记，修改参考图",
    );
    expect(p).toContain("第一行\n 第二行");
    expect(p).not.toContain("坐标");
  });
});
