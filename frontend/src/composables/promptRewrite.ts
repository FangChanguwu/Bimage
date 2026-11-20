import { diffArrays } from "diff";
import type { Api, Settings } from "../types";

export const PROMPT_LIMIT = 16000;

export async function rewritePrompt(api: Api, settings: Pick<Settings, "textProvider" | "textModel" | "quickProvider" | "quickModel">, prompt: string, references: readonly string[], signal: AbortSignal, purpose: "optimization" | "quick" = "optimization") {
  const providerId = purpose === "quick" ? settings.quickProvider : settings.textProvider;
  const model = purpose === "quick" ? settings.quickModel : settings.textModel;
  if (!providerId || !model)
    throw Error(purpose === "quick" ? "请先在供应商设置中配置快速提示词模型" : "请先在供应商设置中配置提示词优化的默认文本模型");
  const response = await api<{ text: string }>(
    "/rewrite",
    { providerId, model, prompt, references: [...references] },
    undefined,
    signal,
  );
  signal.throwIfAborted();
  if (typeof response?.text !== "string" || !response.text.trim() || response.text.length > PROMPT_LIMIT)
    throw Error("文本模型未返回有效提示词");
  return response.text;
}

type Kind = "same" | "removed" | "added";
export interface PromptRun { kind: Kind; text: string }
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function chars(value: string) {
  return Array.from(graphemes.segment(value), part => part.segment);
}
function differences(a: string, b: string) {
  // Chat responses may be unrelated to the original. Bound synchronous diff
  // work and still represent both sides faithfully if the budget runs out.
  const before = chars(a), after = chars(b);
  const changed = diffArrays(before, after, { maxEditLength: 1024, timeout: 40 });
  if (changed) return changed.map(({ added, removed, value }): PromptRun => ({
    kind: removed ? "removed" : added ? "added" : "same", text: value.join(""),
  }));
  const max = Math.min(before.length, after.length);
  let start = 0, end = 0;
  while (start < max && before[start] === after[start]) start++;
  while (end < max - start && before.at(-1 - end) === after.at(-1 - end)) end++;
  return [
    { kind: "same", text: before.slice(0, start).join("") },
    { kind: "removed", text: before.slice(start, before.length - end).join("") },
    { kind: "added", text: after.slice(start, after.length - end).join("") },
    { kind: "same", text: before.slice(before.length - end).join("") },
  ] satisfies PromptRun[];
}
function append(runs: PromptRun[], kind: Kind, text: string) {
  if (!text) return;
  const previous = runs.at(-1);
  if (previous?.kind === kind) previous.text += text;
  else runs.push({ kind, text });
}

export function comparePrompts(original: string, optimized: string) {
  return differences(original.replace(/\r\n?/g, "\n"), optimized.replace(/\r\n?/g, "\n"))
    .filter(run => run.text);
}
export function reviewText(runs: readonly PromptRun[]) {
  return runs.map(run => run.text).join("");
}
export function composePrompt(runs: readonly PromptRun[]) {
  return runs.filter(run => run.kind !== "removed").map(run => run.text).join("");
}

// Keep the original diff marks on text that the browser did not edit. Use
// beforeinput's range when available so repeated letters do not move a mark.
export function editPromptReview(runs: readonly PromptRun[], next: string, selection?: { start: number; end: number; type: string }) {
  const before = reviewText(runs);
  if (before === next) return runs;
  let changes: PromptRun[] | undefined;
  if (selection) {
    let { start, end } = selection;
    if (start === end && next.length < before.length) {
      if (selection.type.endsWith("Backward")) start = Math.max(0, start - (before.length - next.length));
      if (selection.type.endsWith("Forward")) end = Math.min(before.length, end + (before.length - next.length));
    }
    const tail = before.length - end;
    if (next.length >= start + tail && next.startsWith(before.slice(0, start)) && next.endsWith(before.slice(end))) {
      changes = [
        { kind: "same", text: before.slice(0, start) },
        { kind: "removed", text: before.slice(start, end) },
        { kind: "added", text: next.slice(start, next.length - tail) },
        { kind: "same", text: before.slice(end) },
      ];
    }
  }
  const edited: PromptRun[] = [];
  let index = 0, offset = 0;
  for (const change of changes ?? differences(before, next)) {
    if (change.kind === "added") {
      append(edited, "added", change.text);
      continue;
    }
    let remaining = change.text.length;
    while (remaining > 0) {
      const run = runs[index];
      const size = Math.min(remaining, run.text.length - offset);
      if (change.kind === "same") append(edited, run.kind, run.text.slice(offset, offset + size));
      offset += size;
      remaining -= size;
      if (offset === run.text.length) { index++; offset = 0; }
    }
  }
  return edited;
}
