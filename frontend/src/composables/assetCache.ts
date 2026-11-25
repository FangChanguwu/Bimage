import { activatePersistentOwner, clearPersistentAssets, persistentAssetUsage, readPersistentAssetWithEpoch, writePersistentAsset, type AssetVariant } from "./persistentAssets.ts";
export interface CacheOptions { owner: string; verify: () => Promise<void> }
interface Entry {
  signal: AbortSignal;
  refs: number;
  blob: Blob;
  url: string;
  thumb?: string;
  thumbPromise?: Promise<string>;
}
interface RecordEntry {
  controller: AbortController;
  refs: number;
  promise: Promise<Entry>;
  entry?: Entry;
  validation?: Promise<Entry>;
}
const caches = new WeakMap<AbortSignal, ReturnType<typeof createCache>>();
export function assetCache(signal: AbortSignal, unauthorized?: () => void, options?: CacheOptions) {
  let cache = caches.get(signal);
  if (!cache) {
    cache = createCache(signal, unauthorized, options);
    caches.set(signal, cache);
  }
  return cache;
}
function createCache(signal: AbortSignal, unauthorized?: () => void, options?: CacheOptions) {
  const entries = new Map<string, RecordEntry>();
  let clearing: Promise<void> = options ? activatePersistentOwner(options.owner) : Promise.resolve();
  const channel = options && typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("bimage-asset-invalidation") : null;
  const NOTICE_KEY = "bimage-asset-invalidation";
  function receive(data: unknown) {
    if (!data || typeof data !== "object") return;
    const notice = data as { type?: unknown; asset?: unknown };
    if (notice.type === "clear") clearMemory();
    if (notice.type === "evict" && typeof notice.asset === "string") evictMemory(notice.asset);
  }
  if (channel) channel.onmessage = event => receive(event.data);
  function storageNotice(event: StorageEvent) {
    if (event.key !== NOTICE_KEY || !event.newValue) return;
    try { receive(JSON.parse(event.newValue)); } catch { /* invalid notices cannot authorize anything */ }
  }
  if (options && typeof window !== "undefined") window.addEventListener("storage", storageNotice);
  function announce(type: "clear" | "evict", asset?: string) {
    if (!options) return;
    const notice = { type, asset, nonce: `${Date.now()}:${Math.random()}` };
    channel?.postMessage(notice);
    try { localStorage.setItem(NOTICE_KEY, JSON.stringify(notice)); } catch { /* optional fallback */ }
  }
  const cacheKey = (id: string, variant: AssetVariant) => JSON.stringify([id, variant]);
  function drop(id: string, r: RecordEntry) {
    r.controller.abort();
    if (r.entry) {
      URL.revokeObjectURL(r.entry.url);
      if (r.entry.thumb) URL.revokeObjectURL(r.entry.thumb);
      r.entry = undefined;
    }
    if (entries.get(id) === r) entries.delete(id);
  }
  function clearMemory() {
    for (const [id, r] of entries) drop(id, r);
  }
  function clear(): Promise<boolean> {
    clearMemory();
    announce("clear");
    if (!options) return Promise.resolve(true);
    const result = clearing.then(() => clearPersistentAssets(options.owner));
    clearing = result.then(() => undefined);
    return result;
  }
  function evictMemory(id: string) {
    for (const variant of ["original", "thumbnail"] as const) {
      const k = cacheKey(id, variant), record = entries.get(k);
      if (record) drop(k, record);
    }
  }
  function evict(id: string) {
    evictMemory(id);
    announce("evict", id);
    if (options) clearing = clearing.then(() => clearPersistentAssets(options.owner, id).then(() => undefined));
    return clearing;
  }
  function usage() {
    return options ? persistentAssetUsage(options.owner) : Promise.resolve({ bytes: 0, count: 0, limit: 128 * 1024 * 1024, available: false });
  }
  function trim() {
    let bytes = [...entries.values()].reduce(
      (n, r) => n + (r.entry?.blob.size || 0),
      0,
    );
    for (const [id, r] of entries) {
      if (entries.size <= 24 && bytes <= 64 * 1024 * 1024) break;
      if (r.refs === 0 && r.entry) {
        bytes -= r.entry.blob.size;
        drop(id, r);
      }
    }
  }
  async function get(id: string, variant: AssetVariant = "original") {
    signal.throwIfAborted();
    const k = cacheKey(id, variant);
    let record = entries.get(k);
    if (record) {
      entries.delete(k);
      entries.set(k, record);
      if (options && record.entry) {
        const current = record, entry = record.entry;
        // Join pending authorization, but never reuse its result for a later hit.
        if (!current.validation) current.validation = (async () => {
          const requestSignal = entry.signal;
          requestSignal.throwIfAborted();
          const url = "/api/assets/" + encodeURIComponent(id) + (variant === "thumbnail" ? "?variant=thumbnail" : "");
          const response = await fetch(url, {
            method: "HEAD", signal: requestSignal,
            credentials: "same-origin", cache: "no-store",
          });
          requestSignal.throwIfAborted();
          if (response.status === 401) { void clear(); unauthorized?.(); }
          if (!response.ok) {
            if (response.status === 403 || response.status === 404) void evict(id);
            throw Error("图片加载失败，请重试");
          }
          // HEAD authorizes this asset; identity readback also binds it to this owner.
          await options.verify();
          requestSignal.throwIfAborted();
          return entry;
        })().catch(e => {
          drop(k, current);
          throw e;
        }).finally(() => { current.validation = undefined; });
        return current.validation;
      }
    } else {
      record = { controller: new AbortController(), refs: 0, promise: Promise.resolve(null as unknown as Entry) };
      const current = record;
      entries.set(k, current);
      current.promise = (async () => {
        const requestSignal = AbortSignal.any([signal, current.controller.signal]);
        if (options) await clearing;
        requestSignal.throwIfAborted();
        const { epoch, blob: stored } = options
          ? await readPersistentAssetWithEpoch(options.owner, id, variant)
          : { epoch: undefined, blob: undefined };
        requestSignal.throwIfAborted();
        const url = "/api/assets/" + encodeURIComponent(id) + (variant === "thumbnail" ? "?variant=thumbnail" : "");
        const response = await fetch(url, {
          method: stored ? "HEAD" : "GET", signal: requestSignal,
          credentials: "same-origin", cache: "no-store",
        });
        requestSignal.throwIfAborted();
        if (response.status === 401) { void clear(); unauthorized?.(); }
        if (!response.ok) {
          if (response.status === 403 || response.status === 404) void evict(id);
          throw Error("图片加载失败，请重试");
        }
        const blob = stored || await response.blob();
        requestSignal.throwIfAborted();
        // A fresh /me readback prevents a replaced cookie from exposing another owner's bytes.
        await options?.verify();
        requestSignal.throwIfAborted();
        if (options && !stored && epoch !== undefined) await writePersistentAsset(options.owner, id, variant, blob, epoch);
        requestSignal.throwIfAborted();
        const entry = { signal: requestSignal, refs: current.refs, blob, url: URL.createObjectURL(blob) };
        current.entry = entry;
        return entry;
      })().catch((e) => {
        drop(k, current);
        throw e;
      });
    }
    return record.promise;
  }
  async function acquire(id: string, variant: AssetVariant = "original") {
    const promise = get(id, variant);
    const record = entries.get(cacheKey(id, variant));
    if (record) record.refs++;
    try {
      return await promise;
    } catch (e) {
      if (record) record.refs--;
      throw e;
    }
  }
  function release(id: string, variant: AssetVariant = "original") {
    const record = entries.get(cacheKey(id, variant));
    if (record) record.refs = Math.max(0, record.refs - 1);
    trim();
  }
  function peek(id: string, variant: AssetVariant = "thumbnail"): string | undefined {
    if (signal.aborted) return undefined;
    const record = entries.get(cacheKey(id, variant));
    if (!record?.entry || record.entry.signal.aborted) return undefined;
    return record.entry.url;
  }
  async function thumbnail(entry: Entry) {
    entry.signal.throwIfAborted();
    if (entry.thumb) return entry.thumb;
    if (!entry.thumbPromise)
      entry.thumbPromise = (async () => {
        const image = await createImageBitmap(entry.blob);
        try {
          entry.signal.throwIfAborted();
          const canvas = document.createElement("canvas");
          const scale = Math.min(1, 480 / image.width);
          canvas.width = Math.round(image.width * scale);
          canvas.height = Math.round(image.height * scale);
          canvas
            .getContext("2d")!
            .drawImage(image, 0, 0, canvas.width, canvas.height);
          const blob = await new Promise<Blob | null>((r) =>
            canvas.toBlob(r, "image/png"),
          );
          entry.signal.throwIfAborted();
          if (!blob) throw Error("缩略图处理失败");
          entry.thumb = URL.createObjectURL(blob);
          return entry.thumb;
        } finally {
          image.close();
        }
      })();
    return entry.thumbPromise;
  }
  signal.addEventListener(
    "abort",
    () => {
      clearMemory();
      channel?.close();
      if (typeof window !== "undefined") window.removeEventListener("storage", storageNotice);
    },
    { once: true },
  );
  return { get, acquire, release, peek, thumbnail, trim, evict, clear, usage };
}
export function extensionForMime(mime?: string): string {
  const normalized = (mime || "").toLowerCase().split(";")[0].trim();
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "jpg";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/gif") return "gif";
  if (normalized === "image/avif") return "avif";
  if (normalized === "image/png") return "png";
  if (normalized.startsWith("image/")) return normalized.slice(6) || "png";
  return "png";
}
export async function download(url: string, name: string, signal: AbortSignal) {
  signal.throwIfAborted();
  let blob: Blob,
    filename = name;
  if (url.startsWith("/api/assets/")) {
    const entry = await assetCache(signal).get(url.slice(12));
    entry.signal.throwIfAborted();
    blob = entry.blob;
    if (!/\.[a-z0-9]{2,5}$/i.test(filename)) {
      filename = `${filename}.${extensionForMime(blob.type)}`;
    }
  } else {
    const r = await fetch(url, { signal });
    if (!r.ok) {
      const e = await r.json().catch(() => ({ error: "下载失败" }));
      throw Error(e.error || "下载失败");
    }
    blob = await r.blob();
    filename =
      r.headers.get("content-disposition")?.match(/filename="?([^";]+)/)?.[1] ||
      name;
  }
  signal.throwIfAborted();
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  const clean = () => URL.revokeObjectURL(href);
  signal.addEventListener("abort", clean, { once: true });
  setTimeout(() => {
    clean();
    signal.removeEventListener("abort", clean);
  }, 30000);
  assetCache(signal).trim();
}
async function toPngBlob(id: string, signal: AbortSignal): Promise<Blob> {
  const cache = assetCache(signal);
  const entry = await cache.acquire(id);
  try {
    let blob = entry.blob;
    if (blob.type !== "image/png") {
      const bitmap = await createImageBitmap(blob);
      try {
        if (bitmap.width * bitmap.height > 32000000)
          throw Error("图片过大，请下载原图");
        const c = document.createElement("canvas");
        c.width = bitmap.width;
        c.height = bitmap.height;
        const ctx = c.getContext("2d");
        if (!ctx) throw Error("图片转换失败，请下载原图");
        ctx.drawImage(bitmap, 0, 0);
        const png = await new Promise<Blob | null>((r) =>
          c.toBlob(r, "image/png"),
        );
        if (!png) throw Error("图片转换失败，请下载原图");
        blob = png;
      } finally {
        bitmap.close();
      }
    }
    entry.signal.throwIfAborted();
    return blob;
  } finally {
    cache.release(id);
  }
}
export async function copyImage(id: string, signal: AbortSignal) {
  if (
    !window.isSecureContext ||
    !navigator.clipboard?.write ||
    !window.ClipboardItem
  )
    throw Error("当前环境不支持图片剪贴板，需要 HTTPS；请下载原图");
  signal.throwIfAborted();

  let prepError: unknown;
  const pngPromise = toPngBlob(id, signal).catch((error) => {
    prepError = error;
    throw error;
  });
  // Avoid unhandledrejection if clipboard.write fails before pngPromise settles.
  void pngPromise.catch(() => {});

  // Invoke clipboard.write synchronously inside the click gesture with a Promise<Blob>
  // so transient user activation is preserved while fetching and converting the original image.
  let writePromise: Promise<void> | undefined;
  try {
    writePromise = navigator.clipboard.write([
      new ClipboardItem({ "image/png": pngPromise }),
    ]);
  } catch {
    // Fallback for engines whose ClipboardItem only accepts a resolved Blob.
  }

  if (writePromise) {
    try {
      await writePromise;
      signal.throwIfAborted();
      return;
    } catch (error) {
      signal.throwIfAborted();
      if (prepError !== undefined) throw prepError;
      if (error instanceof DOMException && error.name === "NotAllowedError")
        throw Error("剪贴板权限被拒绝或浏览器不支持，请下载原图");
    }
  }

  let blob: Blob;
  try {
    blob = await pngPromise;
  } catch {
    signal.throwIfAborted();
    if (prepError !== undefined) throw prepError;
    throw Error("图片加载失败，请重试");
  }
  signal.throwIfAborted();
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  } catch {
    throw Error("剪贴板权限被拒绝或浏览器不支持，请下载原图");
  }
  signal.throwIfAborted();
}
