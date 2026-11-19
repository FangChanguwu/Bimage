import type { GenerationForm, Provider, Shape, Choice } from "./types";
export const MAX_REFERENCES = 16;
export const emptyForm = (): GenerationForm => ({
  providerId: "",
  model: "",
  prompt: "",
  count: 1,
  size: "1024x1024",
  autoSize: true,
  resolution: "1K",
  ratio: "1:1",
  quality: "auto",
  output_format: "png",
  references: [],
});
export function jobPayload(form: GenerationForm): Partial<GenerationForm> {
  if (!form.autoSize) return structuredClone(form);
  const { size, ratio, resolution, aspect_ratio, ...automatic } = form;
  return {
    ...structuredClone(automatic),
    manualSize: { size, ratio, resolution },
  };
}
export function restoreForm(form: GenerationForm): GenerationForm {
  return {
    ...emptyForm(),
    ...structuredClone(form),
    ...form.manualSize,
    // An old explicit size without a resolution is not the fresh-form 1K preset.
    resolution: form.manualSize ? form.manualSize.resolution : form.resolution,
    autoSize: form.autoSize === true,
    references: [...form.references],
  };
}
export function resolveChoice(
  providers: Provider[],
  kind: string,
  providerId = "",
  model = "",
  fallback: Partial<Choice> = {},
): Choice {
  const unique = [...new Map(providers.map((p) => [p.id, p])).values()];
  const p = unique.find((p) => p.id === providerId);
  if (p?.models?.some((m) => m.id === model && m.types.includes(kind)))
    return { providerId, model };
  const d = unique.find((p) => p.id === fallback.providerId);
  if (d?.models?.some((m) => m.id === fallback.model && m.types.includes(kind)))
    return { providerId: d.id, model: fallback.model! };
  if (unique.length === 1)
    return {
      providerId: unique[0].id,
      model: unique[0].models?.find((m) => m.types.includes(kind))?.id || "",
    };
  return { providerId: "", model: "" };
}
export function dimensions(ratio: string, resolution: string) {
  const [w, h] = ratio.split(":").map(Number);
  const long =
    ({ "1K": 1024, "2K": 2048, "4K": 4096 } as Record<string, number>)[
      resolution
    ] || 1024;
  return w && h
    ? `${Math.round((long * w) / Math.max(w, h))}x${Math.round((long * h) / Math.max(w, h))}`
    : "1024x1024";
}
export function repairPrompt(shapes: Shape[], need: string) {
  return `根据参考图中的${[...new Set(shapes.map((s) => s.color))].join("、")} 颜色标记，修改参考图\n${need}\n仅按用户需求修改。标注只是修改位置与范围的指引，不是画面内容。最终图必须移除标注，包括所有彩色线条、形状与箭头。严格不要修改标注以外部分，保留原有构图、内容、光影与细节。`;
}
export const statusLabel: Record<string, string> = {
  queued: "排队中",
  running: "生成中",
  succeeded: "已完成",
  failed: "部分或全部失败",
  cancelled: "已取消",
  interrupted: "已中断",
};
export const fileData = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(Error("文件读取失败"));
    r.readAsDataURL(file);
  });
