export type Setter<T> = (next: T | ((previous: T) => T)) => void;
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
  apiKey?: string;
  kind?: string;
  models: Model[];
  allowPrivate?: boolean;
  shared?: boolean;
  canManage?: boolean;
  hasKey?: boolean;
  role?: string;
}
export interface ProviderDraft {
  id?: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  kind?: string;
  allowPrivate: boolean;
  shared?: boolean;
  role?: string;
  models: Model[];
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
  aspect_ratio?: string;
  manualSize?: { size: string; ratio: string; resolution?: string };
}
export interface Settings {
  imageProvider?: string;
  imageModel?: string;
  textProvider?: string;
  textModel?: string;
  form?: GenerationForm;
}
export interface Identity {
  id: string;
  name: string;
  role: string;
  csrf: string;
  disabled?: boolean;
  expires?: string | null;
}
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
export interface Option {
  value: string;
  label: string;
  title?: string;
}
export interface Point {
  x: number;
  y: number;
}
export type Tool = "pen" | "rect" | "ellipse" | "arrow";
export interface Shape {
  tool: Tool;
  color: string;
  width: number;
  points: Point[];
}
