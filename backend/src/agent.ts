import { randomUUID } from "node:crypto";
import type { Express, Response } from "express";
import sharp from "sharp";
import { Store } from "./db.js";
import { Assets, imageType } from "./assets.js";
import { Providers } from "./providers.js";
import { Queue } from "./queue.js";
import { body, fail, HttpError, object, param, user } from "./http.js";
import { MAX_REFERENCE_IMAGES } from "./limits.js";
import { MAX_AGENT_DOCUMENTS, MAX_DOCX_BYTES, parseDocxDocument } from "./docx.js";
import type { ImageForm, ProviderRow, TaskStatus } from "./types.js";

type Owner = { id: string; role: "admin" | "user" };

export type ThinkingEffort = "low" | "medium" | "high";
export type SpeedTier = "normal" | "priority";
export type ApprovalMode = "confirm" | "auto";
export type AgentRunStatus =
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentSessionConfig {
  textProviderId: string;
  textModel: string;
  imageProviderId: string;
  imageModel: string;
  thinkingEffort: ThinkingEffort;
  speed: SpeedTier;
  approvalMode: ApprovalMode;
  autoInspect: boolean;
  budgetImages: number;
  maxRetries: number;
  defaultSize?: string;
  defaultAutoSize?: boolean;
  defaultQuality?: string;
  defaultOutputFormat?: string;
}

export interface AgentPlanItem {
  title: string;
  prompt: string;
  count: number;
  size?: string;
  autoSize?: boolean;
  quality?: string;
  output_format?: string;
  references: string[];
  providerId?: string;
  model?: string;
}

export interface AgentPlanCard {
  id: string;
  type: "plan";
  runId: string;
  status: "pending" | "approved" | "rejected" | "superseded";
  summary: string;
  items: AgentPlanItem[];
  totalImages: number;
}

export interface AgentBatchTaskView {
  id: string;
  status: TaskStatus;
  asset?: string | null;
  error?: string | null;
  width?: number | null;
  height?: number | null;
  mime?: string;
}

export interface AgentBatchItemView {
  title: string;
  jobId: string;
  prompt: string;
  count: number;
  size?: string;
  autoSize?: boolean;
  model: string;
  providerId: string;
  references: string[];
  status: TaskStatus;
  tasks: AgentBatchTaskView[];
}

export interface AgentBatchCard {
  id: string;
  type: "batch";
  runId: string;
  summary: string;
  items: AgentBatchItemView[];
}

export interface AgentInspectionCheck {
  criterion: string;
  status: "pass" | "warn" | "fail";
  note: string;
}

export interface AgentInspectionCard {
  id: string;
  type: "inspection";
  runId: string;
  passed: boolean;
  summary: string;
  checks: AgentInspectionCheck[];
  bestAssetIds: string[];
  suggestedFix?: string;
  inspectedAssetIds: string[];
  degraded?: boolean;
}

export interface AgentDeliverablesCard {
  id: string;
  type: "deliverables";
  title: string;
  summary: string;
  assetIds: string[];
  jobIds: string[];
}

export type AgentCard =
  | AgentPlanCard
  | AgentBatchCard
  | AgentInspectionCard
  | AgentDeliverablesCard;

export interface AgentSessionRow {
  id: string;
  owner: string;
  title: string;
  config: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentDocumentRef {
  id: string;
  name: string;
  size: number;
  charCount: number;
  images: string[];
  skippedImages: number;
  truncated: boolean;
  excerpt: string;
}

interface AgentDocumentRow {
  id: string;
  owner: string;
  name: string;
  size: number;
  text: string;
  charCount: number;
  images: string;
  skippedImages: number;
  truncated: number;
}

export interface AgentMessageRow {
  id: string;
  sessionId: string;
  owner: string;
  role: "user" | "assistant";
  content: string;
  reasoning: string;
  attachments: string;
  documents: string;
  cards: string;
  createdAt: string;
}

export interface AgentRunRow {
  id: string;
  sessionId: string;
  owner: string;
  status: AgentRunStatus;
  budgetImages: number;
  usedImages: number;
  maxRetries: number;
  usedRetries: number;
  pendingPlan: string | null;
  jobIds: string;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

interface PendingPlanPayload {
  cardId: string;
  messageId: string;
  toolCallId: string;
  summary: string;
  items: AgentPlanItem[];
  llmMessages: ChatMessage[];
  assistantToolCallMessage: ChatMessage;
  step: number;
}

interface ChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | Array<Record<string, unknown>> | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ActiveRunHandle {
  runId: string;
  controller: AbortController;
  jobIds: Set<string>;
}

const MAX_AGENT_STEPS = 12;
const MAX_INSPECT_IMAGES = 6;
const MAX_VISION_IMAGES_PER_MESSAGE = 20;
const MAX_BUDGET_IMAGES = 24;
const MAX_RETRIES = 4;

const TERMINAL_TASK_STATUSES = new Set<TaskStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

class VisionUnsupportedError extends HttpError {
  constructor(model: string) {
    super(422, `该模型无法理解图片（${model}），请切换支持视觉输入的对话模型后重试`);
  }
}

function isVisionUnsupportedError(errText: string): boolean {
  return /vision|multimodal|image_url|input_image|image input|does not support.*image|not support.*image|cannot.*image|unsupported.*image|images?.*(?:not supported|not allowed|unsupported)|unknown variant.*image_url|content.*must be.*string|expected.*string|invalid.*content|text[- ]only model|不支持.*图|不支持视觉|不支持多模态|非视觉模型|无法理解图片|无法识别图片|无法处理图片/i.test(errText);
}

function defaultConfig(): AgentSessionConfig {
  return {
    textProviderId: "",
    textModel: "",
    imageProviderId: "",
    imageModel: "",
    thinkingEffort: "medium",
    speed: "normal",
    approvalMode: "confirm",
    autoInspect: true,
    budgetImages: 8,
    maxRetries: 2,
    defaultAutoSize: true,
    defaultQuality: "auto",
    defaultOutputFormat: "png",
  };
}

function normalizeConfig(
  raw: unknown,
  base: AgentSessionConfig = defaultConfig(),
): AgentSessionConfig {
  const input =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const thinkingEffort: ThinkingEffort =
    input.thinkingEffort === "low" ||
    input.thinkingEffort === "medium" ||
    input.thinkingEffort === "high"
      ? input.thinkingEffort
      : base.thinkingEffort;
  const speed: SpeedTier =
    input.speed === "priority" || input.speed === "normal"
      ? input.speed
      : base.speed;
  const approvalMode: ApprovalMode =
    input.approvalMode === "auto" || input.approvalMode === "confirm"
      ? input.approvalMode
      : base.approvalMode;
  const budgetImages =
    typeof input.budgetImages === "number" && Number.isFinite(input.budgetImages)
      ? Math.max(1, Math.min(MAX_BUDGET_IMAGES, Math.round(input.budgetImages)))
      : base.budgetImages;
  const maxRetries =
    typeof input.maxRetries === "number" && Number.isFinite(input.maxRetries)
      ? Math.max(0, Math.min(MAX_RETRIES, Math.round(input.maxRetries)))
      : base.maxRetries;

  return {
    textProviderId:
      typeof input.textProviderId === "string"
        ? input.textProviderId
        : base.textProviderId,
    textModel:
      typeof input.textModel === "string" ? input.textModel : base.textModel,
    imageProviderId:
      typeof input.imageProviderId === "string"
        ? input.imageProviderId
        : base.imageProviderId,
    imageModel:
      typeof input.imageModel === "string" ? input.imageModel : base.imageModel,
    thinkingEffort,
    speed,
    approvalMode,
    autoInspect:
      typeof input.autoInspect === "boolean"
        ? input.autoInspect
        : base.autoInspect,
    budgetImages,
    maxRetries,
    defaultSize:
      typeof input.defaultSize === "string" && /^\d{2,5}x\d{2,5}$/.test(input.defaultSize)
        ? input.defaultSize
        : base.defaultSize,
    defaultAutoSize:
      typeof input.defaultAutoSize === "boolean"
        ? input.defaultAutoSize
        : base.defaultAutoSize,
    defaultQuality:
      typeof input.defaultQuality === "string" &&
      ["auto", "low", "medium", "high", "standard", "hd"].includes(
        input.defaultQuality,
      )
        ? input.defaultQuality
        : base.defaultQuality,
    defaultOutputFormat:
      typeof input.defaultOutputFormat === "string" &&
      ["png", "jpeg", "webp"].includes(input.defaultOutputFormat)
        ? input.defaultOutputFormat
        : base.defaultOutputFormat,
  };
}

function buildSystemPrompt(
  config: AgentSessionConfig,
  remainingImages: number,
  remainingRetries: number,
  availableImageModels: Array<{ providerId: string; providerName: string; model: string }>,
): string {
  const modelsText = availableImageModels.length
    ? availableImageModels
        .slice(0, 16)
        .map((m) => `- ${m.model} (providerId: ${m.providerId}, ${m.providerName})`)
        .join("\n")
    : "- (使用会话默认生图模型)";

  return `你是 Bimage 的 AI 图像创作助手与视觉创意搭档。你的核心目标是和用户自然沟通，深入理解他们脑海中的画面、情绪与使用场景，帮他们构思更有质感的作品、策划单张精修或成套批量出图，并在出图后认真审图把关，直到做出真正令用户满意的成品。

【你的角色与交流风格】
- 你是一位有审美、有想法、懂摄影与插画构图的创意搭档，而不是死板的“提示词润色机器”。
- 用自然、简洁、有建设性的语言（跟随用户的语言）交流。
- 当用户的想法还很宽泛（例如“想做一组新品海报但没想好风格”），不要急着乱出图，先给出 2–3 个清晰有画面感的视觉方向或追问 1–2 个关键决定（如用途、画幅比例、风格气质、是否需要统一主角），帮用户把创意想透。
- 当用户目标已经清晰、粘贴了参考图提出改图/同风格创作需求、或已经选定方向要求出图时，果断调用 \`run_image_batch\` 工具落地执行，不要只空谈不行动。
- 写给生图模型的 \`prompt\` 要具体、生动、有镜头与光影调度（主体特征、动作神态、构图景别、光线质感、色彩氛围、材质细节、文字内容精确拼写），避免堆砌空洞的“masterpiece, best quality, 8k”标签；系列/批量出图时，要在各组提示词中显式锚定统一的角色特征、画风与配色，确保整套画面和谐连贯。

【参考图与图生图接力】
- 用户粘贴或上传的图片会标注对应的 \`assetId\`（如 \`[附带图片 assetIds: ...]\`）。你也能直接看到最近上传的图片内容。
- 用户也可能附带 Word（.docx）文档，完整提取文字在 \`[附带文档: ...]\` 内，嵌入图片以 \`[文档图片 #k | assetId: ...]\` 标注。这些图片可直接视觉理解，也可将其 \`assetId\` 传入 \`run_image_batch.references\`。
- 如果用户希望保留某张图的人物/主体/风格/构图或在其基础上修改，请在 \`run_image_batch\` 对应项的 \`references\` 中填入对应的 \`assetId\`。
- 你也可以把上一批生成中效果最接近的成图 \`assetId\` 放入下一批 \`references\`，进行定向精修或保持角色一致性的系列延展。

【工具使用与视觉验收闭环】
1. \`run_image_batch\`: 一次性提交 1 组或多组异构生图任务并等待完成。每组可设置独立的 \`title\`、\`prompt\`、\`count\`、\`size\`/\`autoSize\`、\`references\`。
   - 当前本轮剩余生图预算：**${remainingImages} 张**（所有组的 \`count\` 之和不得超过剩余预算）。
   - 当前审批策略：${config.approvalMode === "confirm" ? "【执行前确认】调用后系统会先向用户展示计划卡片，待用户确认后再真正生图。" : "【自动闭环】调用后会立即开始排队生图。"}
2. \`inspect_images\`: ${config.autoInspect ? `【已开启自动验收，剩余自动修订机会：${remainingRetries} 次】每当 \`run_image_batch\` 成功产出图片后，你应该调用 \`inspect_images\` 亲自查看成图，逐条核对用户需求（主体数量、画面文字拼写、构图比例、风格氛围、有无明显畸变或漏元素）。如果明显未达标且还有预算与修订机会，请向用户简要说明发现的问题，针对性调整提示词或拿最接近的图作为参考图重新生成；若已达标或达到上限，停止重试并呈现成果。` : "【自动验收已关闭】除非用户明确要求你检查图片，否则出图后直接向用户展示成果并给出微调建议。"}
3. \`select_deliverables\`: 当一轮创作包含多张候选或经过多轮迭代后，调用此工具标出最推荐的精选成图 \`assetIds\`，方便用户一键收藏或打包下载。

【当前生图配置】
- 默认生图模型：${config.imageModel || "(未指定)"} (providerId: ${config.imageProviderId || "未指定"})
- 默认画幅：${config.defaultAutoSize !== false ? "自动规格 (autoSize: true)" : config.defaultSize || "1024x1024"}
- 默认质量 / 格式：${config.defaultQuality || "auto"} / ${config.defaultOutputFormat || "png"}
- 可选图像模型列表：
${modelsText}

严格遵守真实结果：永远不要编造不存在的 \`assetId\` 或假装图片已经生成；所有图片引用必须来自用户附件或 \`run_image_batch\` 返回的真实 ID。`;
}

const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "run_image_batch",
      description:
        "Submit one or more image generation jobs (supports heterogeneous prompts, sizes, counts, and reference images for batch/series creation or refinement) and wait until all jobs finish.",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description:
              "Short human-readable summary of this generation batch (shown on the plan/batch card).",
          },
          items: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            description: "List of image generation groups to run in this batch.",
            items: {
              type: "object",
              properties: {
                title: {
                  type: "string",
                  description:
                    "Short label for this variation/scene, e.g. '春季海报' or '方案 A：暖调特写'.",
                },
                prompt: {
                  type: "string",
                  description:
                    "Detailed, vivid image-generation prompt tailored to the visual goal.",
                },
                count: {
                  type: "integer",
                  minimum: 1,
                  maximum: 8,
                  description: "Number of images to generate for this item (default 1).",
                },
                autoSize: {
                  type: "boolean",
                  description:
                    "Set true to use automatic aspect/resolution; set false when specifying explicit size.",
                },
                size: {
                  type: "string",
                  description:
                    "Explicit WxH resolution like '1024x1024', '1536x1024', '1024x1536' (used when autoSize is false).",
                },
                quality: {
                  type: "string",
                  enum: ["auto", "low", "medium", "high", "standard", "hd"],
                },
                output_format: {
                  type: "string",
                  enum: ["png", "jpeg", "webp"],
                },
                references: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Optional list of exact assetIds (from user uploads or previous generations) to use as reference images.",
                },
                providerId: {
                  type: "string",
                  description: "Optional override image providerId.",
                },
                model: {
                  type: "string",
                  description: "Optional override image model ID.",
                },
              },
              required: ["title", "prompt"],
            },
          },
        },
        required: ["summary", "items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_images",
      description:
        "Visually inspect generated images against the user's creative requirements using vision capabilities, returning structured pass/fail checks and concrete improvement advice.",
      parameters: {
        type: "object",
        properties: {
          assetIds: {
            type: "array",
            minItems: 1,
            maxItems: MAX_INSPECT_IMAGES,
            items: { type: "string" },
            description: "Exact generated assetIds to visually inspect.",
          },
          criteria: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: { type: "string" },
            description:
              "Specific visual requirements to verify (subject, composition, text spelling, mood, consistency, etc.).",
          },
          goal: {
            type: "string",
            description: "Brief restatement of the user's goal for this batch.",
          },
        },
        required: ["assetIds", "criteria"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "select_deliverables",
      description:
        "Highlight the best final selected images as deliverables for easy download or favoriting.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Short title for the deliverable set.",
          },
          summary: {
            type: "string",
            description: "Brief note explaining why these images best fulfill the request.",
          },
          assetIds: {
            type: "array",
            minItems: 1,
            maxItems: 16,
            items: { type: "string" },
          },
        },
        required: ["title", "assetIds"],
      },
    },
  },
];

function parseJsonSafe<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function deriveSessionTitle(content: string): string {
  const clean = content.replace(/\s+/g, " ").trim();
  if (!clean) return "新创作对话";
  return clean.length > 28 ? clean.slice(0, 28) + "…" : clean;
}

export class AgentService {
  private subscribers = new Map<string, Set<Response>>();
  private activeRuns = new Map<string, ActiveRunHandle>();
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private visionProbeCache = new Map<string, { supported: boolean; checkedAt: number }>();

  constructor(
    private store: Store,
    private providers: Providers,
    private assets: Assets,
    private queue: Queue,
  ) {
    // Mark any leftover in-flight runs from a previous process as cancelled on startup.
    const now = new Date().toISOString();
    this.store.run(
      "UPDATE agent_runs SET status='cancelled', error='服务已重启，运行已中断', finishedAt=? WHERE status='running'",
      now,
    );
    this.heartbeatTimer = setInterval(() => {
      for (const set of this.subscribers.values()) {
        for (const res of set) {
          try {
            res.write(": ping\n\n");
          } catch {
            set.delete(res);
          }
        }
      }
    }, 20000);
    this.heartbeatTimer.unref?.();
  }

  shutdown(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    for (const handle of this.activeRuns.values()) {
      handle.controller.abort();
    }
    this.activeRuns.clear();
    for (const set of this.subscribers.values()) {
      for (const res of set) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
      set.clear();
    }
    this.subscribers.clear();
  }

  private emit(sessionId: string, event: string, data: unknown): void {
    const set = this.subscribers.get(sessionId);
    if (!set || !set.size) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of set) {
      try {
        res.write(payload);
      } catch {
        set.delete(res);
      }
    }
  }

  private ownSession(id: string, identity: Owner): AgentSessionRow {
    const row = this.store.get<AgentSessionRow>(
      "SELECT * FROM agent_sessions WHERE id=?",
      id,
    );
    if (!row || row.owner !== identity.id) {
      throw fail(404, "对话会话不存在");
    }
    return row;
  }

  private formatSession(row: AgentSessionRow) {
    return {
      id: row.id,
      title: row.title,
      config: normalizeConfig(parseJsonSafe(row.config, {})),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private hydrateCards(cards: AgentCard[], identity: Owner): AgentCard[] {
    return cards.map((card) => {
      if (card.type !== "batch") return card;
      const items = card.items.map((item) => {
        try {
          const job = this.queue.getJobView(item.jobId, identity);
          return {
            ...item,
            status: job.status,
            tasks: job.tasks.map((task) => ({
              id: task.id,
              status: task.status,
              asset: task.asset ?? null,
              error: task.error ?? null,
              width: "width" in task ? (task.width ?? null) : null,
              height: "height" in task ? (task.height ?? null) : null,
              mime: "mime" in task ? task.mime : undefined,
            })),
          };
        } catch {
          return item;
        }
      });
      return { ...card, items };
    });
  }

  private getDocuments(ids: string[], owner: string): AgentDocumentRow[] {
    return ids.flatMap((id) => {
      const row = this.store.get<AgentDocumentRow>(
        "SELECT * FROM agent_documents WHERE id=? AND owner=?", id, owner,
      );
      return row ? [row] : [];
    });
  }

  private formatDocument(row: AgentDocumentRow): AgentDocumentRef {
    return {
      id: row.id, name: row.name, size: row.size, charCount: row.charCount,
      images: parseJsonSafe<string[]>(row.images, []),
      skippedImages: row.skippedImages, truncated: Boolean(row.truncated),
      excerpt: row.text.replace(/\s+/g, " ").trim().slice(0, 180),
    };
  }

  private formatMessage(row: AgentMessageRow, identity: Owner) {
    const cards = parseJsonSafe<AgentCard[]>(row.cards, []);
    return {
      id: row.id,
      sessionId: row.sessionId,
      role: row.role,
      content: row.content,
      reasoning: row.reasoning,
      attachments: parseJsonSafe<string[]>(row.attachments, []),
      documents: this.getDocuments(parseJsonSafe<string[]>(row.documents, []), identity.id)
        .map((document) => this.formatDocument(document)),
      cards: this.hydrateCards(cards, identity),
      createdAt: row.createdAt,
    };
  }

  private formatRun(row: AgentRunRow | undefined) {
    if (!row) return null;
    const pending = parseJsonSafe<PendingPlanPayload | null>(row.pendingPlan, null);
    return {
      id: row.id,
      sessionId: row.sessionId,
      status: row.status,
      budgetImages: row.budgetImages,
      usedImages: row.usedImages,
      maxRetries: row.maxRetries,
      usedRetries: row.usedRetries,
      pendingPlanCardId: pending?.cardId ?? null,
      jobIds: parseJsonSafe<string[]>(row.jobIds, []),
      error: row.error,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    };
  }

  private getSessionDetail(sessionId: string, identity: Owner) {
    const session = this.ownSession(sessionId, identity);
    const messages = this.store
      .all<AgentMessageRow>(
        "SELECT * FROM agent_messages WHERE sessionId=? ORDER BY createdAt ASC, rowid ASC",
        session.id,
      )
      .map((row) => this.formatMessage(row, identity));
    const latestRun = this.store.get<AgentRunRow>(
      "SELECT * FROM agent_runs WHERE sessionId=? ORDER BY startedAt DESC, rowid DESC LIMIT 1",
      session.id,
    );
    return {
      session: this.formatSession(session),
      messages,
      run: this.formatRun(latestRun),
    };
  }

  private insertMessage(
    sessionId: string,
    owner: string,
    role: "user" | "assistant",
    content: string,
    attachments: string[] = [],
    cards: AgentCard[] = [],
    reasoning = "",
    documents: string[] = [],
  ): AgentMessageRow {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.store.run(
      "INSERT INTO agent_messages(id,sessionId,owner,role,content,reasoning,attachments,cards,createdAt,documents) VALUES(?,?,?,?,?,?,?,?,?,?)",
      id,
      sessionId,
      owner,
      role,
      content,
      reasoning,
      JSON.stringify(attachments),
      JSON.stringify(cards),
      createdAt,
      JSON.stringify(documents),
    );
    this.store.run(
      "UPDATE agent_sessions SET updatedAt=? WHERE id=?",
      createdAt,
      sessionId,
    );
    return this.store.get<AgentMessageRow>(
      "SELECT * FROM agent_messages WHERE id=?",
      id,
    )!;
  }

  private updateMessage(
    id: string,
    patch: { content?: string; reasoning?: string; cards?: AgentCard[] },
  ): void {
    const row = this.store.get<AgentMessageRow>(
      "SELECT * FROM agent_messages WHERE id=?",
      id,
    );
    if (!row) return;
    const content = patch.content ?? row.content;
    const reasoning = patch.reasoning ?? row.reasoning;
    const cards = patch.cards !== undefined ? JSON.stringify(patch.cards) : row.cards;
    this.store.run(
      "UPDATE agent_messages SET content=?, reasoning=?, cards=? WHERE id=?",
      content,
      reasoning,
      cards,
      id,
    );
    this.store.run(
      "UPDATE agent_sessions SET updatedAt=? WHERE id=?",
      new Date().toISOString(),
      row.sessionId,
    );
  }

  private updateRun(
    runId: string,
    patch: Partial<{
      status: AgentRunStatus;
      usedImages: number;
      usedRetries: number;
      pendingPlan: PendingPlanPayload | null;
      jobIds: string[];
      error: string | null;
      finishedAt: string | null;
    }>,
  ): AgentRunRow {
    const current = this.store.get<AgentRunRow>(
      "SELECT * FROM agent_runs WHERE id=?",
      runId,
    )!;
    const status = patch.status ?? current.status;
    const usedImages = patch.usedImages ?? current.usedImages;
    const usedRetries = patch.usedRetries ?? current.usedRetries;
    const pendingPlan =
      patch.pendingPlan !== undefined
        ? patch.pendingPlan
          ? JSON.stringify(patch.pendingPlan)
          : null
        : current.pendingPlan;
    const jobIds =
      patch.jobIds !== undefined ? JSON.stringify(patch.jobIds) : current.jobIds;
    const error = patch.error !== undefined ? patch.error : current.error;
    const finishedAt =
      patch.finishedAt !== undefined ? patch.finishedAt : current.finishedAt;

    this.store.run(
      "UPDATE agent_runs SET status=?, usedImages=?, usedRetries=?, pendingPlan=?, jobIds=?, error=?, finishedAt=? WHERE id=?",
      status,
      usedImages,
      usedRetries,
      pendingPlan,
      jobIds,
      error,
      finishedAt,
      runId,
    );
    const updated = this.store.get<AgentRunRow>(
      "SELECT * FROM agent_runs WHERE id=?",
      runId,
    )!;
    this.emit(updated.sessionId, "run", this.formatRun(updated));
    return updated;
  }

  private async prepareVisionDataUrl(
    assetId: string,
    owner: string,
    maxDim = 1024,
    quality = 82,
  ): Promise<string | null> {
    try {
      const asset = this.assets.owned(assetId, owner);
      if (!imageType(asset.bytes, asset.mime)) return null;
      const raw = Buffer.from(asset.bytes);
      try {
        const resized = await sharp(raw)
          .rotate()
          .resize({
            width: maxDim,
            height: maxDim,
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({ quality })
          .toBuffer();
        return `data:image/webp;base64,${resized.toString("base64")}`;
      } catch {
        if (raw.length > 6 * 1024 * 1024) return null;
        return `data:${asset.mime};base64,${raw.toString("base64")}`;
      }
    } catch {
      return null;
    }
  }

  private listAvailableImageModels(identity: Owner) {
    const rows = this.store.all<ProviderRow>(
      "SELECT * FROM providers WHERE owner=? OR shared=1 ORDER BY rowid",
      identity.id,
    );
    const models: Array<{
      providerId: string;
      providerName: string;
      model: string;
    }> = [];
    for (const row of rows) {
      const parsed = parseJsonSafe<Array<{ id?: string; types?: string[] }>>(
        row.models,
        [],
      );
      for (const m of parsed) {
        if (m.id && Array.isArray(m.types) && m.types.includes("image")) {
          models.push({
            providerId: row.id,
            providerName: row.name,
            model: m.id,
          });
        }
      }
    }
    return models;
  }

  private async buildConversationHistory(
    sessionId: string,
    identity: Owner,
    config: AgentSessionConfig,
    remainingImages: number,
    remainingRetries: number,
  ): Promise<ChatMessage[]> {
    const rows = this.store.all<AgentMessageRow>(
      "SELECT * FROM agent_messages WHERE sessionId=? ORDER BY createdAt ASC, rowid ASC",
      sessionId,
    );
    const availableImageModels = this.listAvailableImageModels(identity);
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: buildSystemPrompt(
          config,
          remainingImages,
          remainingRetries,
          availableImageModels,
        ),
      },
    ];

    // Keep recent context, attaching visual payloads for the latest two image-bearing user turns.
    const recent = rows.slice(-24);
    const userDocuments = recent.map((row) => row.role === "user"
      ? this.getDocuments(parseJsonSafe<string[]>(row.documents, []), identity.id) : []);
    const userImages = recent.map((row, index) => [...new Set([
      ...parseJsonSafe<string[]>(row.attachments, []),
      ...userDocuments[index].flatMap((doc) => parseJsonSafe<string[]>(doc.images, [])),
    ])]);
    const userAttachmentIndices = new Set<number>();
    for (let i = recent.length - 1; i >= 0 && userAttachmentIndices.size < 2; i--) {
      if (recent[i].role === "user" && userImages[i].length) userAttachmentIndices.add(i);
    }

    for (let i = 0; i < recent.length; i++) {
      const row = recent[i];
      if (row.role === "user") {
        const attachments = userImages[i];
        const documents = userDocuments[i];
        const documentText = documents.map((doc) =>
          `[附带文档: ${doc.name}（共 ${doc.charCount} 字，包含 ${parseJsonSafe<string[]>(doc.images, []).length} 张嵌入图片）]\n${doc.text}\n[文档结束: ${doc.name}]`,
        );
        const textBody = [
          row.content || (documents.length
            ? "请完整阅读并理解附带文档中的全部文字与嵌入图片内容，再按文档意图回应或推进创作。"
            : "请结合这些图片帮我构思和出图。"),
          ...documentText,
          attachments.length ? `[附带图片 assetIds: ${attachments.join(", ")}]` : "",
          attachments.length > MAX_VISION_IMAGES_PER_MESSAGE && userAttachmentIndices.has(i)
            ? `[图片较多，仅前 ${MAX_VISION_IMAGES_PER_MESSAGE} 张附带视觉内容，全部 assetIds 已列出。]` : "",
        ].filter(Boolean).join("\n\n");

        if (attachments.length && userAttachmentIndices.has(i)) {
          const parts: Array<Record<string, unknown>> = [
            { type: "text", text: textBody },
          ];
          const imageCount = Math.min(attachments.length, MAX_VISION_IMAGES_PER_MESSAGE);
          const maxDim = imageCount <= 6 ? 1024 : imageCount <= 12 ? 768 : 640;
          const quality = imageCount <= 6 ? 82 : imageCount <= 12 ? 78 : 74;
          for (const assetId of attachments.slice(0, MAX_VISION_IMAGES_PER_MESSAGE)) {
            const url = await this.prepareVisionDataUrl(assetId, identity.id, maxDim, quality);
            if (url) {
              parts.push({ type: "image_url", image_url: { url } });
            }
          }
          messages.push({ role: "user", content: parts });
        } else {
          messages.push({ role: "user", content: textBody });
        }
      } else {
        const cards = this.hydrateCards(
          parseJsonSafe<AgentCard[]>(row.cards, []),
          identity,
        );
        const cardNotes: string[] = [];
        for (const card of cards) {
          if (card.type === "batch") {
            const summaryLines = card.items.map((item) => {
              const assets = item.tasks
                .filter((t) => t.status === "succeeded" && t.asset)
                .map((t) => t.asset);
              return `- ${item.title} (${item.status}, assets: ${assets.join(", ") || "无"})`;
            });
            cardNotes.push(`[已执行批次: ${card.summary}\n${summaryLines.join("\n")}]`);
          } else if (card.type === "inspection") {
            cardNotes.push(
              `[视觉验收(${card.passed ? "通过" : "未通过"}): ${card.summary}${card.bestAssetIds.length ? ` | 推荐图: ${card.bestAssetIds.join(", ")}` : ""}]`,
            );
          } else if (card.type === "deliverables") {
            cardNotes.push(
              `[精选交付: ${card.title} | assets: ${card.assetIds.join(", ")}]`,
            );
          }
        }
        const combined = [row.content, ...cardNotes].filter(Boolean).join("\n\n");
        if (combined) {
          messages.push({ role: "assistant", content: combined });
        }
      }
    }
    return messages;
  }

  private async probeModelVisionSupport(
    provider: ProviderRow,
    model: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const key = JSON.stringify([provider.id, provider.baseUrl, model]);
    const cached = this.visionProbeCache.get(key);
    if (cached && Date.now() - cached.checkedAt < 10 * 60 * 1000) return cached.supported;
    this.visionProbeCache.delete(key);
    try {
      const { response, close } = await this.providers.requestStream(provider, "/chat/completions", {
        model,
        messages: [{ role: "user", content: [
          { type: "text", text: "ok" },
          { type: "image_url", image_url: {
            url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=",
          } },
        ] }],
        max_tokens: 1,
        stream: false,
      }, signal);
      try {
        const errText = response.ok ? "" : await response.text().catch(() => "");
        const supported = response.ok || !([400, 404, 415, 422].includes(response.status)
          || (![401, 403, 429].includes(response.status) && response.status < 500 && isVisionUnsupportedError(errText)));
        if (response.ok || !supported) this.visionProbeCache.set(key, { supported, checkedAt: Date.now() });
        return supported;
      } finally {
        await close();
      }
    } catch {
      // Network/auth/rate-limit/server failures cannot establish a lack of vision capability.
      return true;
    }
  }

  private async callChatCompletion(
    provider: ProviderRow,
    config: AgentSessionConfig,
    messages: ChatMessage[],
    options: {
      tools?: typeof AGENT_TOOLS;
      stream?: boolean;
      signal: AbortSignal;
      requireVision?: boolean;
      onTextDelta?: (delta: string) => void;
      onReasoningDelta?: (delta: string) => void;
    },
  ): Promise<{
    content: string;
    reasoning: string;
    toolCalls: ChatToolCall[];
  }> {
    let includeEffort = true;
    let includeTier = config.speed === "priority";
    let includeTools = Boolean(options.tools?.length);
    let useStream = options.stream !== false;
    let stripVisionImages = false;

    for (let attempt = 0; attempt < 7; attempt++) {
      const preparedMessages = stripVisionImages
        ? messages.map((m) => {
            if (!Array.isArray(m.content)) return m;
            const textOnly = m.content
              .filter((p) => p.type === "text" && typeof p.text === "string")
              .map((p) => String(p.text))
              .join("\n");
            return { ...m, content: textOnly };
          })
        : messages;
      const hasVisionParts = preparedMessages.some((message) =>
        Array.isArray(message.content) && message.content.some((part) => part.type === "image_url"),
      );

      const payload: Record<string, unknown> = {
        model: config.textModel,
        messages: preparedMessages,
        stream: useStream,
      };
      if (includeTools && options.tools?.length) {
        payload.tools = options.tools;
        payload.tool_choice = "auto";
      }
      if (includeEffort) {
        payload.reasoning_effort = config.thinkingEffort;
      }
      if (includeTier) {
        payload.service_tier = "priority";
      }

      const { response, close } = await this.providers.requestStream(
        provider,
        "/chat/completions",
        payload,
        options.signal,
      );

      try {
        if (!response.ok) {
          const errText = await response.text().catch(() => "");
          const lower = errText.toLowerCase();
          if (hasVisionParts && isVisionUnsupportedError(errText)) {
            if (options.requireVision) {
              this.visionProbeCache.set(JSON.stringify([provider.id, provider.baseUrl, config.textModel]), {
                supported: false, checkedAt: Date.now(),
              });
              throw new VisionUnsupportedError(config.textModel);
            }
            stripVisionImages = true;
            continue;
          }

          // Graceful degradation when third-party OpenAI-compatible gateways reject optional params.
          if (response.status === 400 || response.status === 422) {
            let retried = false;
            if (includeEffort && /reasoning_effort|reasoning|effort|unknown.*field|extra.*forbidden|unsupported/i.test(lower)) {
              includeEffort = false;
              retried = true;
            }
            if (includeTier && /service_tier|priority|unknown.*field|extra.*forbidden|unsupported/i.test(lower)) {
              includeTier = false;
              retried = true;
            }
            if (!retried && includeTier) {
              includeTier = false;
              retried = true;
            } else if (!retried && includeEffort) {
              includeEffort = false;
              retried = true;
            } else if (!retried && useStream && /stream/i.test(lower)) {
              useStream = false;
              retried = true;
            } else if (!retried && includeTools && /tool|function/i.test(lower)) {
              includeTools = false;
              retried = true;
            }
            if (retried) continue;
          }
          if (hasVisionParts && options.requireVision && [400, 415, 422].includes(response.status)) {
            if (!await this.probeModelVisionSupport(provider, config.textModel, options.signal)) {
              throw new VisionUnsupportedError(config.textModel);
            }
          }

          let detail = "";
          try {
            const parsed = JSON.parse(errText) as { error?: { message?: string } | string };
            detail =
              typeof parsed.error === "string"
                ? parsed.error
                : parsed.error?.message || "";
          } catch {
            detail = errText.slice(0, 200);
          }
          throw fail(
            response.status,
            detail
              ? `对话模型请求失败（HTTP ${response.status}）：${detail}`
              : `对话模型请求失败（HTTP ${response.status}）`,
          );
        }
        if (hasVisionParts) {
          this.visionProbeCache.set(JSON.stringify([provider.id, provider.baseUrl, config.textModel]), {
            supported: true, checkedAt: Date.now(),
          });
        }

        const contentType = (response.headers.get("content-type") || "").toLowerCase();
        if (!useStream || contentType.includes("application/json")) {
          const json = object(await response.json());
          if (json.error) {
            const detail = typeof json.error === "string" ? json.error : JSON.stringify(json.error);
            if (hasVisionParts && options.requireVision && isVisionUnsupportedError(detail)) {
              this.visionProbeCache.set(JSON.stringify([provider.id, provider.baseUrl, config.textModel]), {
                supported: false, checkedAt: Date.now(),
              });
              throw new VisionUnsupportedError(config.textModel);
            }
            if (hasVisionParts && !options.requireVision && isVisionUnsupportedError(detail)) {
              stripVisionImages = true;
              continue;
            }
            throw fail(502, `对话模型请求失败：${detail.slice(0, 200)}`);
          }
          const choices = Array.isArray(json.choices) ? json.choices : [];
          const first = choices[0] ? object(choices[0]) : {};
          const message = first.message ? object(first.message) : {};
          const content =
            typeof message.content === "string" ? message.content : "";
          const reasoning =
            typeof message.reasoning_content === "string"
              ? message.reasoning_content
              : typeof message.reasoning === "string"
                ? message.reasoning
                : "";
          if (reasoning) options.onReasoningDelta?.(reasoning);
          if (content) options.onTextDelta?.(content);
          const rawCalls = Array.isArray(message.tool_calls)
            ? message.tool_calls
            : [];
          const toolCalls: ChatToolCall[] = rawCalls
            .map((raw) => {
              const tc = object(raw);
              const fn = tc.function ? object(tc.function) : {};
              return {
                id: typeof tc.id === "string" && tc.id ? tc.id : randomUUID(),
                type: "function" as const,
                function: {
                  name: typeof fn.name === "string" ? fn.name : "",
                  arguments:
                    typeof fn.arguments === "string"
                      ? fn.arguments
                      : JSON.stringify(fn.arguments ?? {}),
                },
              };
            })
            .filter((tc) => tc.function.name);
          return { content, reasoning, toolCalls };
        }

        // Parse SSE stream
        const bodyStream = response.body;
        if (!bodyStream) {
          throw fail(502, "对话模型返回了空流");
        }

        const reader = bodyStream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let content = "";
        let reasoning = "";
        const toolCallMap = new Map<
          number,
          { id: string; name: string; arguments: string }
        >();

        const processLine = (rawLine: string) => {
          const line = rawLine.trim();
          if (!line.startsWith("data:")) return;
          const dataStr = line.slice(5).trim();
          if (!dataStr || dataStr === "[DONE]") return;
          let chunk: Record<string, unknown>;
          try {
            chunk = JSON.parse(dataStr) as Record<string, unknown>;
          } catch {
            return;
          }
          if (chunk.error) {
            const detail = typeof chunk.error === "string" ? chunk.error : JSON.stringify(chunk.error);
            if (hasVisionParts && options.requireVision && isVisionUnsupportedError(detail)) {
              this.visionProbeCache.set(JSON.stringify([provider.id, provider.baseUrl, config.textModel]), {
                supported: false, checkedAt: Date.now(),
              });
              throw new VisionUnsupportedError(config.textModel);
            }
            throw fail(502, `对话模型请求失败：${detail.slice(0, 200)}`);
          }
          const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
          const first = choices[0] ? object(choices[0]) : {};
          const delta = first.delta ? object(first.delta) : {};

          const rDelta =
            typeof delta.reasoning_content === "string"
              ? delta.reasoning_content
              : typeof delta.reasoning === "string"
                ? delta.reasoning
                : "";
          if (rDelta) {
            reasoning += rDelta;
            options.onReasoningDelta?.(rDelta);
          }

          if (typeof delta.content === "string" && delta.content) {
            content += delta.content;
            options.onTextDelta?.(delta.content);
          }

          if (Array.isArray(delta.tool_calls)) {
            for (const item of delta.tool_calls) {
              const tc = object(item);
              const idx = typeof tc.index === "number" ? tc.index : 0;
              const existing = toolCallMap.get(idx) ?? {
                id: "",
                name: "",
                arguments: "",
              };
              if (typeof tc.id === "string" && tc.id) existing.id = tc.id;
              const fn = tc.function ? object(tc.function) : {};
              if (typeof fn.name === "string" && fn.name) existing.name += fn.name;
              if (typeof fn.arguments === "string" && fn.arguments) {
                existing.arguments += fn.arguments;
              }
              toolCallMap.set(idx, existing);
            }
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) processLine(line);
        }
        if (buffer.trim()) processLine(buffer);

        const toolCalls: ChatToolCall[] = Array.from(toolCallMap.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([, tc]) => ({
            id: tc.id || randomUUID(),
            type: "function" as const,
            function: {
              name: tc.name,
              arguments: tc.arguments || "{}",
            },
          }))
          .filter((tc) => tc.function.name);

        return { content, reasoning, toolCalls };
      } finally {
        await close();
      }
    }

    throw fail(502, "对话模型请求重试后仍失败");
  }

  private sanitizePlanItems(
    rawItems: unknown,
    config: AgentSessionConfig,
    identity: Owner,
    remainingImages: number,
    strict = false,
  ): AgentPlanItem[] {
    if (!Array.isArray(rawItems) || !rawItems.length) {
      throw fail(400, "生图计划为空");
    }
    if (remainingImages <= 0) {
      throw fail(400, "超出本轮生图预算上限");
    }
    const items: AgentPlanItem[] = [];
    let runningTotal = 0;

    for (let i = 0; i < Math.min(rawItems.length, 8); i++) {
      const raw = object(rawItems[i]);
      const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
      if (!prompt) {
        if (strict) throw fail(400, "生图提示词不能为空");
        continue;
      }
      const title =
        typeof raw.title === "string" && raw.title.trim()
          ? raw.title.trim().slice(0, 80)
          : `作品 ${i + 1}`;
      const requestedCount =
        typeof raw.count === "number" && Number.isFinite(raw.count)
          ? Math.max(1, Math.min(8, Math.round(raw.count)))
          : 1;
      const allowedCount = Math.min(requestedCount, remainingImages - runningTotal);
      if (allowedCount <= 0) break;
      runningTotal += allowedCount;

      const providerId =
        typeof raw.providerId === "string" && raw.providerId.trim()
          ? raw.providerId.trim()
          : config.imageProviderId;
      const model =
        typeof raw.model === "string" && raw.model.trim()
          ? raw.model.trim()
          : config.imageModel;

      const rawRefs = Array.isArray(raw.references) ? raw.references : [];
      const validRefs: string[] = [];
      for (const refId of rawRefs) {
        if (typeof refId !== "string" || validRefs.includes(refId)) continue;
        if (validRefs.length >= MAX_REFERENCE_IMAGES) break;
        try {
          this.assets.owned(refId, identity.id);
          validRefs.push(refId);
        } catch {
          // Ignore hallucinated or non-owned asset IDs gracefully.
        }
      }

      const explicitSize =
        typeof raw.size === "string" && /^\d{2,5}x\d{2,5}$/.test(raw.size)
          ? raw.size
          : config.defaultSize || "1024x1024";
      const autoSize =
        typeof raw.autoSize === "boolean"
          ? raw.autoSize
          : typeof raw.size === "string" && /^\d{2,5}x\d{2,5}$/.test(raw.size)
            ? false
            : config.defaultAutoSize !== false;

      const quality =
        typeof raw.quality === "string" &&
        ["auto", "low", "medium", "high", "standard", "hd"].includes(raw.quality)
          ? raw.quality
          : config.defaultQuality || "auto";
      const output_format =
        typeof raw.output_format === "string" &&
        ["png", "jpeg", "webp"].includes(raw.output_format)
          ? raw.output_format
          : config.defaultOutputFormat || "png";

      items.push({
        title,
        prompt: prompt.slice(0, 16000),
        count: allowedCount,
        autoSize,
        size: autoSize ? undefined : explicitSize,
        quality,
        output_format,
        references: validRefs,
        providerId,
        model,
      });
    }

    if (!items.length) {
      throw fail(400, "超出本轮生图预算上限或提示词为空");
    }
    return items;
  }

  private async executeBatchAndWait(
    sessionId: string,
    runId: string,
    messageId: string,
    cards: AgentCard[],
    summary: string,
    items: AgentPlanItem[],
    config: AgentSessionConfig,
    identity: Owner,
    handle: ActiveRunHandle,
  ): Promise<{ batchCard: AgentBatchCard; toolResult: Record<string, unknown> }> {
    const batchItems: AgentBatchItemView[] = [];
    const currentRun = this.store.get<AgentRunRow>(
      "SELECT * FROM agent_runs WHERE id=?",
      runId,
    )!;
    const allJobIds = new Set(parseJsonSafe<string[]>(currentRun.jobIds, []));
    let addedImages = 0;

    for (const item of items) {
      const providerId = item.providerId || config.imageProviderId;
      const model = item.model || config.imageModel;
      if (!providerId || !model) {
        throw fail(400, "尚未配置默认生图模型，请先在对话栏上方选择生图模型");
      }
      const form: ImageForm = {
        providerId,
        model,
        prompt: item.prompt,
        count: item.count,
        autoSize: item.autoSize !== false,
        size: item.autoSize !== false ? undefined : item.size || "1024x1024",
        quality: item.quality || config.defaultQuality || "auto",
        output_format: item.output_format || config.defaultOutputFormat || "png",
        references: item.references || [],
        source: "agent",
        agentSessionId: sessionId,
      };
      const job = this.queue.enqueue(form, identity);
      allJobIds.add(job.id);
      handle.jobIds.add(job.id);
      addedImages += item.count;
      batchItems.push({
        title: item.title,
        jobId: job.id,
        prompt: item.prompt,
        count: item.count,
        size: form.size,
        autoSize: form.autoSize,
        model,
        providerId,
        references: form.references,
        status: job.status,
        tasks: job.tasks.map((t) => ({
          id: t.id,
          status: t.status,
          asset: t.asset ?? null,
          error: t.error ?? null,
        })),
      });
    }

    this.updateRun(runId, {
      usedImages: currentRun.usedImages + addedImages,
      jobIds: Array.from(allJobIds),
    });

    const batchCard: AgentBatchCard = {
      id: randomUUID(),
      type: "batch",
      runId,
      summary,
      items: batchItems,
    };
    cards.push(batchCard);
    this.updateMessage(messageId, { cards });
    this.emit(sessionId, "card", { messageId, card: batchCard });

    // Poll Queue state until all jobs in this batch reach terminal state or run is aborted.
    let lastSig = "";
    while (!handle.controller.signal.aborted) {
      let allDone = true;
      for (const item of batchCard.items) {
        try {
          const job = this.queue.getJobView(item.jobId, identity);
          item.status = job.status;
          item.tasks = job.tasks.map((t) => ({
            id: t.id,
            status: t.status,
            asset: t.asset ?? null,
            error: t.error ?? null,
            width: "width" in t ? (t.width ?? null) : null,
            height: "height" in t ? (t.height ?? null) : null,
            mime: "mime" in t ? t.mime : undefined,
          }));
          if (!TERMINAL_TASK_STATUSES.has(job.status)) {
            allDone = false;
          }
        } catch {
          item.status = "failed";
        }
      }

      const sig = JSON.stringify(
        batchCard.items.map((it) => [
          it.status,
          it.tasks.map((t) => [t.status, t.asset, t.error]),
        ]),
      );
      if (sig !== lastSig) {
        lastSig = sig;
        this.updateMessage(messageId, { cards });
        this.emit(sessionId, "card", { messageId, card: batchCard });
      }
      if (allDone) break;

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 700);
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        handle.controller.signal.addEventListener("abort", onAbort, { once: true });
      });
    }

    const succeededAssets: Array<{
      title: string;
      jobId: string;
      assetId: string;
      width: number | null;
      height: number | null;
    }> = [];
    const failedItems: Array<{ title: string; error: string }> = [];

    for (const item of batchCard.items) {
      for (const task of item.tasks) {
        if (task.status === "succeeded" && task.asset) {
          succeededAssets.push({
            title: item.title,
            jobId: item.jobId,
            assetId: task.asset,
            width: task.width ?? null,
            height: task.height ?? null,
          });
        } else if (task.status === "failed" || task.status === "cancelled") {
          failedItems.push({
            title: item.title,
            error: task.error || task.status,
          });
        }
      }
    }

    return {
      batchCard,
      toolResult: {
        summary,
        succeededCount: succeededAssets.length,
        failedCount: failedItems.length,
        succeededAssets,
        failedItems,
      },
    };
  }

  private async runVisualInspection(
    sessionId: string,
    runId: string,
    messageId: string,
    cards: AgentCard[],
    provider: ProviderRow,
    config: AgentSessionConfig,
    identity: Owner,
    args: { assetIds: string[]; criteria: string[]; goal?: string },
    signal: AbortSignal,
  ): Promise<{ card: AgentInspectionCard; toolResult: Record<string, unknown> }> {
    const validIds: string[] = [];
    const imageParts: Array<Record<string, unknown>> = [];

    for (const id of args.assetIds.slice(0, MAX_INSPECT_IMAGES)) {
      if (typeof id !== "string" || validIds.includes(id)) continue;
      const dataUrl = await this.prepareVisionDataUrl(id, identity.id);
      if (dataUrl) {
        validIds.push(id);
        imageParts.push({ type: "image_url", image_url: { url: dataUrl } });
      }
    }

    if (!validIds.length) {
      const card: AgentInspectionCard = {
        id: randomUUID(),
        type: "inspection",
        runId,
        passed: false,
        summary: "未找到可检查的生成图片。",
        checks: [],
        bestAssetIds: [],
        inspectedAssetIds: [],
      };
      cards.push(card);
      this.updateMessage(messageId, { cards });
      this.emit(sessionId, "card", { messageId, card });
      return { card, toolResult: { passed: false, error: "no_valid_assets" } };
    }

    const criteriaList = (args.criteria.length ? args.criteria : ["整体画面符合用户要求"])
      .slice(0, 8)
      .map((c, idx) => `${idx + 1}. ${c}`)
      .join("\n");

    const reviewMessages: ChatMessage[] = [
      {
        role: "system",
        content: `你是 Bimage 的视觉质量评审员。请严格观察传入的图片，逐条核对验收标准（注意人物数量、肢体/文字畸变、主体特征、构图、色调、氛围与细节）。
请只返回一个 JSON 对象（不要输出其他多余说明）：
{
  "passed": true/false,
  "summary": "一句简洁清晰的中文或用户语言总评",
  "checks": [
    { "criterion": "核对项", "status": "pass" | "warn" | "fail", "note": "具体观察到的画面细节" }
  ],
  "bestAssetIds": ["最符合要求的 assetId，按推荐顺序排列"],
  "suggestedFix": "若未通过，写出具体可执行的修改建议（否则留空字符串）"
}`,
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `创作目标：${args.goal || "满足用户需求"}\n图片顺序对应的 assetIds：${validIds.map((id, i) => `图${i + 1}=${id}`).join("，")}\n\n验收标准：\n${criteriaList}`,
          },
          ...imageParts,
        ],
      },
    ];

    try {
      const result = await this.callChatCompletion(provider, config, reviewMessages, {
        stream: false,
        signal,
        requireVision: true,
      });
      const parsed = extractJsonObject(result.content);
      const passed = parsed ? Boolean(parsed.passed) : true;
      const summary =
        parsed && typeof parsed.summary === "string" && parsed.summary.trim()
          ? parsed.summary.trim()
          : result.content.trim().slice(0, 300) || "已完成视觉检查。";
      const checks: AgentInspectionCheck[] =
        parsed && Array.isArray(parsed.checks)
          ? parsed.checks
              .slice(0, 8)
              .map((c) => {
                const obj = object(c);
                const status =
                  obj.status === "pass" ||
                  obj.status === "warn" ||
                  obj.status === "fail"
                    ? obj.status
                    : "pass";
                return {
                  criterion:
                    typeof obj.criterion === "string" ? obj.criterion : "检查项",
                  status,
                  note: typeof obj.note === "string" ? obj.note : "",
                };
              })
          : [];
      const bestAssetIds =
        parsed && Array.isArray(parsed.bestAssetIds)
          ? parsed.bestAssetIds.filter(
              (id): id is string =>
                typeof id === "string" && validIds.includes(id),
            )
          : validIds.slice(0, 1);
      const suggestedFix =
        parsed && typeof parsed.suggestedFix === "string" && parsed.suggestedFix.trim()
          ? parsed.suggestedFix.trim()
          : undefined;

      if (!passed) {
        const currentRun = this.store.get<AgentRunRow>(
          "SELECT * FROM agent_runs WHERE id=?",
          runId,
        )!;
        this.updateRun(runId, { usedRetries: currentRun.usedRetries + 1 });
      }

      const card: AgentInspectionCard = {
        id: randomUUID(),
        type: "inspection",
        runId,
        passed,
        summary,
        checks,
        bestAssetIds: bestAssetIds.length ? bestAssetIds : validIds.slice(0, 1),
        suggestedFix,
        inspectedAssetIds: validIds,
      };
      cards.push(card);
      this.updateMessage(messageId, { cards });
      this.emit(sessionId, "card", { messageId, card });

      return {
        card,
        toolResult: {
          passed: card.passed,
          summary: card.summary,
          checks: card.checks,
          bestAssetIds: card.bestAssetIds,
          suggestedFix: card.suggestedFix || "",
        },
      };
    } catch (error) {
      if (signal.aborted) throw error;
      const unsupported = error instanceof VisionUnsupportedError;
      const warning = unsupported
        ? `该模型无法理解图片（${config.textModel}），已跳过自动视觉质检`
        : `自动视觉质检失败：${error instanceof Error ? error.message : "上游服务异常"}`;
      this.emit(sessionId, "warning", { runId, warning });
      const card: AgentInspectionCard = {
        id: randomUUID(),
        type: "inspection",
        runId,
        passed: true,
        degraded: true,
        summary:
          unsupported
            ? "该模型无法理解图片，已跳过自动视觉质检；请切换支持视觉输入的对话模型，或直接预览上方成图。"
            : "自动视觉质检暂时失败，已跳过；请直接预览上方成图。",
        checks: [],
        bestAssetIds: validIds,
        inspectedAssetIds: validIds,
      };
      cards.push(card);
      this.updateMessage(messageId, { cards });
      this.emit(sessionId, "card", { messageId, card });
      return {
        card,
        toolResult: {
          passed: true,
          degraded: true,
          note: warning,
        },
      };
    }
  }

  private async runAgentLoop(
    sessionId: string,
    runId: string,
    identity: Owner,
    config: AgentSessionConfig,
    initialLlmMessages: ChatMessage[],
    startStep = 0,
    existingAssistantMessageId?: string,
  ): Promise<void> {
    const controller = new AbortController();
    const runRow = this.store.get<AgentRunRow>(
      "SELECT * FROM agent_runs WHERE id=?",
      runId,
    );
    if (!runRow) return;
    const handle: ActiveRunHandle = {
      runId,
      controller,
      jobIds: new Set(parseJsonSafe<string[]>(runRow.jobIds, [])),
    };
    this.activeRuns.set(sessionId, handle);

    try {
      const provider = this.providers.usable(config.textProviderId, identity);
      const llmMessages = [...initialLlmMessages];
      const latestUser = this.store.get<AgentMessageRow>(
        "SELECT * FROM agent_messages WHERE sessionId=? AND owner=? AND role='user' ORDER BY createdAt DESC, rowid DESC LIMIT 1",
        sessionId, identity.id,
      );
      const latestUserHasImages = Boolean(latestUser && (
        parseJsonSafe<string[]>(latestUser.attachments, []).length
        || this.getDocuments(parseJsonSafe<string[]>(latestUser.documents, []), identity.id)
          .some((doc) => parseJsonSafe<string[]>(doc.images, []).length > 0)
      ));

      let assistantMessageId = existingAssistantMessageId;
      let assistantContent = "";
      let assistantReasoning = "";
      let assistantCards: AgentCard[] = [];

      if (assistantMessageId) {
        const existing = this.store.get<AgentMessageRow>(
          "SELECT * FROM agent_messages WHERE id=?",
          assistantMessageId,
        );
        if (existing) {
          assistantContent = existing.content;
          assistantReasoning = existing.reasoning;
          assistantCards = parseJsonSafe<AgentCard[]>(existing.cards, []);
        }
      } else {
        const created = this.insertMessage(sessionId, identity.id, "assistant", "");
        assistantMessageId = created.id;
        this.emit(sessionId, "message", this.formatMessage(created, identity));
      }

      for (let step = startStep; step < MAX_AGENT_STEPS; step++) {
        if (controller.signal.aborted) break;

        // Refresh system prompt remaining budget dynamically before each model turn
        const latestRun = this.store.get<AgentRunRow>(
          "SELECT * FROM agent_runs WHERE id=?",
          runId,
        )!;
        const remainingImages = Math.max(
          0,
          latestRun.budgetImages - latestRun.usedImages,
        );
        const remainingRetries = Math.max(
          0,
          latestRun.maxRetries - latestRun.usedRetries,
        );
        if (llmMessages[0]?.role === "system") {
          llmMessages[0] = {
            role: "system",
            content: buildSystemPrompt(
              config,
              remainingImages,
              remainingRetries,
              this.listAvailableImageModels(identity),
            ),
          };
        }

        const stepContentPrefix = assistantContent
          ? assistantContent + "\n\n"
          : "";
        let stepText = "";

        const completion = await this.callChatCompletion(
          provider,
          config,
          llmMessages,
          {
            tools: AGENT_TOOLS,
            stream: true,
            signal: controller.signal,
            requireVision: latestUserHasImages,
            onReasoningDelta: (delta) => {
              assistantReasoning += delta;
              this.emit(sessionId, "reasoning_delta", {
                messageId: assistantMessageId,
                delta,
              });
            },
            onTextDelta: (delta) => {
              stepText += delta;
              assistantContent = stepContentPrefix + stepText;
              this.emit(sessionId, "delta", {
                messageId: assistantMessageId,
                delta: stepText === delta && stepContentPrefix ? "\n\n" + delta : delta,
              });
            },
          },
        );

        assistantContent = stepText
          ? stepContentPrefix + stepText
          : assistantContent;
        this.updateMessage(assistantMessageId, {
          content: assistantContent,
          reasoning: assistantReasoning,
          cards: assistantCards,
        });

        if (!completion.toolCalls.length) {
          this.updateRun(runId, {
            status: "completed",
            pendingPlan: null,
            finishedAt: new Date().toISOString(),
          });
          this.emit(sessionId, "done", { runId, status: "completed" });
          return;
        }

        const assistantToolMsg: ChatMessage = {
          role: "assistant",
          content: completion.content || null,
          tool_calls: completion.toolCalls,
        };
        llmMessages.push(assistantToolMsg);

        for (const tc of completion.toolCalls) {
          if (controller.signal.aborted) break;
          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = object(JSON.parse(tc.function.arguments || "{}"));
          } catch {
            parsedArgs = {};
          }

          if (tc.function.name === "run_image_batch") {
            const curRun = this.store.get<AgentRunRow>(
              "SELECT * FROM agent_runs WHERE id=?",
              runId,
            )!;
            const remImages = Math.max(0, curRun.budgetImages - curRun.usedImages);
            if (remImages <= 0) {
              llmMessages.push({
                role: "tool",
                tool_call_id: tc.id,
                name: tc.function.name,
                content: JSON.stringify({
                  error: "budget_exhausted",
                  message: `已达到本轮生图预算上限（${curRun.budgetImages} 张），请停止继续生图并向用户汇总现有成果。`,
                }),
              });
              continue;
            }

            let sanitizedItems: AgentPlanItem[];
            try {
              sanitizedItems = this.sanitizePlanItems(
                parsedArgs.items,
                config,
                identity,
                remImages,
              );
            } catch (err) {
              llmMessages.push({
                role: "tool",
                tool_call_id: tc.id,
                name: tc.function.name,
                content: JSON.stringify({
                  error: "invalid_plan",
                  message: (err as Error).message,
                }),
              });
              continue;
            }

            const summary =
              typeof parsedArgs.summary === "string" && parsedArgs.summary.trim()
                ? parsedArgs.summary.trim()
                : `共 ${sanitizedItems.length} 组生图方案`;
            const totalImages = sanitizedItems.reduce((s, it) => s + it.count, 0);

            if (config.approvalMode === "confirm") {
              const planCard: AgentPlanCard = {
                id: randomUUID(),
                type: "plan",
                runId,
                status: "pending",
                summary,
                items: sanitizedItems,
                totalImages,
              };
              assistantCards.push(planCard);
              this.updateMessage(assistantMessageId, {
                content: assistantContent,
                reasoning: assistantReasoning,
                cards: assistantCards,
              });
              this.emit(sessionId, "card", {
                messageId: assistantMessageId,
                card: planCard,
              });

              const pendingPayload: PendingPlanPayload = {
                cardId: planCard.id,
                messageId: assistantMessageId,
                toolCallId: tc.id,
                summary,
                items: sanitizedItems,
                llmMessages: llmMessages.slice(0, -1),
                assistantToolCallMessage: assistantToolMsg,
                step,
              };
              this.updateRun(runId, {
                status: "waiting_approval",
                pendingPlan: pendingPayload,
              });
              return;
            }

            // Auto mode: execute immediately
            const { toolResult } = await this.executeBatchAndWait(
              sessionId,
              runId,
              assistantMessageId,
              assistantCards,
              summary,
              sanitizedItems,
              config,
              identity,
              handle,
            );
            llmMessages.push({
              role: "tool",
              tool_call_id: tc.id,
              name: tc.function.name,
              content: JSON.stringify(toolResult),
            });
          } else if (tc.function.name === "inspect_images") {
            const assetIds = Array.isArray(parsedArgs.assetIds)
              ? parsedArgs.assetIds.filter((x): x is string => typeof x === "string")
              : [];
            const criteria = Array.isArray(parsedArgs.criteria)
              ? parsedArgs.criteria.filter((x): x is string => typeof x === "string")
              : [];
            const goal =
              typeof parsedArgs.goal === "string" ? parsedArgs.goal : undefined;
            const { toolResult } = await this.runVisualInspection(
              sessionId,
              runId,
              assistantMessageId,
              assistantCards,
              provider,
              config,
              identity,
              { assetIds, criteria, goal },
              controller.signal,
            );
            llmMessages.push({
              role: "tool",
              tool_call_id: tc.id,
              name: tc.function.name,
              content: JSON.stringify(toolResult),
            });
          } else if (tc.function.name === "select_deliverables") {
            const rawIds = Array.isArray(parsedArgs.assetIds)
              ? parsedArgs.assetIds.filter((x): x is string => typeof x === "string")
              : [];
            const validIds: string[] = [];
            for (const id of rawIds) {
              if (validIds.includes(id)) continue;
              try {
                this.assets.owned(id, identity.id);
                validIds.push(id);
              } catch {
                /* ignore */
              }
            }
            if (validIds.length) {
              const delivCard: AgentDeliverablesCard = {
                id: randomUUID(),
                type: "deliverables",
                title:
                  typeof parsedArgs.title === "string" && parsedArgs.title.trim()
                    ? parsedArgs.title.trim()
                    : "精选成品",
                summary:
                  typeof parsedArgs.summary === "string"
                    ? parsedArgs.summary.trim()
                    : "",
                assetIds: validIds,
                jobIds: Array.from(handle.jobIds),
              };
              assistantCards.push(delivCard);
              this.updateMessage(assistantMessageId, { cards: assistantCards });
              this.emit(sessionId, "card", {
                messageId: assistantMessageId,
                card: delivCard,
              });
            }
            llmMessages.push({
              role: "tool",
              tool_call_id: tc.id,
              name: tc.function.name,
              content: JSON.stringify({
                ok: true,
                selectedCount: validIds.length,
                assetIds: validIds,
              }),
            });
          } else {
            llmMessages.push({
              role: "tool",
              tool_call_id: tc.id,
              name: tc.function.name,
              content: JSON.stringify({ error: "unknown_tool" }),
            });
          }
        }
      }

      if (controller.signal.aborted) {
        this.updateRun(runId, {
          status: "cancelled",
          pendingPlan: null,
          finishedAt: new Date().toISOString(),
        });
        this.emit(sessionId, "done", { runId, status: "cancelled" });
      } else {
        this.updateRun(runId, {
          status: "completed",
          pendingPlan: null,
          finishedAt: new Date().toISOString(),
        });
        this.emit(sessionId, "done", { runId, status: "completed" });
      }
    } catch (error) {
      if (controller.signal.aborted) {
        this.updateRun(runId, {
          status: "cancelled",
          pendingPlan: null,
          finishedAt: new Date().toISOString(),
        });
        this.emit(sessionId, "done", { runId, status: "cancelled" });
      } else {
        const message =
          error instanceof HttpError
            ? error.message
            : error instanceof Error
              ? error.message
              : "Agent 执行失败";
        this.updateRun(runId, {
          status: "failed",
          pendingPlan: null,
          error: message,
          finishedAt: new Date().toISOString(),
        });
        this.emit(sessionId, "error", { runId, error: message });
      }
    } finally {
      if (this.activeRuns.get(sessionId)?.runId === runId) {
        this.activeRuns.delete(sessionId);
      }
    }
  }

  private async resumeApprovedPlan(
    sessionId: string,
    runId: string,
    identity: Owner,
    config: AgentSessionConfig,
    pending: PendingPlanPayload,
    approved: boolean,
    itemsToRun: AgentPlanItem[],
    feedback?: string,
  ): Promise<void> {
    const controller = new AbortController();
    const runRow = this.store.get<AgentRunRow>(
      "SELECT * FROM agent_runs WHERE id=?",
      runId,
    );
    if (!runRow) return;
    const handle: ActiveRunHandle = {
      runId,
      controller,
      jobIds: new Set(parseJsonSafe<string[]>(runRow.jobIds, [])),
    };
    this.activeRuns.set(sessionId, handle);

    const llmMessages: ChatMessage[] = [
      ...pending.llmMessages,
      pending.assistantToolCallMessage,
    ];

    try {
      const msgRow = this.store.get<AgentMessageRow>(
        "SELECT * FROM agent_messages WHERE id=?",
        pending.messageId,
      );
      const cards = msgRow ? parseJsonSafe<AgentCard[]>(msgRow.cards, []) : [];
      const planCard = cards.find(
        (c): c is AgentPlanCard => c.type === "plan" && c.id === pending.cardId,
      );

      if (planCard) {
        planCard.status = approved ? "approved" : "rejected";
        planCard.items = itemsToRun;
        planCard.totalImages = itemsToRun.reduce((s, it) => s + it.count, 0);
        this.updateMessage(pending.messageId, { cards });
        this.emit(sessionId, "card", { messageId: pending.messageId, card: planCard });
      }

      if (approved) {
        const { toolResult } = await this.executeBatchAndWait(
          sessionId,
          runId,
          pending.messageId,
          cards,
          pending.summary,
          itemsToRun,
          config,
          identity,
          handle,
        );
        llmMessages.push({
          role: "tool",
          tool_call_id: pending.toolCallId,
          name: "run_image_batch",
          content: JSON.stringify(toolResult),
        });
      } else {
        llmMessages.push({
          role: "tool",
          tool_call_id: pending.toolCallId,
          name: "run_image_batch",
          content: JSON.stringify({
            rejected: true,
            feedback:
              feedback?.trim() || "用户取消了本次执行计划，请询问需要如何调整方案。",
          }),
        });
      }
    } catch (error) {
      if (controller.signal.aborted) {
        this.updateRun(runId, {
          status: "cancelled",
          pendingPlan: null,
          finishedAt: new Date().toISOString(),
        });
        this.emit(sessionId, "done", { runId, status: "cancelled" });
      } else {
        const message =
          error instanceof Error ? error.message : "执行生图计划失败";
        this.updateRun(runId, {
          status: "failed",
          pendingPlan: null,
          error: message,
          finishedAt: new Date().toISOString(),
        });
        this.emit(sessionId, "error", { runId, error: message });
      }
      if (this.activeRuns.get(sessionId)?.runId === runId) {
        this.activeRuns.delete(sessionId);
      }
      return;
    }

    if (controller.signal.aborted) {
      this.updateRun(runId, {
        status: "cancelled",
        pendingPlan: null,
        finishedAt: new Date().toISOString(),
      });
      this.emit(sessionId, "done", { runId, status: "cancelled" });
      if (this.activeRuns.get(sessionId)?.runId === runId) {
        this.activeRuns.delete(sessionId);
      }
      return;
    }

    // Continue the agent loop (e.g., visual inspection, summary, deliverables)
    await this.runAgentLoop(
      sessionId,
      runId,
      identity,
      config,
      llmMessages,
      pending.step + 1,
      pending.messageId,
    );
  }

  private stopSessionRun(sessionId: string, identity: Owner): boolean {
    const handle = this.activeRuns.get(sessionId);
    let stopped = false;

    if (handle) {
      handle.controller.abort();
      for (const jobId of handle.jobIds) {
        try {
          this.queue.cancelQueued(jobId, identity);
        } catch {
          /* ignore */
        }
      }
      stopped = true;
    }

    const activeRow = this.store.get<AgentRunRow>(
      "SELECT * FROM agent_runs WHERE sessionId=? AND status IN ('running','waiting_approval') ORDER BY startedAt DESC LIMIT 1",
      sessionId,
    );
    if (activeRow) {
      const pending = parseJsonSafe<PendingPlanPayload | null>(
        activeRow.pendingPlan,
        null,
      );
      if (pending) {
        const msgRow = this.store.get<AgentMessageRow>(
          "SELECT * FROM agent_messages WHERE id=?",
          pending.messageId,
        );
        if (msgRow) {
          const cards = parseJsonSafe<AgentCard[]>(msgRow.cards, []);
          const planCard = cards.find(
            (c): c is AgentPlanCard => c.type === "plan" && c.id === pending.cardId,
          );
          if (planCard && planCard.status === "pending") {
            planCard.status = "rejected";
            this.updateMessage(pending.messageId, { cards });
            this.emit(sessionId, "card", {
              messageId: pending.messageId,
              card: planCard,
            });
          }
        }
      }
      const jobIds = parseJsonSafe<string[]>(activeRow.jobIds, []);
      for (const jobId of jobIds) {
        try {
          this.queue.cancelQueued(jobId, identity);
        } catch {
          /* ignore */
        }
      }
      this.updateRun(activeRow.id, {
        status: "cancelled",
        pendingPlan: null,
        finishedAt: new Date().toISOString(),
      });
      this.emit(sessionId, "done", { runId: activeRow.id, status: "cancelled" });
      stopped = true;
    }
    return stopped;
  }

  mount(app: Express): void {
    app.post("/api/agent/documents", async (request, response) => {
      const identity = user(request);
      const input = body(request);
      if (typeof input.name !== "string" || !input.name.trim() || !/\.docx$/i.test(input.name.trim())) {
        throw fail(400, "仅支持 Word (.docx) 文档");
      }
      const name = input.name.trim().split(/[\\/]/).pop()!;
      if (typeof input.data !== "string" || !input.data.length) throw fail(400, "无效的 Word (.docx) 文档");
      if (input.data.length > Math.ceil(MAX_DOCX_BYTES / 3) * 4) throw fail(400, "文档大小不能超过 20MB");
      if (input.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) {
        throw fail(400, "无效的 Word (.docx) 文档");
      }
      const bytes = Buffer.from(input.data, "base64");
      if (bytes.length > MAX_DOCX_BYTES) throw fail(400, "文档大小不能超过 20MB");
      if (bytes.toString("base64") !== input.data) throw fail(400, "无效的 Word (.docx) 文档");
      const parsed = await parseDocxDocument(bytes, (raw, mime) => this.assets.save(identity.id, raw, mime));
      const id = randomUUID();
      this.store.run(
        "INSERT INTO agent_documents(id,owner,name,mime,size,text,charCount,images,skippedImages,truncated,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        id, identity.id, name, "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        bytes.length, parsed.text, parsed.charCount, JSON.stringify(parsed.images), parsed.skippedImages,
        Number(parsed.truncated), new Date().toISOString(),
      );
      response.json({ id, name, size: bytes.length, charCount: parsed.charCount, images: parsed.images,
        skippedImages: parsed.skippedImages, truncated: parsed.truncated, excerpt: parsed.excerpt } satisfies AgentDocumentRef);
    });

    // List sessions
    app.get("/api/agent/sessions", (request, response) => {
      const identity = user(request);
      const rows = this.store.all<AgentSessionRow>(
        "SELECT * FROM agent_sessions WHERE owner=? ORDER BY updatedAt DESC, id DESC LIMIT 100",
        identity.id,
      );
      response.json(rows.map((row) => this.formatSession(row)));
    });

    // Create session
    app.post("/api/agent/sessions", (request, response) => {
      const identity = user(request);
      const input = body(request);
      const title =
        typeof input.title === "string" && input.title.trim()
          ? input.title.trim().slice(0, 80)
          : "新创作对话";
      const config = normalizeConfig(input.config);
      const now = new Date().toISOString();
      const id = randomUUID();
      this.store.run(
        "INSERT INTO agent_sessions(id,owner,title,config,createdAt,updatedAt) VALUES(?,?,?,?,?,?)",
        id,
        identity.id,
        title,
        JSON.stringify(config),
        now,
        now,
      );
      const created = this.ownSession(id, identity);
      response.json(this.formatSession(created));
    });

    // Get session detail
    app.get("/api/agent/sessions/:id", (request, response) => {
      const identity = user(request);
      response.json(this.getSessionDetail(param(request), identity));
    });

    // Update session title/config
    app.patch("/api/agent/sessions/:id", (request, response) => {
      const identity = user(request);
      const session = this.ownSession(param(request), identity);
      const input = body(request);
      const title =
        typeof input.title === "string" && input.title.trim()
          ? input.title.trim().slice(0, 80)
          : session.title;
      const existingConfig = normalizeConfig(parseJsonSafe(session.config, {}));
      const config = input.config
        ? normalizeConfig(input.config, existingConfig)
        : existingConfig;
      const updatedAt = new Date().toISOString();
      this.store.run(
        "UPDATE agent_sessions SET title=?, config=?, updatedAt=? WHERE id=?",
        title,
        JSON.stringify(config),
        updatedAt,
        session.id,
      );
      response.json(this.formatSession(this.ownSession(session.id, identity)));
    });

    // Delete session (preserves generated images in Studio history)
    app.delete("/api/agent/sessions/:id", (request, response) => {
      const identity = user(request);
      const session = this.ownSession(param(request), identity);
      this.stopSessionRun(session.id, identity);
      this.store.run("DELETE FROM agent_sessions WHERE id=?", session.id);
      response.json({ ok: true });
    });

    // SSE stream for a session
    app.get("/api/agent/sessions/:id/events", (request, response) => {
      const identity = user(request);
      const session = this.ownSession(param(request), identity);

      response.status(200);
      response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      response.setHeader("Cache-Control", "no-cache, no-transform");
      response.setHeader("Connection", "keep-alive");
      response.setHeader("X-Accel-Buffering", "no");
      response.flushHeaders?.();

      let set = this.subscribers.get(session.id);
      if (!set) {
        set = new Set();
        this.subscribers.set(session.id, set);
      }
      set.add(response);

      const snapshot = this.getSessionDetail(session.id, identity);
      response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);

      request.on("close", () => {
        const current = this.subscribers.get(session.id);
        if (current) {
          current.delete(response);
          if (!current.size) this.subscribers.delete(session.id);
        }
      });
    });

    // Send user message and trigger Agent run
    app.post("/api/agent/sessions/:id/messages", async (request, response) => {
      const identity = user(request);
      const session = this.ownSession(param(request), identity);
      const input = body(request);

      const content =
        typeof input.content === "string" ? input.content.trim() : "";
      const attachments = Array.isArray(input.attachments)
        ? input.attachments.filter((x): x is string => typeof x === "string")
        : [];
      if (input.documents !== undefined && (!Array.isArray(input.documents)
        || input.documents.some((id) => typeof id !== "string"))) throw fail(400, "文档参数无效");
      const documents = (input.documents ?? []) as string[];
      if (documents.length > MAX_AGENT_DOCUMENTS) throw fail(400, `最多附带 ${MAX_AGENT_DOCUMENTS} 份文档`);
      const documentRows = this.getDocuments(documents, identity.id);
      if (documentRows.length !== documents.length) throw fail(404, "文档不存在");
      if (!content && !attachments.length && !documents.length) {
        throw fail(400, "请输入想法或附带参考图片、Word 文档");
      }
      if (content.length > 16000) {
        throw fail(400, "输入内容过长");
      }
      if (attachments.length > MAX_REFERENCE_IMAGES) {
        throw fail(400, `最多附带 ${MAX_REFERENCE_IMAGES} 张图片`);
      }
      for (const assetId of attachments) {
        this.assets.owned(assetId, identity.id);
      }

      const existingRun = this.store.get<AgentRunRow>(
        "SELECT * FROM agent_runs WHERE sessionId=? AND status IN ('running','waiting_approval') ORDER BY startedAt DESC LIMIT 1",
        session.id,
      );
      if (existingRun && existingRun.status === "running") {
        throw fail(409, "当前对话正在执行中，请等待完成或先点击停止");
      }
      // If there was a stale waiting_approval plan and user sends a new message instead, supersede it cleanly.
      if (existingRun && existingRun.status === "waiting_approval") {
        const pending = parseJsonSafe<PendingPlanPayload | null>(
          existingRun.pendingPlan,
          null,
        );
        if (pending) {
          const msgRow = this.store.get<AgentMessageRow>(
            "SELECT * FROM agent_messages WHERE id=?",
            pending.messageId,
          );
          if (msgRow) {
            const cards = parseJsonSafe<AgentCard[]>(msgRow.cards, []);
            const planCard = cards.find(
              (c): c is AgentPlanCard =>
                c.type === "plan" && c.id === pending.cardId,
            );
            if (planCard && planCard.status === "pending") {
              planCard.status = "superseded";
              this.updateMessage(pending.messageId, { cards });
              this.emit(session.id, "card", {
                messageId: pending.messageId,
                card: planCard,
              });
            }
          }
        }
        this.updateRun(existingRun.id, {
          status: "cancelled",
          pendingPlan: null,
          finishedAt: new Date().toISOString(),
        });
      }

      const existingConfig = normalizeConfig(parseJsonSafe(session.config, {}));
      const config = input.config
        ? normalizeConfig(input.config, existingConfig)
        : existingConfig;

      if (!config.textProviderId || !config.textModel) {
        throw fail(400, "请先在顶部选择一个对话文本模型");
      }
      // Validate text provider usability upfront before saving & spawning run
      this.providers.usable(config.textProviderId, identity);

      const isFirstMessage = !this.store.get(
        "SELECT 1 FROM agent_messages WHERE sessionId=? LIMIT 1",
        session.id,
      );
      const nextTitle =
        isFirstMessage && session.title === "新创作对话"
          ? deriveSessionTitle(content || documentRows[0]?.name || "参考图创作")
          : session.title;
      const now = new Date().toISOString();
      this.store.run(
        "UPDATE agent_sessions SET title=?, config=?, updatedAt=? WHERE id=?",
        nextTitle,
        JSON.stringify(config),
        now,
        session.id,
      );

      const userMsgRow = this.insertMessage(
        session.id,
        identity.id,
        "user",
        content,
        attachments,
        [],
        "",
        documents,
      );
      const userMsg = this.formatMessage(userMsgRow, identity);
      this.emit(session.id, "message", userMsg);

      const runId = randomUUID();
      this.store.run(
        "INSERT INTO agent_runs(id,sessionId,owner,status,budgetImages,usedImages,maxRetries,usedRetries,pendingPlan,jobIds,error,startedAt,finishedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        runId,
        session.id,
        identity.id,
        "running",
        config.budgetImages,
        0,
        config.maxRetries,
        0,
        null,
        "[]",
        null,
        now,
        null,
      );
      const runRow = this.store.get<AgentRunRow>(
        "SELECT * FROM agent_runs WHERE id=?",
        runId,
      )!;
      const formattedRun = this.formatRun(runRow);
      this.emit(session.id, "run", formattedRun);

      const llmMessages = await this.buildConversationHistory(
        session.id,
        identity,
        config,
        config.budgetImages,
        config.maxRetries,
      );

      // Kick off background async loop
      void this.runAgentLoop(session.id, runId, identity, config, llmMessages).catch(
        (error) => {
          console.error("[agent] Unhandled runAgentLoop error:", error);
        },
      );

      response.json({
        session: this.formatSession(this.ownSession(session.id, identity)),
        message: userMsg,
        run: formattedRun,
      });
    });

    // Approve or reject pending batch plan
    app.post("/api/agent/sessions/:id/approve", (request, response) => {
      const identity = user(request);
      const session = this.ownSession(param(request), identity);
      const input = body(request);

      const runRow = this.store.get<AgentRunRow>(
        "SELECT * FROM agent_runs WHERE sessionId=? AND status='waiting_approval' ORDER BY startedAt DESC LIMIT 1",
        session.id,
      );
      if (!runRow || !runRow.pendingPlan) {
        throw fail(409, "当前没有待确认的生图计划");
      }
      if (typeof input.runId === "string" && input.runId !== runRow.id) {
        throw fail(409, "该计划已过期");
      }
      const pending = parseJsonSafe<PendingPlanPayload | null>(
        runRow.pendingPlan,
        null,
      );
      if (!pending) {
        throw fail(409, "计划数据无效");
      }
      if (typeof input.approved !== "boolean") {
        throw fail(400, "approved 必须是布尔值");
      }
      const approved = input.approved;
      if (input.items !== undefined && !Array.isArray(input.items)) {
        throw fail(400, "items 必须是数组");
      }
      const editedItems = Array.isArray(input.items)
        ? (input.items as unknown[])
        : undefined;
      const feedback =
        typeof input.feedback === "string" ? input.feedback : undefined;

      const config = normalizeConfig(parseJsonSafe(session.config, {}));
      const remainingImages = Math.max(0, runRow.budgetImages - runRow.usedImages);
      let itemsToRun: AgentPlanItem[];
      if (approved) {
        itemsToRun = this.sanitizePlanItems(
          editedItems !== undefined ? editedItems : pending.items,
          config,
          identity,
          remainingImages,
          true,
        );
        const checkedProviders = new Set<string>();
        for (const item of itemsToRun) {
          if (!item.providerId || !item.model) {
            throw fail(400, "请先在顶部选择生图模型后再批准生成");
          }
          if (!checkedProviders.has(item.providerId)) {
            this.providers.usable(item.providerId, identity);
            checkedProviders.add(item.providerId);
          }
        }
      } else {
        itemsToRun = pending.items;
      }

      const claimed = this.store.db
        .prepare(
          "UPDATE agent_runs SET status='running', pendingPlan=NULL, error=NULL WHERE id=? AND status='waiting_approval'",
        )
        .run(runRow.id);
      if (!Number(claimed.changes)) {
        throw fail(409, "当前没有待确认的生图计划");
      }
      const updatedRun = this.store.get<AgentRunRow>(
        "SELECT * FROM agent_runs WHERE id=?",
        runRow.id,
      );
      if (updatedRun) {
        this.emit(session.id, "run", this.formatRun(updatedRun));
      }

      void this.resumeApprovedPlan(
        session.id,
        runRow.id,
        identity,
        config,
        pending,
        approved,
        itemsToRun,
        feedback,
      ).catch((error) => {
        console.error("[agent] Unhandled resumeApprovedPlan error:", error);
      });

      response.json({ ok: true, runId: runRow.id, approved });
    });

    // Stop active run
    app.post("/api/agent/sessions/:id/stop", (request, response) => {
      const identity = user(request);
      const session = this.ownSession(param(request), identity);
      const stopped = this.stopSessionRun(session.id, identity);
      response.json({ ok: true, stopped });
    });
  }
}
