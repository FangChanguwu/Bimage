import { object } from "./http.js";
import type { Model } from "./types.js";

export function modelInfo(value: unknown): Model {
  const model = object(value);
  const id = String(model.id || "").slice(0, 200);
  const architecture =
    model.architecture && typeof model.architecture === "object"
      ? (model.architecture as Record<string, unknown>)
      : {};
  const metadata = JSON.stringify([
    model.capabilities,
    model.modalities,
    model.output_modalities,
    architecture.output_modalities,
    model.type,
  ]).toLowerCase();
  const image = /image/.test(metadata),
    text = /text|chat/.test(metadata);
  if (image || text)
    return {
      id,
      types: [...(image ? ["image"] : []), ...(text ? ["text"] : [])],
      reason: "上游模型元数据",
    };
  if (
    /gpt-image|dall-e|flux|stable-diffusion|imagen|ideogram|recraft|imagegen/i.test(
      id,
    )
  )
    return { id, types: ["image"], reason: "已知图像模型 ID" };
  if (
    /^(gpt-[345]|chatgpt|o[134](?:-|$)|claude|gemini|deepseek|qwen|llama|mistral|nova-(?:micro|lite|pro|premier))/i.test(
      id,
    )
  )
    return { id, types: ["text"], reason: "已知文本模型 ID" };
  return { id, types: [], reason: "未知模型：请手动指定用途" };
}
export function cleanModels(value: unknown): Model[] {
  if (!Array.isArray(value) || value.length > 2000)
    throw new Error("模型列表无效");
  return value.map((entry: unknown) => {
    const input = object(entry),
      output = modelInfo(input);
    if (!output.id) throw new Error("模型 ID 无效");
    if (Array.isArray(input.types)) {
      output.types = [
        ...new Set(
          input.types.filter(
            (type: unknown): type is string =>
              type === "image" || type === "text",
          ),
        ),
      ];
      if (input.reason !== output.reason) output.reason = "手动指定用途";
    }
    return output;
  });
}
