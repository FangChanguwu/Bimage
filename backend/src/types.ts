export interface IdentityBase {
  id: string;
  name: string;
  role: "admin" | "user";
}
export interface Account extends IdentityBase {
  email: string;
  concurrency: number;
}
export interface AccountRow extends Account {
  passwordHash: string;
}
export interface Identity extends Account {
  csrf: string;
}
export interface SessionRow {
  hash: string;
  owner: string;
  csrf: string;
  expires: number;
}
export interface ProviderRow {
  id: string;
  owner: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  kind: string;

  models: string;
  shared: number;
}
export type TaskStatus =
  "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
export interface JobRow {
  id: string;
  owner: string;
  form: string;
  status: TaskStatus;
  created: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface TaskRow {
  id: string;
  job: string;
  status: TaskStatus;
  attempts: number;
  next: number;
  asset: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface AssetRow {
  id: string;
  owner: string;
  mime: string;
  bytes: Uint8Array;
  width: number | null;
  height: number | null;
}
export interface ImageForm {
  providerId: string;
  model: string;
  prompt: string;
  count: number;
  size?: string;
  autoSize?: boolean;
  quality: string;
  output_format: string;
  references: string[];
  mask?: string;
  [key: string]: unknown;
}
export interface FavoriteRow {
  id: string;
  owner: string;
  asset: string;
  jobId: string;
  taskId: string;
  form: string;
  jobCreated: string;
  createdAt: string;
}
export interface Model {
  id: string;
  types: string[];
  reason: string;
}
export interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  kind: string;

}
export interface AppOptions {
  dir?: string;
  worker?: boolean;
  concurrency?: number;
  retryMs?: number;
  frontendDir?: string;
  onRestart?: () => void;
}
