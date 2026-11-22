import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Express } from "express";
import rateLimit from "express-rate-limit";
import type { Store } from "./db.js";
import { admin, body, fail } from "./http.js";
import type { ClientRateLimitKey } from "./client-rate-limit.js";

const execFileAsync = promisify(execFile);
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TAG_PATTERN = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const CACHE_TTL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;

export interface ReleaseInfo {
  tag: string;
  version: string;
  name: string;
  url: string;
  publishedAt: string;
  body: string;
  prerelease: boolean;
}

export interface GitInfo {
  available: boolean;
  commit?: string;
  branch?: string;
  dirty?: boolean;
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
  error?: string;
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
}

function readCurrentVersion(): string {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: string };
  return pkg.version || "0.0.0";
}

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

function resolveRepo(): string {
  const configured = process.env.BIMAGE_GITHUB_REPO?.trim();
  if (configured && REPO_PATTERN.test(configured)) return configured;
  return "FangChanguwu/Bimage";
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function parseSemver(input: string): ParsedSemver | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
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

async function runGit(args: string[], timeout = 15_000): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: REPO_ROOT,
    timeout,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function inspectGit(): Promise<GitInfo> {
  try {
    const inside = await runGit(["rev-parse", "--is-inside-work-tree"], 5_000);
    if (inside !== "true") return { available: false };
    const [commit, branch, status] = await Promise.all([
      runGit(["rev-parse", "--short", "HEAD"], 5_000).catch(() => ""),
      runGit(["rev-parse", "--abbrev-ref", "HEAD"], 5_000).catch(() => ""),
      runGit(["status", "--porcelain"], 5_000).catch(() => ""),
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

async function fetchGithubReleases(repo: string, current: string): Promise<ReleaseInfo[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": `Bimage/${current}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/releases?per_page=15`,
      { headers, signal: controller.signal },
    );
    if (response.status === 403 || response.status === 429)
      throw fail(502, "GitHub API 访问受限，请稍后再试");
    if (!response.ok)
      throw fail(502, `GitHub 检测失败（HTTP ${response.status}）`);
    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload))
      throw fail(502, "GitHub 返回数据格式无效");
    const releases: ReleaseInfo[] = [];
    for (const item of payload as GithubReleaseRaw[]) {
      if (item.draft === true) continue;
      const tag = typeof item.tag_name === "string" ? item.tag_name.trim() : "";
      if (!tag) continue;
      const url =
        typeof item.html_url === "string" && item.html_url.startsWith("https://github.com/")
          ? item.html_url
          : `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`;
      releases.push({
        tag,
        version: tag.replace(/^v/i, ""),
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

export function mountVersion(
  app: Express,
  store: Store,
  keyGenerator: ClientRateLimitKey,
): void {
  const repo = resolveRepo();
  const releasesUrl = `https://github.com/${repo}/releases`;
  let cached: { at: number; checkedAt: string; releases: ReleaseInfo[] } | null = null;
  let inflight: Promise<{ checkedAt: string; releases: ReleaseInfo[] }> | null = null;

  const checkRate = rateLimit({
    keyGenerator,
    windowMs: 15 * 60_000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "检测过于频繁，请稍后再试" },
  });

  const buildSnapshot = (
    current: string,
    git: GitInfo,
    data: { checkedAt: string; releases: ReleaseInfo[] } | null,
  ): VersionSnapshot => {
    const releases = data?.releases ?? [];
    const stable = releases.find((item) => !item.prerelease) ?? releases[0] ?? null;
    const hasUpdate = !!stable && compareSemver(stable.version, current) > 0;
    return {
      current,
      repo,
      releasesUrl,
      checkedAt: data?.checkedAt ?? null,
      latest: stable,
      hasUpdate,
      releases,
      git,
    };
  };

  async function refreshReleases(current: string, force: boolean) {
    if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return { checkedAt: cached.checkedAt, releases: cached.releases };
    }
    if (!inflight) {
      inflight = fetchGithubReleases(repo, current)
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

  app.get("/api/admin/version", admin, async (_request, response) => {
    const current = readCurrentVersion();
    const git = await inspectGit();
    const validCache =
      cached && Date.now() - cached.at < CACHE_TTL_MS
        ? { checkedAt: cached.checkedAt, releases: cached.releases }
        : null;
    response.json(buildSnapshot(current, git, validCache));
  });

  app.post("/api/admin/version/check", admin, checkRate, async (request, response) => {
    const input = request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {};
    const force = input.force === true;
    const current = readCurrentVersion();
    const [git, data] = await Promise.all([inspectGit(), refreshReleases(current, force)]);
    response.json(buildSnapshot(current, git, data));
  });

  app.post("/api/admin/version/rollback", admin, checkRate, async (request, response) => {
    const input = body(request);
    const rawTag = typeof input.tag === "string" ? input.tag.trim() : "";
    if (!TAG_PATTERN.test(rawTag))
      throw fail(400, "无效的目标版本号");

    const active = store.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM tasks WHERE status IN ('queued','running')",
    );
    if (active && active.count > 0)
      throw fail(409, "当前有正在执行或排队中的生成任务，请等待任务完成后再回退版本");

    const git = await inspectGit();
    if (!git.available)
      throw fail(400, "当前运行环境非 Git 源码目录，请按下方命令手动回退版本");
    if (git.dirty)
      throw fail(409, "工作区存在未提交修改，为避免覆盖本地改动已中止回退；请先提交或暂存后再试");

    const tag = rawTag.startsWith("v") ? rawTag : `v${rawTag}`;
    // Ensure the tag exists locally; fetch from origin if absent.
    try {
      await runGit(["rev-parse", "--verify", `refs/tags/${tag}`], 5_000);
    } catch {
      try {
        await runGit(["fetch", "origin", "tag", tag, "--no-tags"], 30_000);
      } catch {
        throw fail(404, `未在 GitHub 仓库中找到标签 ${tag}`);
      }
    }

    try {
      await runGit(["checkout", "--detach", tag], 15_000);
    } catch {
      throw fail(500, `切换到版本 ${tag} 失败`);
    }

    const commit = await runGit(["rev-parse", "--short", "HEAD"], 5_000).catch(() => "");
    response.json({
      ok: true,
      tag,
      commit,
      restartRequired: true,
      message: `已切换到 ${tag}${commit ? ` (${commit})` : ""}，请重新构建并重启服务生效`,
    });
  });
}
