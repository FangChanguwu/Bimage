import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const RESTART_EXIT_CODE = 75;
const CRASH_WINDOW_MS = 15_000;

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

const BASE_BACKEND_DIR = path.resolve(import.meta.dirname, "..");
const BASE_ROOT_DIR = path.resolve(BASE_BACKEND_DIR, "..");
const DATA_DIR = path.resolve(
  process.env.DATA_DIR || path.join(BASE_ROOT_DIR, "data"),
);
const RUNTIME_DIR = path.join(DATA_DIR, "runtime");
const ACTIVE_FILE = path.join(RUNTIME_DIR, "active.json");

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function readBaseVersion(): string {
  const pkg = readJson<{ version?: string }>(
    path.join(BASE_BACKEND_DIR, "package.json"),
  );
  return pkg?.version || "0.0.0";
}

function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
    return m
      ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? 0 : 1]
      : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return a.localeCompare(b, undefined, { numeric: true });
  for (let i = 0; i < 4; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function writeActiveAtomically(active: ActiveRuntime | null): void {
  if (!active) {
    try {
      unlinkSync(ACTIVE_FILE);
    } catch {
      /* already absent */
    }
    return;
  }
  mkdirSync(RUNTIME_DIR, { recursive: true });
  const tmp = `${ACTIVE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(active, null, 2) + "\n", "utf8");
  renameSync(tmp, ACTIVE_FILE);
}

function resolveSlotDir(relDir: string): string | null {
  const candidate = path.resolve(RUNTIME_DIR, relDir);
  if (
    candidate === RUNTIME_DIR ||
    !candidate.startsWith(RUNTIME_DIR + path.sep)
  ) {
    return null;
  }
  return candidate;
}

function ensureNodeModulesLink(slotDir: string): void {
  const slotNodeModules = path.join(slotDir, "backend", "node_modules");
  if (existsSync(slotNodeModules)) return;
  const baseNodeModules = path.join(BASE_BACKEND_DIR, "node_modules");
  if (!existsSync(baseNodeModules)) return;
  symlinkSync(
    baseNodeModules,
    slotNodeModules,
    process.platform === "win32" ? "junction" : "dir",
  );
}

interface LaunchTarget {
  isRuntimeSlot: boolean;
  tag: string;
  version: string;
  entry: string;
  frontendDir: string;
  active: ActiveRuntime | null;
}

function resolveTarget(baseVersion: string): LaunchTarget {
  const baseEntry = path.join(BASE_BACKEND_DIR, "dist", "index.js");
  const baseFrontendDir =
    process.env.BIMAGE_FRONTEND_DIR ||
    path.join(BASE_ROOT_DIR, "frontend", "dist");

  const active = existsSync(ACTIVE_FILE)
    ? readJson<ActiveRuntime>(ACTIVE_FILE)
    : null;

  if (active?.current) {
    // If the host/container image was manually upgraded to a newer version than
    // the runtime override, drop the stale override and boot the newer base image.
    if (
      active.baseVersion !== baseVersion &&
      compareSemver(baseVersion, active.current.version) > 0
    ) {
      console.log(
        `[launcher] Base installation (${baseVersion}) is newer than runtime slot (${active.current.version}); clearing override.`,
      );
      writeActiveAtomically(null);
    } else {
      const slotDir = resolveSlotDir(active.current.dir);
      if (slotDir) {
        const slotEntry = path.join(slotDir, "backend", "dist", "index.js");
        const slotFrontend = path.join(slotDir, "frontend", "dist");
        if (existsSync(slotEntry)) {
          try {
            ensureNodeModulesLink(slotDir);
          } catch (error) {
            console.error(
              "[launcher] Failed to link node_modules for runtime slot:",
              error,
            );
          }
          return {
            isRuntimeSlot: true,
            tag: active.current.tag,
            version: active.current.version,
            entry: slotEntry,
            frontendDir: existsSync(path.join(slotFrontend, "index.html"))
              ? slotFrontend
              : baseFrontendDir,
            active,
          };
        }
      }
      console.warn(
        `[launcher] Runtime slot ${active.current.tag} is missing or invalid; falling back to base ${baseVersion}.`,
      );
      writeActiveAtomically(null);
    }
  }

  return {
    isRuntimeSlot: false,
    tag: `v${baseVersion}`,
    version: baseVersion,
    entry: baseEntry,
    frontendDir: baseFrontendDir,
    active: null,
  };
}

function rollbackOnCrash(active: ActiveRuntime | null, baseVersion: string): void {
  if (active?.previous) {
    const prevDir = resolveSlotDir(active.previous.dir);
    if (prevDir && existsSync(path.join(prevDir, "backend", "dist", "index.js"))) {
      console.error(
        `[launcher] Rolling back crashed runtime slot to previous ${active.previous.tag}.`,
      );
      writeActiveAtomically({
        current: active.previous,
        previous: null,
        baseVersion,
        updatedAt: new Date().toISOString(),
      });
      return;
    }
  }
  console.error(
    `[launcher] Rolling back crashed runtime slot to base installation v${baseVersion}.`,
  );
  writeActiveAtomically(null);
}

let child: ChildProcess | null = null;
let shuttingDown = false;
let consecutiveFastCrashes = 0;

function forwardSignal(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (child && !child.killed) {
    child.kill(signal);
  } else {
    process.exit(0);
  }
}

process.on("SIGTERM", () => forwardSignal("SIGTERM"));
process.on("SIGINT", () => forwardSignal("SIGINT"));

function start(): void {
  const baseVersion = readBaseVersion();
  const target = resolveTarget(baseVersion);
  const startedAt = Date.now();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATA_DIR,
    BIMAGE_LAUNCHER: "1",
    BIMAGE_BASE_DIR: BASE_ROOT_DIR,
    BIMAGE_BASE_BACKEND_DIR: BASE_BACKEND_DIR,
    BIMAGE_BASE_VERSION: baseVersion,
    BIMAGE_RUNTIME_DIR: RUNTIME_DIR,
    BIMAGE_FRONTEND_DIR: target.frontendDir,
    BIMAGE_ACTIVE_TAG: target.tag,
    BIMAGE_ACTIVE_VERSION: target.version,
  };

  console.log(
    `[launcher] Starting Bimage ${target.tag} (${target.isRuntimeSlot ? "runtime slot" : "base install"})`,
  );

  const proc = spawn(process.execPath, [target.entry], {
    stdio: "inherit",
    env,
  });
  child = proc;

  proc.once("exit", (code, signal) => {
    child = null;
    if (shuttingDown) {
      process.exit(code ?? 0);
      return;
    }

    if (code === RESTART_EXIT_CODE) {
      consecutiveFastCrashes = 0;
      console.log("[launcher] Restart requested for version switch; reloading...");
      setTimeout(start, 150);
      return;
    }

    const elapsed = Date.now() - startedAt;
    if (
      target.isRuntimeSlot &&
      !signal &&
      code !== 0 &&
      elapsed < CRASH_WINDOW_MS &&
      consecutiveFastCrashes < 2
    ) {
      consecutiveFastCrashes++;
      console.error(
        `[launcher] Runtime slot ${target.tag} crashed after ${elapsed}ms (exit ${code}); triggering automatic rollback.`,
      );
      rollbackOnCrash(target.active, baseVersion);
      setTimeout(start, 250);
      return;
    }

    process.exit(code ?? (signal ? 1 : 0));
  });
}

start();
