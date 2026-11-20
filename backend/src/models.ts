import { object } from "./http.js";
import type { Model } from "./types.js";

type ModelUse = "image" | "text";

// Normalize only the name used for matching. The original ID is still used
// for display, persistence, and upstream requests.
function modelName(id: string): string {
  const lower = id.trim().toLowerCase();
  const fineTune = lower.match(/(?:^|\/)ft:([^:]+)/);
  const path = fineTune?.[1] ?? lower;
  // fal's first path segment after its namespace is the model, not the
  // endpoint variant at the end of the path.
  const name = path.startsWith("fal-ai/")
    ? path.slice("fal-ai/".length).replace(/\//g, "-")
    : (path.split("/").pop() ?? "");
  return name
    .replace(
      /^(?:(?:us|eu|apac|global)\.)?(?:openai|anthropic|google|amazon|cohere|meta|mistralai|xai|stability)[.:]/,
      "",
    )
    .replace(
      /^(?:(?:us|eu|apac|global)\.)?(mistral|deepseek|qwen)[.:](?=\1)/,
      "",
    )
    .split(":", 1)[0]
    .replace(/[\s_.·-]+/g, "-");
}

const IMAGE_FAMILIES = [
  /^(?:dall-e|dalle|gpt-image|nano-banana|midjourney(?:v?\d+)?|mai-image|h3-image)(?:-|$)/,
  /^(?:imagen|flux|seedream|cogview)(?:\d|-|$)/,
  /^doubao-seedream(?:-|$)/,
  /^(?:stable-diffusion|stable-image|sdxl|qwen-image|glm-image|hunyuan-?image|hunyuan-?dit)(?:-|$)/,
  /^gemini-\d[\w-]*-image(?:-|$)/,
  /^wan-?v?\d[\w-]*-(?:image|t2i)(?:-|$)/,
  /^(?:janus|ideogram|recraft|photon|muse-image|reve|hidream-i1|kolors|sana|pixart|lumina-image|imagegen)(?:-|$)/,
  /^(?:grok-(?:\d[\w-]*-image|imagine)|imagine-image)(?:-|$)/,
  /^uni-\d+(?:-\d+)*-max(?:-|$)/,
];

const TEXT_FAMILIES = [
  /^(?:gpt-(?:[3456][a-z]?|35|oss)|chatgpt|o[134])(?:-|$)/,
  /^(?:claude|deepseek|mistral|magistral|codestral|devstral|mixtral|phi)(?:-|$)/,
  /^(?:gemini|gemma|llama|qwen|abab|kimi|glm|minimax|ernie|baichuan|internlm)(?:\d|-|$)/,
  /^(?:grok|qwq|doubao|moonshot|hunyuan|mimo)(?:-|$)/,
  /^(?:muse-(?:spark|wonder|ember)|seed-(?:\d+|thinking)|nova-(?:micro|lite|pro|premier))(?:-|$)/,
  /^(?:command-(?:r\+?|a)|spark-(?:4|x1)|yi|step-\d+)(?:-|$)/,
];

function idUse(id: string): ModelUse | undefined {
  const name = modelName(id);
  if (/(?:^|-)(?:video|t2v|i2v)(?:-|$)/.test(name)) return undefined;
  // Check image variants before their broader text families.
  if (IMAGE_FAMILIES.some((family) => family.test(name))) return "image";
  if (TEXT_FAMILIES.some((family) => family.test(name))) return "text";
  return undefined;
}

function outputTypes(...fields: unknown[]): ModelUse[] {
  const types = new Set<ModelUse>();
  for (const field of fields) {
    for (const value of Array.isArray(field) ? field : [field]) {
      const type = typeof value === "string" ? value.trim().toLowerCase() : "";
      if (type === "image" || type === "text") types.add(type);
    }
  }
  return (["image", "text"] as const).filter((type) => types.has(type));
}

export function modelInfo(value: unknown): Model {
  const model = object(value);
  const id = String(model.id || "").slice(0, 200);
  const architecture =
    model.architecture && typeof model.architecture === "object"
      ? (model.architecture as Record<string, unknown>)
      : {};
  const outputs = outputTypes(
    model.output_modalities,
    architecture.output_modalities,
  );
  if (outputs.length) return { id, types: outputs, reason: "上游模型元数据" };

  const inferred = idUse(id);
  // Generic metadata may describe inputs or a chat-compatible interface,
  // not what a known model returns (e.g. GPT-4o accepts image inputs).
  if (inferred === "image")
    return { id, types: ["image"], reason: "已知图像模型 ID" };
  if (inferred === "text")
    return { id, types: ["text"], reason: "已知文本模型 ID" };

  const metadata = JSON.stringify([
    model.capabilities,
    model.modalities,
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
  return { id, types: ["text"], reason: "未知模型：默认文本，可手动指定用途" };
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
