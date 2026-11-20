import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanModels, modelInfo } from "../dist/models.js";

const imageIds = [
  "DALL·E 3", "gpt_image_1.5", "gpt-image-2.5", "gpt-image-2.6",
  "imagen3", "google/imagen-4.0-generate-001", "Nano Banana", "Nano Banana Pro",
  "nano-banana-2.1", "gemini-2.5-flash-image", "gemini-3-pro-image-preview",
  "midjourney-v6", "midjourney-v6.1", "Midjourney V7", "midjourneyv7",
  "black-forest-labs/FLUX.1-Pro", "FLUX.1-dev", "FLUX.1-schnell",
  "flux.1-kontext-max", "FLUX1.1 Pro", "flux.2-pro",
  "fal-ai/flux/dev", "fal-ai/flux-pro/v1.1", "fal-ai/flux-2/klein/9b",
  "bytedance/seedream-3", "doubao-seedream-4-0-250828", "seedream-4.5", "Seedream 5 Pro",
  "stabilityai/stable-diffusion-xl-base-1.0", "SDXL", "stable-diffusion-3.5-large",
  "stability.stable-image-ultra-v1:1", "qwen/qwen-image", "Qwen Image Edit", "qwen-image-2.1",
  "wan2.6-image", "wan-2.1-t2i", "fal-ai/wan/v2.6/text-to-image",
  "HunyuanDiT", "hunyuan-image-2", "Hunyuan Image 3", "HunyuanImage 2.0", "HunyuanImage 3.0",
  "cogview", "CogView3", "CogView-4", "z-ai/glm-image", "deepseek-ai/Janus-Pro-7B", "janus",
  "ideogram-2", "ideogram-v3", "ideogram-4", "recraft-v3", "recraft-v4", "recraft-v4.1",
  "mai-image-1", "MAI Image 2", "mai-image-2.7", "grok-2-image-1212", "xai/grok-imagine",
  "Imagine Image 2.0", "grok-imagine-image-2.0", "H3-Image", "luma/photon-1", "UNI-1.1 Max",
  "Muse Image", "reve-image", "reve-2", "reve-image-2.1", "HiDream-ai/HiDream-I1-Full",
  "kolors", "Sana", "sana-1.5", "PixArt-α", "PixArt-Σ", "Lumina-Image",
  "imagegen-v2",
];

const textIds = [
  "OPENAI/GPT-4o-2024-08-06", "ft:gpt-4.1-mini-2025-04-14:example:label:abc",
  "openai/ft:gpt-4o:example/label:abc", "gpt-35-turbo",
  "o1-preview", "o3-mini", "o4-mini", "gpt-5", "gpt-5.5", "gpt-5.6", "gpt-6",
  "gpt-6.1", "openai.gpt-6.2-sol", "GPT-6 Astra", "GPT-6 Luna", "GPT-6 Sol", "GPT-6 Terra",
  "openai/gpt-oss-120b", "claude-3-5-sonnet-20241022", "claude-3.7-sonnet",
  "claude-sonnet-4-20250514", "claude-4-opus", "claude-haiku-4.5", "claude-sonnet-4.5",
  "us.anthropic.claude-opus-4-5-20251101-v1:0", "claude-opus-5.5", "Claude Sonnet 5.5",
  "Claude Haiku 5.5", "claude-fable-5.1", "Claude Fable 5.2", "Claude Mythos 5.2",
  "models/gemini-1.5-pro", "gemini-2.0-flash", "gemini-2.5-pro", "gemini-3-pro-preview",
  "gemini-3.8-flash", "Gemini 4 Argon", "Gemini 4 Carbon", "Gemini 4 Hydrogen",
  "google/gemma-2-27b-it", "gemma3:27b", "grok-2", "grok-3", "grok-4", "grok-4.1",
  "grok-4.6", "x-ai/grok-4.7-fast", "meta-llama/Llama-3.1-70B-Instruct", "llama-3.2",
  "llama-3.3", "us.meta.llama3-1-8b-instruct-v1:0", "Llama 4 Maverick", "Muse Spark", "Muse Wonder", "Muse Ember",
  "deepseek-v2", "DeepSeek-V2.5", "DeepSeek-v3", "deepseek-ai/DeepSeek-R1",
  "deepseek-v3.1", "deepseek-v3.2", "DeepSeek V4", "DeepSeek V4.1 Flash", "deepseek-flash",
  "Qwen2-7B-Instruct", "qwen2.5:32b", "qwen3", "qwen-3.5", "qwen3.8", "Qwen4-Max",
  "Qwen-Coder", "QwQ-32B", "Doubao Pro", "doubao-lite-32k", "doubao-1.5-pro",
  "doubao-1-6-250615", "Doubao Seed", "seed-1.8-thinking", "Seed Thinking", "moonshot-v1-8k",
  "Kimi k1.5", "moonshotai/kimi-k2-instruct", "kimi-k2.5", "Kimi K3", "Kimi K3.1 Pro",
  "GLM-4", "glm-4.5", "glm-4.6", "glm-4.7", "glm-5", "glm-5.2", "glm-5.3", "glm-4-flash",
  "abab6.5s-chat", "MiniMax Text-01", "minimax-m1", "minimax-m2", "minimax-m2.5", "minimax-m3",
  "MiniMax M3.1 Flash", "ernie-4", "ERNIE-4.5-300B-A47B", "ERNIE X1", "Hunyuan", "hunyuan-t1",
  "hunyuan-4", "Hunyuan 4 Flash", "mistralai/mistral-large-latest", "Mistral Small", "Mistral Medium",
  "Mistral Large 4", "magistral-small", "Codestral", "devstral-small", "mixtral-8x7b",
  "Phi-3-mini", "Phi-3.5", "Phi-4", "Phi-4-reasoning-plus", "us.amazon.nova-micro-v1:0",
  "nova-lite", "amazon/nova-pro-v1", "Nova Premier", "cohere.command-r-v1:0", "Command R+",
  "command-r-plus", "command-a-03-2025", "spark-4.0-ultra", "Spark X1", "01-ai/yi-34b-chat",
  "Yi-1.5", "Yi Lightning", "baichuan-3", "baichuan4", "Step 1", "step-2-16k", "step-3",
  "step-5-preview", "internlm2-chat-7b", "InternLM2.5", "internlm3-8b-instruct", "Xiaomi/MiMo-V2-Flash",
  "MiMo-2.6", "gpt-3.5-turbo", "chatgpt-4o-latest", "o4",
];

for (const [type, ids, reason] of [
  ["image", imageIds, "已知图像模型 ID"],
  ["text", textIds, "已知文本模型 ID"],
]) {
  test(`classifies known ${type} model families by ID`, () => {
    for (const id of ids) {
      assert.deepEqual(modelInfo({ id }), { id, types: [type], reason }, id);
    }
  });
}

test("unknown IDs default to text without matching generic or partial image names", () => {
  for (const id of [
    "unknown-model", "acme/custom-image-model", "afflux-chat", "fluxcapacitor",
    "sanatorium", "custom-photon-text", "flux/unknown", "wan2.1-t2v",
    "wan-2.6-image-to-video", "fal-ai/wan/v2.6/image-to-video",
    "grok-imagine-video", "openassistant", "qwenfoo",
  ]) {
    const model = modelInfo({ id });
    assert.deepEqual(model.types, ["text"], id);
    assert.notEqual(model.reason, "已知文本模型 ID", id);
  }
});

test("known image IDs outrank broad input and chat metadata", () => {
  for (const id of imageIds) {
    for (const fields of [
      { modalities: ["text"] },
      { type: "chat" },
      { modalities: ["text", "image"], type: "chat" },
    ]) {
      assert.deepEqual(
        modelInfo({ id, ...fields }),
        { id, types: ["image"], reason: "已知图像模型 ID" },
        id,
      );
    }
  }
});

test("explicit upstream output metadata takes precedence over broad fields and IDs", () => {
  for (const [id, fields, types] of [
    ["gpt-4o", { output_modalities: [" IMAGE "], type: "chat" }, ["image"]],
    ["gpt-image-1", { architecture: { output_modalities: ["text"] }, modalities: ["image"] }, ["text"]],
    ["gpt-image-1", { output_modalities: ["text", "image", "text"] }, ["image", "text"]],
    ["custom", { output_modalities: ["text", "image-to-video"] }, ["text"]],
  ]) {
    assert.deepEqual(modelInfo({ id, ...fields }), {
      id, types, reason: "上游模型元数据",
    });
  }
});

test("known text IDs stay text with generic multimodal input metadata", () => {
  for (const id of ["gpt-4o", "claude-sonnet-4.5", "gemini-3-pro-preview", "qwen3.5"]) {
    assert.deepEqual(modelInfo({ id, modalities: ["text", "image"], type: "chat" }), {
      id, types: ["text"], reason: "已知文本模型 ID",
    });
  }
});

test("broad capability and type metadata still classify other IDs", () => {
  for (const [id, fields, types] of [
    ["unknown-mixed-model", { capabilities: ["image", "text"] }, ["image", "text"]],
    ["unknown-image-model", { capabilities: ["image"] }, ["image"]],
    ["custom-chat", { type: "chat" }, ["text"]],
  ]) {
    assert.deepEqual(modelInfo({ id, ...fields }), {
      id, types, reason: "上游模型元数据",
    });
  }
});

test("explicit configured types override metadata and ID inference, including an empty selection", () => {
  assert.deepEqual(cleanModels([
    { id: "gpt-image-2.6", types: ["text", "text", "audio"] },
    { id: "gpt-6.2-sol", types: [] },
    { id: "unrecognized-custom-id", output_modalities: ["text"], types: ["image", "text"] },
    { id: "google/imagen-4" },
  ]), [
    { id: "gpt-image-2.6", types: ["text"], reason: "手动指定用途" },
    { id: "gpt-6.2-sol", types: [], reason: "手动指定用途" },
    { id: "unrecognized-custom-id", types: ["image", "text"], reason: "手动指定用途" },
    { id: "google/imagen-4", types: ["image"], reason: "已知图像模型 ID" },
  ]);
});

test("a discovered mixed model stays mixed after save and revalidation", () => {
  const discovered = modelInfo({ id: "gpt-image-1", output_modalities: ["text", "image"] });
  const saved = cleanModels([discovered]);
  assert.deepEqual(saved[0].types, ["image", "text"]);
  assert.deepEqual(cleanModels(JSON.parse(JSON.stringify(saved))), saved);
});
