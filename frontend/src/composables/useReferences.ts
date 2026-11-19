import { ref, onScopeDispose } from "vue";
import { MAX_REFERENCES, fileData } from "../domain";
import type { Api } from "../types";
export async function uploadReferences(
  files: File[],
  ids: string[],
  api: Api,
  signal: AbortSignal,
) {
  if (ids.length + files.length > MAX_REFERENCES)
    throw Error("参考图最多16张，请减少后重试");
  for (const file of files) {
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
      throw Error("仅支持 PNG、JPEG、WebP");
    if (file.size > 8 * 1024 * 1024) throw Error("每张参考图最多8MB");
  }
  const out = [...ids];
  for (const file of files) {
    signal.throwIfAborted();
    const data = await fileData(file);
    signal.throwIfAborted();
    const asset = await api<{ id: string }>(
      "/assets",
      { mime: file.type, data: data.split(",")[1] },
      undefined,
      signal,
    );
    signal.throwIfAborted();
    if (!out.includes(asset.id)) out.push(asset.id);
  }
  return out;
}
export function useReferences(
  get: () => string[],
  set: (ids: string[]) => void,
  api: Api,
  signal: AbortSignal,
) {
  const pending = ref(false);
  let queue = Promise.resolve(),
    version = 0,
    active = true;
  onScopeDispose(() => {
    active = false;
    version++;
  });
  function invalidate() {
    version++;
  }
  function upload(files: File[]) {
    const captured = version;
    pending.value = true;
    queue = queue
      .catch(() => {})
      .then(async () => {
        if (!active || captured !== version) return;
        const ids = await uploadReferences(files, get(), api, signal);
        if (active && captured === version) set(ids);
      })
      .finally(() => {
        if (active) pending.value = false;
      });
    return queue;
  }
  function paste(e: ClipboardEvent) {
    const files = Array.from(e.clipboardData?.files || []).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (files.length) {
      e.preventDefault();
      return upload(files);
    }
    return Promise.resolve();
  }
  return { pending, upload, paste, invalidate };
}
