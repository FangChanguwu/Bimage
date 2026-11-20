import { it, expect, vi } from "vitest";
import { assetCache } from "../src/composables/assetCache";
it("deduplicates original fetches per session and revokes on logout", async () => {
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(new Blob(["png"], { type: "image/png" })));
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  const c = new AbortController();
  const cache = assetCache(c.signal);
  const [a, b] = await Promise.all([cache.get("a"), cache.get("a")]);
  expect(a).toBe(b);
  expect(await cache.get("a")).toBe(a);
  expect(fetcher).toHaveBeenCalledTimes(1);
  c.abort();
  expect(revoke).toHaveBeenCalledWith(a.url);
  await expect(cache.get("a")).rejects.toThrow();
  fetcher.mockRestore();
});
it("asset authentication failure invalidates the owning lifetime and revokes cached originals", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(new Blob(["png"], { type: "image/png" })))
    .mockResolvedValueOnce(new Response("{}", { status: 401 }));
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  const controller = new AbortController();
  const expired = vi.fn(() => controller.abort());
  const cache = assetCache(controller.signal, expired);
  const first = await cache.get("original");
  await expect(cache.get("expired")).rejects.toThrow();
  expect(expired).toHaveBeenCalledOnce();
  expect(revoke).toHaveBeenCalledWith(first.url);
  expect(controller.signal.aborted).toBe(true);
  fetcher.mockRestore();
  revoke.mockRestore();
});

it.each([
  { count: 25, size: 1, label: "24 entries" },
  { count: 3, size: 22 * 1024 * 1024, label: "64 MiB" },
])("memory trimming respects $label while keeping acquired originals", async ({ count, size }) => {
  const blob = new Blob([new Uint8Array(size)]);
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(blob));
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  const controller = new AbortController();
  try {
    const cache = assetCache(controller.signal);
    const pinned = await cache.acquire("pinned");
    const oldest = await cache.get("oldest");
    for (let i = 2; i < count; i++) await cache.get(`extra-${i}`);
    cache.trim();
    expect(revoke).toHaveBeenCalledWith(oldest.url);
    expect(revoke).not.toHaveBeenCalledWith(pinned.url);
    expect(await cache.get("pinned")).toBe(pinned);
    expect(await cache.get("oldest")).not.toBe(oldest);
    expect(fetcher).toHaveBeenCalledTimes(count + 1);
  } finally { controller.abort(); fetcher.mockRestore(); revoke.mockRestore(); }
});
it("evicts deleted originals without restoring an in-flight asset", async () => {
  const reply = () => new Response(new Blob(["png"], { type: "image/png" }));
  let finish!: (response: Response) => void;
  const late = new Promise<Response>((resolve) => { finish = resolve; });
  const fetcher = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(reply()).mockReturnValueOnce(late)
    .mockResolvedValueOnce(new Response(null, { status: 404 }));
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  const controller = new AbortController();
  try {
    const cache = assetCache(controller.signal);
    const original = await cache.acquire("original");
    const pending = cache.get("pending");
    cache.evict("original");
    cache.evict("pending");
    expect(revoke).toHaveBeenCalledWith(original.url);
    finish(reply());
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(cache.get("pending")).rejects.toThrow("图片加载失败");
    expect(fetcher).toHaveBeenCalledTimes(3);
  } finally {
    controller.abort();
    fetcher.mockRestore();
    revoke.mockRestore();
  }
});
