import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { effectScope } from "vue";
import { useSession } from "../src/composables/useSession";
import { assetCache } from "../src/composables/assetCache";
import * as persistent from "../src/composables/persistentAssets";

const admin = { id: "a", role: "admin", name: "Admin", csrf: "fixture-a" };
const member = { id: "b", role: "user", name: "Member", csrf: "fixture-b" };
const scopes: ReturnType<typeof effectScope>[] = [];
beforeEach(() => {
  // Node 26's native localStorage shadows happy-dom unless explicitly supplied.
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    clear: () => data.clear(),
  });
});
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop();
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});
function setup() {
  const scope = effectScope(); scopes.push(scope);
  const session = scope.run(useSession)!;
  return session;
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
it("logout and cross-tab invalidation clear the owner cache, ordinary scope disposal does not", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => json(admin));
  const clear = vi.spyOn(persistent, "clearPersistentAssets").mockResolvedValue();
  const session = setup(); await session.restore();
  await session.logout();
  await vi.waitFor(() => expect(clear).toHaveBeenCalledWith("a"));
  clear.mockClear();
  sessionStorage.clear();
  const other = setup(); await other.restore();
  window.dispatchEvent(new StorageEvent("storage", { key: "bimage-session-change" }));
  await Promise.resolve(); await Promise.resolve();
  await vi.waitFor(() => expect(clear).toHaveBeenCalledWith("a"));
  clear.mockClear();
  sessionStorage.clear();
  const refreshed = setup(); await refreshed.restore();
  scopes.pop()!.stop();
  await Promise.resolve();
  expect(refreshed.signal.aborted).toBe(true);
  expect(clear).not.toHaveBeenCalled();
});
it("asset results verify the current cookie identity before exposing another account's bytes", async () => {
  let current = admin;
  vi.spyOn(globalThis, "fetch").mockImplementation(async input =>
    String(input) === "/api/me" ? json(current) : new Response(new Blob(["private"])));
  const session = setup(); await session.restore();
  current = member;
  await expect(assetCache(session.signal).get("asset")).rejects.toThrow();
  expect(session.identity.value).toBeNull();
});
it("refresh with a revoked cookie clears persisted assets even before a tenant is adopted", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => json({ error: "expired" }, 401));
  const clear = vi.spyOn(persistent, "clearAllPersistentAssets").mockResolvedValue();
  const session = setup(); await session.restore();
  expect(clear).toHaveBeenCalledOnce();
  expect(session.identity.value).toBeNull();
});
it("authenticated 401 aborts the tenant and cached lifetime instead of leaving stale identity", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async input =>
    String(input) === "/api/me" ? json(admin) : json({ error: "请登录" }, 401));
  const session = setup(); await session.restore();
  const api = session.api, signal = session.signal;
  await expect(api("/jobs")).rejects.toThrow();
  expect(session.identity.value).toBeNull();
  expect(signal.aborted).toBe(true);
  expect(sessionStorage.getItem("bimage-signed-out")).toBe("true");
  const calls = fetcher.mock.calls.length;
  await expect(api("/settings", { form: "old private draft" }, "PUT")).rejects.toThrow();
  expect(fetcher.mock.calls.length).toBe(calls);
});
it("old API closures cannot borrow new member credentials after invalidation and login", async () => {
  let current = admin;
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    if (String(input) === "/api/login") current = member;
    return json(current);
  });
  const session = setup(); await session.restore();
  const api = session.api;
  window.dispatchEvent(new StorageEvent("storage", { key: "bimage-session-change", newValue: "invalidate" }));
  await session.login("member@example.test", "fixture-password");
  expect(session.identity.value?.id).toBe("b");
  const count = fetcher.mock.calls.length;
  await expect(api("/assets", { data: "old-reader" })).rejects.toThrow();
  expect(fetcher.mock.calls.length).toBe(count);
});
it("storage is invalidation-only and cannot inject attacker-selected admin identity or csrf", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(json(member));
  const session = setup(); await session.restore();
  window.dispatchEvent(new StorageEvent("storage", {
    key: "bimage-session-change", newValue: JSON.stringify(admin),
  }));
  expect(session.identity.value).toBeNull();
  expect(localStorage.getItem("bimage-session-change")).toBeNull();
});
it("a stale identity check cannot restore state after a storage invalidation", async () => {
  let release!: (value: Response) => void;
  vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const session = setup();
  const restoring = session.restore();
  window.dispatchEvent(new StorageEvent("storage", { key: "bimage-session-change", newValue: "change" }));
  release(json(admin));
  await restoring;
  expect(session.identity.value).toBeNull();
  expect(session.ready.value).toBe(true);
});
it("a post-response identity check never reuses a check started before the tenant response", async () => {
  let current = admin;
  let releaseOldCheck!: (response: Response) => void;
  let releaseJobs!: (response: Response) => void;
  let holdCheck = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    if (String(input) === "/api/jobs") return new Promise(resolve => { releaseJobs = resolve; });
    if (String(input) === "/api/me" && holdCheck) {
      holdCheck = false;
      return new Promise(resolve => { releaseOldCheck = resolve; });
    }
    return json(current);
  });
  const session = setup(); await session.restore();
  holdCheck = true;
  window.dispatchEvent(new Event("focus")); // Starts /me under the old cookie.
  const jobs = session.api("/jobs");
  current = member;
  releaseJobs(json([{ id: "other-tenant-job" }]));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  releaseOldCheck(json(admin));
  await expect(jobs).rejects.toThrow();
  expect(session.identity.value).toBeNull();
});
it("storage notices work on non-secure origins without crypto.randomUUID", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(json(admin));
  vi.spyOn(crypto, "randomUUID").mockImplementation(() => { throw Error("not a secure context"); });
  const session = setup(); await session.restore();
  await session.logout();
  expect(localStorage.getItem("bimage-session-change")).toBeTruthy();
});
it("duplicate cross-tab notices cannot unlock a pending login or allow parallel login submissions", async () => {
  let release!: (value: Response) => void;
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "请登录" }, 401));
  const session = setup(); await session.restore();
  fetcher.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const first = session.login("first", "fixture-password").catch(() => {});
  window.dispatchEvent(new StorageEvent("storage", { key: "bimage-session-change", newValue: "notice" }));
  expect(session.pending.value).toBe(true);
  const second = session.login("second", "fixture-password");
  expect(fetcher.mock.calls.filter(([url]) => url === "/api/login")).toHaveLength(1);
  release(json(admin));
  await Promise.all([first, second]);
  expect(session.pending.value).toBe(false);
  expect(session.identity.value).toBeNull();
});
