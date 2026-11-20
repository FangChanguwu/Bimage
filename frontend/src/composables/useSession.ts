import { ref, onScopeDispose } from "vue";
import type { Api, Identity } from "../types";
import { assetCache } from "./assetCache";
import { clearAllPersistentAssets } from "./persistentAssets";

const CHANGE_KEY = "bimage-session-change";
const CHANNEL = "bimage-session";
const PUBLIC_PATHS = new Set(["/login", "/setup", "/site"]);
interface Lifetime {
  controller: AbortController;
  csrf: string;
  identity: Identity | null;
  checking?: Promise<void>;
}
export function useSession() {
  const identity = ref<Identity | null>(null),
    pending = ref(false),
    ready = ref(false);
  const fresh = (): Lifetime => ({ controller: new AbortController(), csrf: "", identity: null });
  let life = fresh(), authBusy = false;
  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL) : null;
  function announce() {
    // Never transmit identity, CSRF, credentials or tenant data. Notices can only clear state.
    channel?.postMessage("invalidate");
    try { localStorage.setItem(CHANGE_KEY, `${Date.now()}:${Math.random()}`); } catch { /* storage may be disabled */ }
  }
  function invalidate(broadcast = false) {
    // Explicit invalidation clears disk; ordinary scope disposal only revokes URLs.
    void assetCache(life.controller.signal).clear();
    life.controller.abort();
    life = fresh();
    identity.value = null;
    pending.value = authBusy;
    ready.value = true;
    try { sessionStorage.setItem("bimage-signed-out", "true"); } catch { /* local clearing still works */ }
    if (broadcast) announce();
  }
  function changed() { invalidate(); }
  function storageChanged(event: StorageEvent) {
    if (event.key === CHANGE_KEY) changed();
  }
  if (channel) channel.onmessage = (event) => {
    if (event.data === "invalidate") changed();
  };
  window.addEventListener("storage", storageChanged);

  async function request<T>(bound: Lifetime, path: string, body?: unknown, method?: string, extra?: AbortSignal): Promise<T> {
    const signal = extra ? AbortSignal.any([bound.controller.signal, extra]) : bound.controller.signal;
    signal.throwIfAborted();
    const r = await fetch("/api" + path, {
      method: method || (body === undefined ? "GET" : "POST"),
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: { "content-type": "application/json", "x-csrf-token": bound.csrf },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    signal.throwIfAborted();
    if (r.status === 401 && path === "/me" && !bound.identity) void clearAllPersistentAssets();
    if (r.status === 401 && !PUBLIC_PATHS.has(path) && bound === life && bound.identity) {
      invalidate(true);
      throw Error("会话已失效，请重新登录");
    }
    const data = await r.json().catch(() => null);
    signal.throwIfAborted();
    if (!r.ok) throw Error(data?.error || "请求失败，请重试");
    if (data === null) throw Error("服务器响应无效，请重试");
    return data as T;
  }
  async function verify(bound: Lifetime, afterResponse = false) {
    bound.controller.signal.throwIfAborted();
    if (!bound.identity) throw Error("请重新登录");
    // A check already in flight might have authenticated the cookie before this
    // data response. Wait for it, then start a fresh check for the new result.
    if (afterResponse && bound.checking) await bound.checking;
    bound.controller.signal.throwIfAborted();
    // Only concurrent checks share a promise; no cached identity can authorize a later poll/write.
    if (!bound.checking) {
      bound.checking = (async () => {
        const current = await request<Identity>(bound, "/me");
        const expected = bound.identity!;
        if (current.id !== expected.id || current.role !== expected.role || current.csrf !== bound.csrf) {
          if (bound === life) invalidate(true);
          throw Error("会话已切换，请重新登录");
        }
      })().finally(() => { bound.checking = undefined; });
    }
    await bound.checking;
    bound.controller.signal.throwIfAborted();
  }
  function bindApi(bound: Lifetime): Api {
    return async <T>(path: string, body?: unknown, method?: string, extra?: AbortSignal) => {
      bound.controller.signal.throwIfAborted();
      const authenticated = !PUBLIC_PATHS.has(path) && path !== "/me";
      const verb = method || (body === undefined ? "GET" : "POST");
      // Reads are verified before exposing their result; mutations also verify
      // before sending and retain the lifetime's CSRF (never a future token).
      if (authenticated && !["GET", "HEAD"].includes(verb)) await verify(bound);
      bound.controller.signal.throwIfAborted();
      extra?.throwIfAborted();
      const result = await request<T>(bound, path, body, method, extra);
      // Cookie identity can change while the response is in flight. Do not expose
      // any tenant result to a component until the current cookie is verified.
      if (authenticated) await verify(bound, true);
      extra?.throwIfAborted();
      return result;
    };
  }
  function adopt(bound: Lifetime, m: Identity) {
    bound.controller.signal.throwIfAborted();
    bound.csrf = m.csrf;
    bound.identity = m;
    assetCache(bound.controller.signal, () => {
      if (bound === life) invalidate(true);
    }, { owner: m.id, verify: () => verify(bound, true) });
    identity.value = m;
  }
  async function restore() {
    if (authBusy || ready.value) return;
    authBusy = true;
    pending.value = true;
    const bound = life;
    try {
      if (sessionStorage.getItem("bimage-signed-out") !== "true") adopt(bound, await request<Identity>(bound, "/me"));
    } catch {
    } finally {
      authBusy = false;
      pending.value = false;
      ready.value = true;
    }
  }
  async function authenticate(path: "/login" | "/setup", body: { password: string; login?: string; code?: string }) {
    if (authBusy || !ready.value) return;
    authBusy = true;
    // New credentials get a new lifetime: old callbacks keep an aborted API binding forever.
    void assetCache(life.controller.signal).clear();
    life.controller.abort();
    life = fresh();
    const bound = life;
    pending.value = true;
    try {
      adopt(bound, await request<Identity>(bound, path, body));
      try { sessionStorage.removeItem("bimage-signed-out"); } catch { /* the current session still works */ }
      announce();
    } finally {
      authBusy = false;
      pending.value = false;
    }
  }
  const login = (login: string, password: string) => authenticate("/login", { login, password });
  const setup = (code: string, password: string) => authenticate("/setup", { code, password });
  async function logout() {
    if (authBusy) return "";
    authBusy = true;
    const token = life.csrf;
    invalidate(true);
    pending.value = true;
    try {
      // Revocation outlives the tenant it just destroyed.
      const r = await fetch("/api/logout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": token },
        body: "{}",
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) throw Error("退出未确认");
      return "";
    } catch {
      return "退出未确认，请检查网络；本标签已清除会话内容。必要时清除站点 Cookie。";
    } finally {
      authBusy = false;
      pending.value = false;
    }
  }

  function foreground() {
    if (!document.hidden && life.identity) void verify(life).catch(() => {});
  }
  window.addEventListener("focus", foreground);
  window.addEventListener("pageshow", foreground);
  document.addEventListener("visibilitychange", foreground);
  onScopeDispose(() => {
    life.controller.abort();
    channel?.close();
    window.removeEventListener("storage", storageChanged);
    window.removeEventListener("focus", foreground);
    window.removeEventListener("pageshow", foreground);
    document.removeEventListener("visibilitychange", foreground);
  });
  return {
    identity, pending, ready, restore, login, setup, logout,
    // Vue passes this stable, lifetime-bound function to the keyed tenant tree.
    // Never hand an old component a function that reads a future session's token.
    get api() { return bindApi(life); },
    get signal() { return life.controller.signal; },
  };
}
