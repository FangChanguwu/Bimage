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
}
const caches = new WeakMap<AbortSignal, ReturnType<typeof createCache>>();
export function assetCache(signal: AbortSignal, unauthorized?: () => void) {
  let cache = caches.get(signal);
  if (!cache) {
    cache = createCache(signal, unauthorized);
    caches.set(signal, cache);
  }
  return cache;
}
function createCache(signal: AbortSignal, unauthorized?: () => void) {
  const entries = new Map<string, RecordEntry>();
  function drop(id: string, r: RecordEntry) {
    r.controller.abort();
    if (r.entry) {
      URL.revokeObjectURL(r.entry.url);
      if (r.entry.thumb) URL.revokeObjectURL(r.entry.thumb);
      r.entry = undefined;
    }
    if (entries.get(id) === r) entries.delete(id);
  }
  function evict(id: string) {
    const record = entries.get(id);
    if (record) drop(id, record);
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
  async function get(id: string) {
    signal.throwIfAborted();
    let record = entries.get(id);
    if (record) {
      entries.delete(id);
      entries.set(id, record);
    } else {
      record = { controller: new AbortController(), refs: 0, promise: Promise.resolve(null as unknown as Entry) };
      const current = record;
      entries.set(id, current);
      current.promise = (async () => {
        const requestSignal = AbortSignal.any([signal, current.controller.signal]);
        const response = await fetch("/api/assets/" + encodeURIComponent(id), {
          signal: requestSignal,
          cache: "no-store",
        });
        requestSignal.throwIfAborted();
        if (response.status === 401) unauthorized?.();
        if (!response.ok) throw Error("图片加载失败，请重试");
        const blob = await response.blob();
        requestSignal.throwIfAborted();
        const entry = {
          signal: requestSignal,
          refs: current.refs,
          blob,
          url: URL.createObjectURL(blob),
        };
        current.entry = entry;
        return entry;
      })().catch((e) => {
        drop(id, current);
        throw e;
      });
    }
    return record.promise;
  }
  async function acquire(id: string) {
    const promise = get(id);
    const record = entries.get(id);
    if (record) record.refs++;
    try {
      return await promise;
    } catch (e) {
      if (record) record.refs--;
      throw e;
    }
  }
  function release(id: string) {
    const record = entries.get(id);
    if (record) record.refs = Math.max(0, record.refs - 1);
    trim();
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
      for (const [id, r] of entries) drop(id, r);
    },
    { once: true },
  );
  return { get, acquire, release, thumbnail, trim, evict };
}
export async function download(url: string, name: string, signal: AbortSignal) {
  signal.throwIfAborted();
  let blob: Blob,
    filename = name;
  if (url.startsWith("/api/assets/")) {
    const entry = await assetCache(signal).get(url.slice(12));
    entry.signal.throwIfAborted();
    blob = entry.blob;
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
export async function copyImage(id: string, signal: AbortSignal) {
  if (
    !window.isSecureContext ||
    !navigator.clipboard?.write ||
    !window.ClipboardItem
  )
    throw Error("当前环境不支持图片剪贴板，需要 HTTPS；请下载原图");
  const entry = await assetCache(signal).get(id);
  let blob = entry.blob;
  if (blob.type !== "image/png") {
    const bitmap = await createImageBitmap(blob);
    try {
      if (bitmap.width * bitmap.height > 32000000)
        throw Error("图片过大，请下载原图");
      const c = document.createElement("canvas");
      c.width = bitmap.width;
      c.height = bitmap.height;
      c.getContext("2d")!.drawImage(bitmap, 0, 0);
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
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  } catch {
    throw Error("剪贴板权限被拒绝或浏览器不支持，请下载原图");
  }
  entry.signal.throwIfAborted();
  assetCache(signal).trim();
}
