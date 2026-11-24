export interface Model {
  id: string;
  types: string[];
  reason?: string;
}
export interface Provider {
  id: string;
  owner?: string;
  name: string;
  baseUrl?: string;
  models: Model[];
  shared?: boolean;
  canManage?: boolean;
  hasKey?: boolean;
}
export interface ProviderDraft {
  id?: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: Model[];
  shared: boolean;
  kind: "mixed";
}
export interface GenerationForm {
  providerId: string;
  model: string;
  prompt: string;
  count: number;
  size: string;
  autoSize: boolean;
  resolution?: string;
  ratio: string;
  quality: string;
  output_format: string;
  references: string[];
  mask?: string;
  aspect_ratio?: string;
  manualSize?: { size: string; ratio: string; resolution?: string };
  source?: "studio" | "agent";
  agentSessionId?: string;
}
export type ThinkingEffort = "low" | "medium" | "high";
export type SpeedTier = "normal" | "priority";
export type ApprovalMode = "confirm" | "auto";
export interface Settings {
  imageProvider?: string;
  imageModel?: string;
  textProvider?: string;
  textModel?: string;
  quickProvider?: string;
  quickModel?: string;
  agentProvider?: string;
  agentModel?: string;
  agentThinkingEffort?: ThinkingEffort;
  agentSpeed?: SpeedTier;
  agentApprovalMode?: ApprovalMode;
  agentAutoInspect?: boolean;
  agentBudgetImages?: number;
  agentMaxRetries?: number;
  form?: GenerationForm;
}
export interface Identity {
  id: string;
  name: string;
  role: string;
  csrf: string;
  email?: string;
  concurrency?: number;
}
export type AccountRole = "admin" | "user";
export interface Account {
  id: string;
  email: string;
  name: string;
  role: AccountRole;
  concurrency: number;
}
export interface AccountDirectory { users: Account[] }
export interface Site {
  title: string;
  icon?: string;
}
export interface Task {
  id: string;
  asset?: string;
  mime?: string;
  width?: number;
  height?: number;
  status: string;
  error?: string;
  attempts?: number;
}
export interface Job {
  id: string;
  tasks: Task[];
  form: GenerationForm;
  status: string;
  created: string;
  startedAt?: string;
  finishedAt?: string;
}
export interface FavoriteItem {
  id: string;
  asset: string;
  mime?: string;
  width?: number | null;
  height?: number | null;
  jobId: string;
  taskId: string;
  form: GenerationForm;
  jobCreated: string;
  createdAt: string;
}
export type Api = <T = unknown>(
  path: string,
  body?: unknown,
  method?: string,
  signal?: AbortSignal,
) => Promise<T>;
export type Run = <T>(
  action: () => Promise<T>,
  success?: string,
) => Promise<T | undefined>;
export interface Point {
  x: number;
  y: number;
}
export type Tool = "pen" | "rect" | "ellipse" | "arrow";
export type RepairMode = "mask" | "annotation";
export type MaskTool = "brush" | "eraser" | "rect" | "ellipse";
export interface RepairResult {
  mode: RepairMode;
  imageId: string;
  maskId?: string;
  prompt: string;
}
export interface Shape {
  tool: Tool;
  color: string;
  width: number;
  points: Point[];
}
export interface Choice {
  providerId: string;
  model: string;
}
export interface ReleaseInfo {
  tag: string;
  version: string;
  name: string;
  url: string;
  publishedAt: string;
  body: string;
  prerelease: boolean;
  hasBundle?: boolean;
  bundleSize?: number;
  canInstall?: boolean;
  cached?: boolean;
}
export interface GitInfo {
  available: boolean;
  commit?: string;
  branch?: string;
  dirty?: boolean;
}
export interface UpdateCapabilities {
  canSelfUpdate: boolean;
  mode: "bundle" | "git" | "none";
  managedByLauncher: boolean;
  baseVersion: string;
  hasLocalBackup: boolean;
  backupTag?: string;
  backupVersion?: string;
  activeRuntimeTag?: string;
}
export type UpdatePhase =
  | "idle"
  | "checking"
  | "downloading"
  | "verifying"
  | "extracting"
  | "building"
  | "applying"
  | "restarting"
  | "done"
  | "failed";
export interface UpdateOperationState {
  id: string;
  action: "update" | "rollback" | "restart";
  targetTag?: string;
  phase: UpdatePhase;
  progress: number;
  message: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}
export interface VersionSnapshot {
  current: string;
  repo: string;
  releasesUrl: string;
  checkedAt: string | null;
  latest: ReleaseInfo | null;
  hasUpdate: boolean;
  releases: ReleaseInfo[];
  git: GitInfo;
  capabilities: UpdateCapabilities;
  operation: UpdateOperationState | null;
}
export interface VersionActionResult {
  ok: boolean;
  tag: string;
  operation: UpdateOperationState;
  message: string;
}
export interface VersionStatusResult {
  current: string;
  operation: UpdateOperationState | null;
}
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
export interface AgentSession {
  id: string;
  title: string;
  config: AgentSessionConfig;
  createdAt: string;
  updatedAt: string;
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
  status: Task["status"];
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
  status: Task["status"];
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
export interface AgentMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  reasoning: string;
  attachments: string[];
  documents?: AgentDocumentRef[];
  cards: AgentCard[];
  createdAt: string;
}
export interface AgentRun {
  id: string;
  sessionId: string;
  status: AgentRunStatus;
  budgetImages: number;
  usedImages: number;
  maxRetries: number;
  usedRetries: number;
  pendingPlanCardId: string | null;
  jobIds: string[];
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}
export interface AgentSessionDetail {
  session: AgentSession;
  messages: AgentMessage[];
  run: AgentRun | null;
}
