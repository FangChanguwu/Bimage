import { describe, expect, it, vi } from "vitest";
import { comparePrompts, composePrompt, editPromptReview, reviewText, rewritePrompt } from "../src/composables/promptRewrite";
import type { Api } from "../src/types";

describe("inline prompt review", () => {
  it("keeps unchanged characters neutral and marks only the changed grapheme", () => {
    const review = comparePrompts("看🐈‍⬛。\r\n  ", "看🐈。\n  ");
    expect(review).toEqual([
      { kind: "same", text: "看" }, { kind: "removed", text: "🐈‍⬛" },
      { kind: "added", text: "🐈" }, { kind: "same", text: "。\n  " },
    ]);
    expect(composePrompt(review)).toBe("看🐈。\n  ");
  });

  it("preserves the location of tracked changes when a repeated character is edited", () => {
    const review = [{ kind: "same", text: "猫" }, { kind: "removed", text: "猫" }, { kind: "added", text: "犬" }] as const;
    const edited = editPromptReview(review, "猫犬", { start: 1, end: 1, type: "deleteContentBackward" });
    expect(reviewText(edited)).toBe("猫犬");
    expect(composePrompt(edited)).toBe("犬");
    expect(composePrompt(editPromptReview(review, "新犬", { start: 0, end: 2, type: "insertText" }))).toBe("新犬");
  });

  it("retains both sides and line breaks even if the diff budget is exhausted", () => {
    const original = "开头\n" + "原".repeat(15996) + "\n";
    const optimized = "开头\n" + "新".repeat(15996) + "\n";
    const review = comparePrompts(original, optimized);
    expect(review.filter(run => run.kind === "same").map(run => run.text)).toEqual(["开头\n", "\n"]);
    expect(review.filter(run => run.kind !== "added").map(run => run.text).join("")).toBe(original);
    expect(composePrompt(review)).toBe(optimized);
  });

  it("does not call the API without a configured text model", async () => {
    const api = vi.fn();
    await expect(rewritePrompt(api, {}, "原句。", [], new AbortController().signal)).rejects.toThrow("默认文本模型");
    expect(api).not.toHaveBeenCalled();
  });

  it("discards a result that arrives after its request lifetime ended", async () => {
    const controller = new AbortController();
    const api = vi.fn(async () => {
      controller.abort();
      return { text: "不应显示。" };
    });
    await expect(rewritePrompt(api as Api, { textProvider: "p", textModel: "m" }, "原句。", ["ref"], controller.signal)).rejects.toHaveProperty("name", "AbortError");
    expect(api).toHaveBeenCalledWith("/rewrite", { providerId: "p", model: "m", prompt: "原句。", references: ["ref"] }, undefined, controller.signal);
  });
});
