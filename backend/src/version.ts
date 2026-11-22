import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Express } from "express";
import rateLimit from "express-rate-limit";
import type { Store } from "./db.js";
import { admin, body, fail } from "./http.js";
import type { ClientRateLimitKey } from "./client-rate-limit.js";
import { extractTarGz } from "./tar.js";

const execFileAsync = promisify(execFile);
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TAG_PATTERN = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const CACHE_TTL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const MAX_BUNDLE_BYTES = 100 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const ALLOWED_GITHUB_HOSTS: Record<string, true> = {
  "github.com": true,
  "api.github.com": true,
  "objects.githubusercontent.com": true,
  "release-assets.githubusercontent.com": true,
  "codeload.github.com": true,
};

export interface ReleaseInfo {
  tag: string;
  version: string;
  name: string;
  url: string;
  publishedAt: string;
  body: string;
  prerelease: boolean;
  hasBundle: boolean;
  bundleSize?: number;
  canInstall: boolean;
  cached?: boolean;
}

interface InternalRelease extends ReleaseInfo {
  bundleUrl?: string;
  bundleName?: string;
  checksumUrl?: string;
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
  error?: string;
}

interface SlotRef {
  tag: string;
  version: string;
  dir: string;
}

interface ActiveRuntime {
  current: SlotRef | null;
  previous?: SlotRef | null;
  baseVersion: string;
  updatedAt: string;
}

interface GithubAssetRaw {
  name?: unknown;
  browser_download_url?: unknown;
  size?: unknown;
}

interface GithubReleaseRaw {
  tag_name?: unknown;
  name?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  created_at?: unknown;
  body?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: unknown;
}

export interface VersionMountOptions {
  dataDir?: string;
  onRestart?: () => void;
}

function readPackageJson(dir: string): {
  version?: string;
  dependencies?: Record<string, string>;
} | null {
  try {
    return JSON.parse(
      readFileSync(path.join(dir, "package.json"), "utf8"),
    ) as { version?: string; dependencies?: Record<string, string> };
  } catch {
    return null;
  }
}

export function readCurrentVersion(): string {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: string };
  return pkg.version || "0.0.0";
}

function resolveBaseBackendDir(): string {
  return path.resolve(
    process.env.BIMAGE_BASE_BACKEND_DIR || path.resolve(import.meta.dirname, ".."),
  );
}

function resolveBaseDir(): string {
  return path.resolve(
    process.env.BIMAGE_BASE_DIR || path.resolve(resolveBaseBackendDir(), ".."),
  );
}

function resolveRepo(): string {
  const configured = process.env.BIMAGE_GITHUB_REPO?.trim();
  if (configured && REPO_PATTERN.test(configured)) return configured;
  return "FangChanguwu/Bimage";
}
function resolveApiBase(): string {
  const configured = process.env.BIMAGE_GITHUB_API_BASE?.trim();
  if (configured && /^https?:\/\//i.test(configured)) {
    return configured.replace(/\/+$/, "");
  }
  return "https://api.github.com";
}

function isAllowedDownloadUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  const customBase = process.env.BIMAGE_GITHUB_API_BASE?.trim();
  if (customBase) {
    try {
      const base = new URL(customBase);
      if (parsed.origin === base.origin) return true;
    } catch {
      /* ignore invalid custom base */
    }
  }
  if (parsed.protocol !== "https:") return false;
  return ALLOWED_GITHUB_HOSTS[parsed.hostname.toLowerCase()] === true;
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function parseSemver(input: string): ParsedSemver | null {
  const match =
    /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      input.trim(),
    );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return a.localeCompare(b, undefined, { numeric: true });
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (!pa.prerelease.length && !pb.prerelease.length) return 0;
  if (!pa.prerelease.length) return 1;
  if (!pb.prerelease.length) return -1;
  const len = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i++) {
    const ai = pa.prerelease[i];
    const bi = pb.prerelease[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) {
      const diff = Number(ai) - Number(bi);
      if (diff !== 0) return diff;
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1;
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

function normalizeTag(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

function sameDependencies(
  a?: Record<string, string>,
  b?: Record<string, string>,
): boolean {
  const ka = Object.keys(a ?? {}).sort();
  const kb = Object.keys(b ?? {}).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k, idx) => k === kb[idx] && (a?.[k] ?? "") === (b?.[k] ?? ""));
}

function readActiveRuntime(activeFile: string): ActiveRuntime | null {
  try {
    return JSON.parse(readFileSync(activeFile, "utf8")) as ActiveRuntime;
  } catch {
    return null;
  }
}

function writeActiveRuntime(
  runtimeDir: string,
  activeFile: string,
  active: ActiveRuntime | null,
): void {
  if (!active) {
    try {
      unlinkSync(activeFile);
    } catch {
      /* absent */
    }
    return;
  }
  mkdirSync(runtimeDir, { recursive: true });
  const tmp = `${activeFile}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(active, null, 2) + "\n", "utf8");
  renameSync(tmp, activeFile);
}

function isValidSlotDir(slotDir: string): boolean {
  return (
    existsSync(path.join(slotDir, "backend", "dist", "index.js")) &&
    existsSync(path.join(slotDir, "backend", "package.json")) &&
    existsSync(path.join(slotDir, "frontend", "dist", "index.html"))
  );
}

function sha256File(filePath: string): string {
  if (!existsSync(filePath)) return "";
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

async function runCmd(
  command: string,
  args: string[],
  cwd: string,
  timeout = 15_000,
): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    cwd,
    timeout,
    windowsHide: true,
    shell: process.platform === "win32" && command === "npm",
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

async function fetchWithAllowedRedirects(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Response> {
  let currentUrl = url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isAllowedDownloadUrl(currentUrl)) {
        throw new Error(`下载地址不在受信任域名白名单内: ${currentUrl}`);
      }
      const response = await fetch(currentUrl, {
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
      if (
        response.status === 301 ||
        response.status === 302 ||
        response.status === 303 ||
        response.status === 307 ||
        response.status === 308
      ) {
        const location = response.headers.get("location");
        if (!location) throw new Error("下载重定向缺少目标地址");
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if (!response.ok) {
        throw new Error(`下载失败（HTTP ${response.status}）`);
      }
      return response;
    }
    throw new Error("下载重定向次数过多");
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("下载超时，请检查网络连接后重试");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadBuffer(
  url: string,
  headers: Record<string, string>,
  maxBytes: number,
  onProgress?: (loaded: number, total: number) => void,
): Promise<Buffer> {
  const response = await fetchWithAllowedRedirects(url, headers, DOWNLOAD_TIMEOUT_MS);
  const contentLength = Number(response.headers.get("content-length") || "0");
  if (contentLength > maxBytes) {
    throw new Error("更新包体积超出安全上限");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const arr = Buffer.from(await response.arrayBuffer());
    if (arr.length > maxBytes) throw new Error("更新包体积超出安全上限");
    onProgress?.(arr.length, arr.length);
    return arr;
  }
  const chunks: Buffer[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      loaded += value.byteLength;
      if (loaded > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("更新包体积超出安全上限");
      }
      chunks.push(Buffer.from(value));
      onProgress?.(loaded, contentLength);
    }
  }
  return Buffer.concat(chunks, loaded);
}

function parseChecksumForAsset(checksumsText: string, assetName: string): string | null {
  const lines = checksumsText.split(/\r?\n/);
  for (const line of lines) {
    const match = /^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (!match) continue;
    const hash = match[1].toLowerCase();
    const file = path.posix.basename(match[2].replace(/\\/g, "/"));
    if (file === assetName) return hash;
  }
  return null;
}

function stripInternalRelease(rel: InternalRelease): ReleaseInfo {
  return {
    tag: rel.tag,
    version: rel.version,
    name: rel.name,
    url: rel.url,
    publishedAt: rel.publishedAt,
    body: rel.body,
    prerelease: rel.prerelease,
    hasBundle: rel.hasBundle,
    bundleSize: rel.bundleSize,
    canInstall: rel.canInstall,
    cached: rel.cached,
  };
}

export function mountVersion(
  app: Express,
  store: Store,
  keyGenerator: ClientRateLimitKey,
  options: VersionMountOptions = {},
): void {
  const repo = resolveRepo();
  const apiBase = resolveApiBase();
  const releasesUrl = `https://github.com/${repo}/releases`;
  const baseDir = resolveBaseDir();
  const baseBackendDir = resolveBaseBackendDir();
  const baseVersion =
    process.env.BIMAGE_BASE_VERSION ||
    readPackageJson(baseBackendDir)?.version ||
    readCurrentVersion();
  const dataDir = path.resolve(
    options.dataDir || process.env.DATA_DIR || path.join(baseDir, "data"),
  );
  const runtimeDir = path.resolve(
    process.env.BIMAGE_RUNTIME_DIR || path.join(dataDir, "runtime"),
  );
  const versionsDir = path.join(runtimeDir, "versions");
  const activeFile = path.join(runtimeDir, "active.json");
  const managedByLauncher = process.env.BIMAGE_LAUNCHER === "1";

  let cached: { at: number; checkedAt: string; releases: InternalRelease[] } | null = null;
  let inflight: Promise<{ checkedAt: string; releases: InternalRelease[] }> | null = null;
  let operation: UpdateOperationState | null = null;

  const isOperationRunning = (): boolean =>
    operation !== null &&
    !["idle", "done", "failed"].includes(operation.phase);

  const checkRate = rateLimit({
    keyGenerator,
    windowMs: 15 * 60_000,
    limit: 60,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "检测过于频繁，请稍后再试" },
  });

  async function inspectGit(): Promise<GitInfo> {
    try {
      const inside = await runCmd("git", ["rev-parse", "--is-inside-work-tree"], baseDir, 5_000);
      if (inside !== "true") return { available: false };
      const [commit, branch, status] = await Promise.all([
        runCmd("git", ["rev-parse", "--short", "HEAD"], baseDir, 5_000).catch(() => ""),
        runCmd("git", ["rev-parse", "--abbrev-ref", "HEAD"], baseDir, 5_000).catch(() => ""),
        runCmd("git", ["status", "--porcelain"], baseDir, 5_000).catch(() => ""),
      ]);
      return {
        available: true,
        commit: commit || undefined,
        branch: branch || undefined,
        dirty: status.length > 0,
      };
    } catch {
      return { available: false };
    }
  }

  function buildHeaders(current: string, accept = "application/vnd.github+json"): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: accept,
      "User-Agent": `Bimage/${current}`,
      "X-GitHub-Api-Version": "2022-11-28",
    };
    const token = process.env.GITHUB_TOKEN?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  async function fetchGithubReleases(current: string): Promise<InternalRelease[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(
        `${apiBase}/repos/${repo}/releases?per_page=15`,
        { headers: buildHeaders(current), signal: controller.signal },
      );
      if (response.status === 403 || response.status === 429)
        throw fail(502, "GitHub API 访问受限，请稍后再试");
      if (!response.ok)
        throw fail(502, `GitHub 检测失败（HTTP ${response.status}）`);
      const payload = (await response.json()) as unknown;
      if (!Array.isArray(payload))
        throw fail(502, "GitHub 返回数据格式无效");

      const releases: InternalRelease[] = [];
      for (const item of payload as GithubReleaseRaw[]) {
        if (item.draft === true) continue;
        const tag = typeof item.tag_name === "string" ? item.tag_name.trim() : "";
        if (!tag || !TAG_PATTERN.test(tag)) continue;

        const url =
          typeof item.html_url === "string" && item.html_url.startsWith("https://github.com/")
            ? item.html_url
            : `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`;

        let bundleUrl: string | undefined;
        let bundleName: string | undefined;
        let bundleSize: number | undefined;
        let checksumUrl: string | undefined;

        if (Array.isArray(item.assets)) {
          for (const rawAsset of item.assets as GithubAssetRaw[]) {
            const name = typeof rawAsset.name === "string" ? rawAsset.name.trim() : "";
            const dl =
              typeof rawAsset.browser_download_url === "string"
                ? rawAsset.browser_download_url.trim()
                : "";
            if (!name || !dl) continue;
            if (name === "checksums.txt") {
              checksumUrl = dl;
            } else if (/^bimage-.*\.tar\.gz$/i.test(name)) {
              bundleUrl = dl;
              bundleName = name;
              if (typeof rawAsset.size === "number" && rawAsset.size > 0) {
                bundleSize = rawAsset.size;
              }
            }
          }
        }

        const version = tag.replace(/^v/i, "");
        const slotCached =
          isValidSlotDir(path.join(versionsDir, tag)) || version === baseVersion;

        releases.push({
          tag,
          version,
          name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : tag,
          url,
          publishedAt:
            typeof item.published_at === "string"
              ? item.published_at
              : typeof item.created_at === "string"
                ? item.created_at
                : "",
          body: typeof item.body === "string" ? item.body.trim().slice(0, 4000) : "",
          prerelease: item.prerelease === true,
          hasBundle: Boolean(bundleUrl),
          bundleUrl,
          bundleName,
          bundleSize,
          checksumUrl,
          cached: slotCached,
          canInstall: Boolean(bundleUrl) || slotCached,
        });
      }
      return releases;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError")
        throw fail(504, "连接 GitHub 超时，请检查网络后重试");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function refreshReleases(current: string, force: boolean) {
    if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return { checkedAt: cached.checkedAt, releases: cached.releases };
    }
    if (!inflight) {
      inflight = fetchGithubReleases(current)
        .then((releases) => {
          const checkedAt = new Date().toISOString();
          cached = { at: Date.now(), checkedAt, releases };
          return { checkedAt, releases };
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  }

  function inspectCapabilities(
    git: GitInfo,
    releases: InternalRelease[],
  ): UpdateCapabilities {
    const active = readActiveRuntime(activeFile);
    let hasLocalBackup = false;
    let backupTag: string | undefined;
    let backupVersion: string | undefined;

    if (active?.previous) {
      const prevDir = path.resolve(runtimeDir, active.previous.dir);
      if (prevDir.startsWith(runtimeDir + path.sep) && isValidSlotDir(prevDir)) {
        hasLocalBackup = true;
        backupTag = active.previous.tag;
        backupVersion = active.previous.version;
      }
    } else if (active?.current) {
      // Currently on a runtime slot; can instantaneously revert to base install
      hasLocalBackup = true;
      backupTag = normalizeTag(baseVersion);
      backupVersion = baseVersion;
    }

    const latest = releases.find((r) => !r.prerelease) ?? releases[0] ?? null;
    const latestHasBundle = Boolean(latest?.hasBundle);
    const mode: UpdateCapabilities["mode"] = latestHasBundle
      ? "bundle"
      : git.available
        ? "git"
        : "bundle";

    const canSelfUpdate =
      latestHasBundle ||
      Boolean(latest?.cached) ||
      (git.available && !git.dirty) ||
      releases.length === 0;

    return {
      canSelfUpdate,
      mode,
      managedByLauncher,
      baseVersion,
      hasLocalBackup,
      backupTag,
      backupVersion,
      activeRuntimeTag: active?.current?.tag,
    };
  }

  function buildSnapshot(
    current: string,
    git: GitInfo,
    data: { checkedAt: string; releases: InternalRelease[] } | null,
  ): VersionSnapshot {
    const rawReleases = data?.releases ?? [];
    const enriched = rawReleases.map((rel) => {
      const slotCached =
        isValidSlotDir(path.join(versionsDir, rel.tag)) ||
        rel.version === baseVersion;
      return stripInternalRelease({
        ...rel,
        cached: slotCached,
        canInstall: rel.hasBundle || slotCached || (git.available && !git.dirty),
      });
    });
    const stable = enriched.find((item) => !item.prerelease) ?? enriched[0] ?? null;
    const hasUpdate = !!stable && compareSemver(stable.version, current) > 0;
    const capabilities = inspectCapabilities(git, rawReleases);
    return {
      current,
      repo,
      releasesUrl,
      checkedAt: data?.checkedAt ?? null,
      latest: stable,
      hasUpdate,
      releases: enriched,
      git,
      capabilities,
      operation,
    };
  }

  function assertQueueIdle(actionLabel: string): void {
    const active = store.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM tasks WHERE status IN ('queued','running')",
    );
    if (active && active.count > 0) {
      throw fail(
        409,
        `当前有正在执行或排队中的生成任务，请等待任务完成后再${actionLabel}版本`,
      );
    }
  }

  function updateOp(patch: Partial<UpdateOperationState>): void {
    if (!operation) return;
    operation = { ...operation, ...patch };
  }

  function pruneOldVersions(keepTags: Set<string>): void {
    if (!existsSync(versionsDir)) return;
    try {
      const entries = readdirSync(versionsDir)
        .map((name) => {
          const full = path.join(versionsDir, name);
          let mtime = 0;
          try {
            mtime = statSync(full).mtimeMs;
          } catch {
            /* ignore */
          }
          return { name, full, mtime };
        })
        .sort((a, b) => b.mtime - a.mtime);

      let extraKept = 0;
      for (const entry of entries) {
        if (keepTags.has(entry.name)) continue;
        if (extraKept < 2) {
          extraKept++;
          continue;
        }
        rmSync(entry.full, { recursive: true, force: true });
      }
    } catch {
      /* non-fatal cleanup */
    }
  }

  function scheduleRestart(): void {
    updateOp({
      phase: "restarting",
      progress: 96,
      message: "正在重启服务以应用新版本…",
    });
    if (!options.onRestart) {
      updateOp({
        phase: "done",
        progress: 100,
        message: "更新已就绪，请重启服务生效",
        finishedAt: new Date().toISOString(),
      });
      return;
    }
    const trigger = options.onRestart;
    setTimeout(() => {
      trigger();
    }, 650);
  }

  async function installSlotFromBundle(
    release: InternalRelease,
    currentVersion: string,
  ): Promise<void> {
    const tag = normalizeTag(release.tag);
    const version = tag.replace(/^v/i, "");
    const targetDir = path.join(versionsDir, tag);

    // Instant switch back to baked-in base installation
    if (version === baseVersion && !existsSync(targetDir)) {
      updateOp({
        phase: "applying",
        progress: 88,
        message: `正在切换至基础版本 ${tag}…`,
      });
      const prev = readActiveRuntime(activeFile);
      writeActiveRuntime(
        runtimeDir,
        activeFile,
        prev?.current
          ? {
              current: null,
              previous: prev.current,
              baseVersion,
              updatedAt: new Date().toISOString(),
            }
          : null,
      );
      scheduleRestart();
      return;
    }

    // Instant switch if version bundle is already cached locally
    if (!isValidSlotDir(targetDir)) {
      if (!release.bundleUrl) {
        throw new Error(`发布版本 ${tag} 未附带离线更新包`);
      }

      updateOp({
        phase: "downloading",
        progress: 12,
        message: `正在下载 ${tag} 更新包…`,
      });

      const downloadHeaders = buildHeaders(currentVersion, "application/octet-stream");
      const archiveBuffer = await downloadBuffer(
        release.bundleUrl,
        downloadHeaders,
        MAX_BUNDLE_BYTES,
        (loaded, total) => {
          const ratio = total > 0 ? Math.min(1, loaded / total) : 0;
          const pct = 12 + Math.round(ratio * 52);
          const mb = (loaded / (1024 * 1024)).toFixed(1);
          const totalMb = total > 0 ? ` / ${(total / (1024 * 1024)).toFixed(1)} MB` : " MB";
          updateOp({
            progress: pct,
            message: `正在下载 ${tag} 更新包（${mb}${totalMb}）…`,
          });
        },
      );

      if (release.checksumUrl && release.bundleName) {
        updateOp({
          phase: "verifying",
          progress: 68,
          message: "正在校验更新包 SHA-256 完整性…",
        });
        const checksumBuf = await downloadBuffer(
          release.checksumUrl,
          buildHeaders(currentVersion, "text/plain"),
          256 * 1024,
        );
        const expected = parseChecksumForAsset(
          checksumBuf.toString("utf8"),
          release.bundleName,
        );
        if (!expected) {
          throw new Error(`checksums.txt 中未找到 ${release.bundleName} 的校验和`);
        }
        const actual = createHash("sha256").update(archiveBuffer).digest("hex");
        if (actual !== expected) {
          throw new Error("更新包 SHA-256 校验不匹配，已中止安装");
        }
      }

      updateOp({
        phase: "extracting",
        progress: 76,
        message: "正在解压并准备运行环境…",
      });

      mkdirSync(versionsDir, { recursive: true });
      const stagingDir = path.join(runtimeDir, `.staging-${randomUUID()}`);
      try {
        extractTarGz(archiveBuffer, stagingDir);
        if (!isValidSlotDir(stagingDir)) {
          throw new Error("更新包结构不完整（缺少后端或前端构建产物）");
        }

        const stagedPkg = readPackageJson(path.join(stagingDir, "backend"));
        const basePkg = readPackageJson(baseBackendDir);
        const slotNodeModules = path.join(stagingDir, "backend", "node_modules");
        const baseNodeModules = path.join(baseBackendDir, "node_modules");

        if (sameDependencies(stagedPkg?.dependencies, basePkg?.dependencies)) {
          if (existsSync(baseNodeModules) && !existsSync(slotNodeModules)) {
            symlinkSync(
              baseNodeModules,
              slotNodeModules,
              process.platform === "win32" ? "junction" : "dir",
            );
          }
        } else {
          updateOp({
            phase: "building",
            progress: 82,
            message: "检测到后端依赖变更，正在安装运行时依赖…",
          });
          try {
            await runCmd(
              "npm",
              ["install", "--omit=dev", "--no-audit", "--no-fund"],
              path.join(stagingDir, "backend"),
              5 * 60_000,
            );
          } catch {
            throw new Error(
              "新版本变更了后端依赖且当前运行环境无法自动安装，请重建镜像升级",
            );
          }
        }

        rmSync(targetDir, { recursive: true, force: true });
        renameSync(stagingDir, targetDir);
      } catch (error) {
        rmSync(stagingDir, { recursive: true, force: true });
        throw error;
      }
    }

    updateOp({
      phase: "applying",
      progress: 90,
      message: `正在切换至 ${tag}…`,
    });

    const prevActive = readActiveRuntime(activeFile);
    const nextSlot: SlotRef = {
      tag,
      version,
      dir: `versions/${tag}`,
    };
    const previousSlot =
      prevActive?.current && prevActive.current.tag !== tag
        ? prevActive.current
        : null;

    writeActiveRuntime(runtimeDir, activeFile, {
      current: nextSlot,
      previous: previousSlot,
      baseVersion,
      updatedAt: new Date().toISOString(),
    });

    const keep = new Set<string>([tag]);
    if (previousSlot?.tag) keep.add(previousSlot.tag);
    pruneOldVersions(keep);

    scheduleRestart();
  }

  async function installFromGit(tag: string, actionLabel: string): Promise<void> {
    const git = await inspectGit();
    if (!git.available) {
      throw new Error(`该版本未附带自动更新包，且当前环境非 Git 源码目录，无法自动${actionLabel}`);
    }
    if (git.dirty) {
      throw new Error(
        `工作区存在未提交修改，为避免覆盖本地改动已中止${actionLabel}；请先提交或暂存后再试`,
      );
    }

    updateOp({
      phase: "downloading",
      progress: 18,
      message: `正在拉取源码标签 ${tag}…`,
    });

    try {
      await runCmd("git", ["rev-parse", "--verify", `refs/tags/${tag}`], baseDir, 5_000);
    } catch {
      try {
        await runCmd("git", ["fetch", "origin", "tag", tag, "--no-tags"], baseDir, 45_000);
      } catch {
        throw new Error(`未在远程仓库中找到标签 ${tag}`);
      }
    }

    const prevBackendLock = sha256File(path.join(baseDir, "backend", "package-lock.json"));
    const prevFrontendLock = sha256File(path.join(baseDir, "frontend", "package-lock.json"));

    updateOp({
      phase: "applying",
      progress: 35,
      message: `正在切换源码至 ${tag}…`,
    });

    let fastForwarded = false;
    if (actionLabel === "更新" && git.branch && git.branch !== "HEAD") {
      const canFf = await runCmd(
        "git",
        ["merge-base", "--is-ancestor", "HEAD", `refs/tags/${tag}`],
        baseDir,
        5_000,
      ).then(() => true, () => false);
      if (canFf) {
        try {
          await runCmd("git", ["merge", "--ff-only", `refs/tags/${tag}`], baseDir, 20_000);
          fastForwarded = true;
        } catch {
          fastForwarded = false;
        }
      }
    }
    if (!fastForwarded) {
      await runCmd("git", ["checkout", "--detach", `refs/tags/${tag}`], baseDir, 20_000);
    }

    const nextBackendLock = sha256File(path.join(baseDir, "backend", "package-lock.json"));
    const nextFrontendLock = sha256File(path.join(baseDir, "frontend", "package-lock.json"));

    if (prevBackendLock !== nextBackendLock) {
      updateOp({
        phase: "building",
        progress: 48,
        message: "正在安装后端依赖…",
      });
      await runCmd("npm", ["--prefix", "backend", "ci"], baseDir, 5 * 60_000);
    }
    if (prevFrontendLock !== nextFrontendLock) {
      updateOp({
        phase: "building",
        progress: 60,
        message: "正在安装前端依赖…",
      });
      await runCmd("npm", ["--prefix", "frontend", "ci"], baseDir, 5 * 60_000);
    }

    updateOp({
      phase: "building",
      progress: 75,
      message: "正在编译构建后端与前端…",
    });
    await runCmd("npm", ["run", "build"], baseDir, 5 * 60_000);

    // Clear any runtime slot override so launcher boots the newly built checkout
    writeActiveRuntime(runtimeDir, activeFile, null);
    scheduleRestart();
  }

  function startAsyncOperation(
    action: UpdateOperationState["action"],
    targetTag: string | undefined,
    runner: () => Promise<void>,
  ): UpdateOperationState {
    operation = {
      id: `op-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
      action,
      targetTag,
      phase: "checking",
      progress: 5,
      message:
        action === "update"
          ? `准备更新到 ${targetTag ?? "最新版本"}…`
          : action === "rollback"
            ? `准备回退到 ${targetTag ?? "上一版本"}…`
            : "准备重启服务…",
      startedAt: new Date().toISOString(),
    };
    void runner().catch((error: unknown) => {
      const msg =
        error instanceof Error ? error.message : "操作失败，请稍后重试";
      updateOp({
        phase: "failed",
        error: msg,
        message: msg,
        finishedAt: new Date().toISOString(),
      });
    });
    return operation;
  }

  app.get("/api/admin/version", admin, async (_request, response) => {
    const current = readCurrentVersion();
    const git = await inspectGit();
    const validCache =
      cached && Date.now() - cached.at < CACHE_TTL_MS
        ? { checkedAt: cached.checkedAt, releases: cached.releases }
        : null;
    response.json(buildSnapshot(current, git, validCache));
  });

  app.get("/api/admin/version/status", admin, (_request, response) => {
    response.json({
      current: readCurrentVersion(),
      operation,
    });
  });

  app.post("/api/admin/version/check", admin, checkRate, async (request, response) => {
    const input =
      request.body && typeof request.body === "object"
        ? (request.body as Record<string, unknown>)
        : {};
    const force = input.force === true;
    const current = readCurrentVersion();
    const [git, data] = await Promise.all([
      inspectGit(),
      refreshReleases(current, force),
    ]);
    response.json(buildSnapshot(current, git, data));
  });

  app.post("/api/admin/version/update", admin, checkRate, async (_request, response) => {
    if (isOperationRunning()) {
      throw fail(409, "已有版本更新任务正在进行中，请等待完成");
    }
    assertQueueIdle("更新");

    const current = readCurrentVersion();
    let data = await refreshReleases(current, false);
    let latest = data.releases.find((item) => !item.prerelease) ?? data.releases[0] ?? null;
    if (!latest || compareSemver(latest.version, current) <= 0) {
      data = await refreshReleases(current, true);
      latest = data.releases.find((item) => !item.prerelease) ?? data.releases[0] ?? null;
    }
    if (!latest) throw fail(404, "未获取到可用的 GitHub 发布版本");
    if (compareSemver(latest.version, current) <= 0) {
      throw fail(409, "当前已是最新版本，无需更新");
    }
    if (!TAG_PATTERN.test(latest.tag)) throw fail(400, "无效的目标版本号");

    const target = latest;
    const tag = normalizeTag(target.tag);
    const slotCached =
      isValidSlotDir(path.join(versionsDir, tag)) || target.version === baseVersion;

    if (!target.hasBundle && !slotCached) {
      const git = await inspectGit();
      if (!git.available) {
        throw fail(
          400,
          `发布版本 ${tag} 尚未附带在线更新包，无法在当前无源码环境下自动更新`,
        );
      }
      if (git.dirty) {
        throw fail(
          409,
          "工作区存在未提交修改，为避免覆盖本地改动已中止更新；请先提交或暂存后再试",
        );
      }
    }

    const op = startAsyncOperation("update", tag, async () => {
      if (target.hasBundle || slotCached) {
        await installSlotFromBundle(target, current);
      } else {
        await installFromGit(tag, "更新");
      }
    });

    response.status(202).json({
      ok: true,
      tag,
      operation: op,
      message: `已开始更新到 ${tag}`,
    });
  });

  app.post("/api/admin/version/rollback", admin, checkRate, async (request, response) => {
    if (isOperationRunning()) {
      throw fail(409, "已有版本操作正在进行中，请等待完成");
    }
    assertQueueIdle("回退");

    const rawBody =
      request.body && typeof request.body === "object"
        ? (body(request) as Record<string, unknown>)
        : {};
    const rawTag = typeof rawBody.tag === "string" ? rawBody.tag.trim() : "";
    const current = readCurrentVersion();

    // Omit tag -> instant rollback to local backup (previous slot or base install)
    if (!rawTag) {
      const active = readActiveRuntime(activeFile);
      if (!active?.current) {
        throw fail(404, "当前没有可一键恢复的本地备份版本，请选择指定历史版本回退");
      }
      const prev = active.previous;
      if (prev) {
        const prevDir = path.resolve(runtimeDir, prev.dir);
        if (!prevDir.startsWith(runtimeDir + path.sep) || !isValidSlotDir(prevDir)) {
          throw fail(404, "本地备份目录已失效，请选择指定历史版本回退");
        }
        const op = startAsyncOperation("rollback", prev.tag, async () => {
          updateOp({
            phase: "applying",
            progress: 85,
            message: `正在恢复本地备份 ${prev.tag}…`,
          });
          writeActiveRuntime(runtimeDir, activeFile, {
            current: prev,
            previous: active.current,
            baseVersion,
            updatedAt: new Date().toISOString(),
          });
          scheduleRestart();
        });
        response.status(202).json({
          ok: true,
          tag: prev.tag,
          operation: op,
          message: `正在恢复到 ${prev.tag}`,
        });
        return;
      }

      const baseTag = normalizeTag(baseVersion);
      const op = startAsyncOperation("rollback", baseTag, async () => {
        updateOp({
          phase: "applying",
          progress: 85,
          message: `正在恢复基础版本 ${baseTag}…`,
        });
        writeActiveRuntime(runtimeDir, activeFile, {
          current: null,
          previous: active.current,
          baseVersion,
          updatedAt: new Date().toISOString(),
        });
        scheduleRestart();
      });
      response.status(202).json({
        ok: true,
        tag: baseTag,
        operation: op,
        message: `正在恢复到 ${baseTag}`,
      });
      return;
    }

    if (!TAG_PATTERN.test(rawTag)) throw fail(400, "无效的目标版本号");
    const tag = normalizeTag(rawTag);
    const targetVersion = tag.replace(/^v/i, "");
    if (targetVersion === current) {
      throw fail(409, "目标版本与当前运行版本一致");
    }

    const slotCached =
      isValidSlotDir(path.join(versionsDir, tag)) || targetVersion === baseVersion;

    let release: InternalRelease | undefined;
    if (!slotCached) {
      const data = await refreshReleases(current, false);
      release = data.releases.find((r) => normalizeTag(r.tag) === tag);
      if (!release) {
        const fresh = await refreshReleases(current, true);
        release = fresh.releases.find((r) => normalizeTag(r.tag) === tag);
      }
    }

    const useBundle = slotCached || Boolean(release?.hasBundle);
    if (!useBundle) {
      const git = await inspectGit();
      if (!git.available) {
        throw fail(
          400,
          `历史版本 ${tag} 未附带在线更新包，无法在当前无源码环境下直接回退`,
        );
      }
      if (git.dirty) {
        throw fail(
          409,
          "工作区存在未提交修改，为避免覆盖本地改动已中止回退；请先提交或暂存后再试",
        );
      }
    }

    const syntheticRelease: InternalRelease = release ?? {
      tag,
      version: targetVersion,
      name: tag,
      url: `${releasesUrl}/tag/${encodeURIComponent(tag)}`,
      publishedAt: "",
      body: "",
      prerelease: false,
      hasBundle: false,
      canInstall: true,
      cached: slotCached,
    };

    const op = startAsyncOperation("rollback", tag, async () => {
      if (useBundle) {
        await installSlotFromBundle(syntheticRelease, current);
      } else {
        await installFromGit(tag, "回退");
      }
    });

    response.status(202).json({
      ok: true,
      tag,
      operation: op,
      message: `已开始回退到 ${tag}`,
    });
  });

  app.post("/api/admin/version/restart", admin, checkRate, async (_request, response) => {
    if (isOperationRunning()) {
      throw fail(409, "已有版本操作正在进行中，请等待完成");
    }
    assertQueueIdle("重启");
    const op = startAsyncOperation("restart", normalizeTag(readCurrentVersion()), async () => {
      scheduleRestart();
    });
    response.status(202).json({
      ok: true,
      operation: op,
      message: "正在重启服务…",
    });
  });
}
