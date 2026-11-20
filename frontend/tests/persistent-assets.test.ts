// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { assetCache } from "../src/composables/assetCache";
import { clearAllPersistentAssets, clearPersistentAssets, persistentAssetUsage, persistentEpoch, readPersistentAsset, writePersistentAsset } from "../src/composables/persistentAssets";
const controllers: AbortController[] = [];
function cache(owner = "account-a", verify = async () => {}) {
  const controller = new AbortController(); controllers.push(controller);
  return { controller, cache: assetCache(controller.signal, undefined, { owner, verify }) };
}
const image = () => new Response(new Blob(["private"], { type: "image/webp" }));
beforeEach(() => { vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("localStorage", { setItem() {} }); });
afterEach(() => { controllers.splice(0).forEach(c => c.abort()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("switching authenticated owner removes the prior account's persistent bytes", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => image());
  const first = cache("account-a"); await first.cache.get("one"); first.controller.abort();
  const second = cache("account-b"); await second.cache.get("one");
  expect((await persistentAssetUsage("account-a")).count).toBe(0);
  expect((await second.cache.usage()).count).toBe(1);
  expect(fetcher.mock.calls.map(([, options]) => options?.method)).toEqual(["GET", "GET"]);
});
it("restores a persisted thumbnail after refresh using HEAD authorization and zero image GET bodies", async () => {
  const verify = vi.fn(async () => {});
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => options?.method === "HEAD" ? new Response(null) : image());
  const first = cache(); const entry = await first.cache.get("one", "thumbnail"); first.controller.abort();
  const second = cache("account-a", verify); const restored = await second.cache.get("one", "thumbnail");
  expect(await restored.blob.text()).toBe(await entry.blob.text());
  expect(verify).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls.map(([url, options]) => [url, options?.method]))
    .toEqual([["/api/assets/one?variant=thumbnail", "GET"], ["/api/assets/one?variant=thumbnail", "HEAD"]]);
});
it("does not display persistent bytes offline or after a failed live identity guard", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => image());
  const first = cache(); await first.cache.get("one"); first.controller.abort();
  fetcher.mockRejectedValueOnce(Error("offline"));
  await expect(cache().cache.get("one")).rejects.toThrow("offline");
  const verify = vi.fn(async () => { throw Error("cookie changed"); });
  await expect(cache("account-a", verify).cache.get("one")).rejects.toThrow("cookie changed");
  expect(verify).toHaveBeenCalledOnce();
});
it("does not return resolved in-memory bytes while offline", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => image());
  const verify = vi.fn(async () => {});
  const first = cache("account-a", verify);
  const entry = await first.cache.get("one");
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  fetcher.mockRejectedValueOnce(Error("offline"));
  await expect(first.cache.get("one")).rejects.toThrow("offline");
  expect(fetcher.mock.calls.map(([, options]) => options?.method)).toEqual(["GET", "HEAD"]);
  expect(verify).toHaveBeenCalledOnce();
  expect(revoke).toHaveBeenCalledWith(entry.url);
});
it("rejects resolved in-memory bytes after a silent cookie identity change", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => options?.method === "HEAD" ? new Response(null) : image());
  const verify = vi.fn(async () => {});
  const first = cache("account-a", verify);
  const entry = await first.cache.get("one");
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  verify.mockRejectedValueOnce(Error("cookie changed"));
  await expect(first.cache.get("one")).rejects.toThrow("cookie changed");
  expect(verify).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls.map(([, options]) => options?.method)).toEqual(["GET", "HEAD"]);
  expect(revoke).toHaveBeenCalledWith(entry.url);
});
it.each(["original", "thumbnail"] as const)("deduplicates first loads and concurrent %s memory authorization without reloading bytes", async variant => {
  const verify = vi.fn(async () => {});
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => image());
  const first = cache("account-a", verify);
  const [entry, joined] = await Promise.all([first.cache.get("one /?", variant), first.cache.acquire("one /?", variant)]);
  expect(joined).toBe(entry);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(verify).toHaveBeenCalledOnce();

  let finish!: (response: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const reuse = first.cache.get("one /?", variant);
  const concurrent = first.cache.acquire("one /?", variant);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(fetcher).toHaveBeenCalledTimes(2);
  const head = new Response(null);
  const readBody = vi.spyOn(head, "blob").mockRejectedValue(Error("HEAD must not load a body"));
  finish(head);
  const [a, b] = await Promise.all([reuse, concurrent]);
  expect(a).toBe(entry); expect(b).toBe(entry);
  expect(a.blob).toBe(entry.blob); expect(a.url).toBe(entry.url);
  expect(readBody).not.toHaveBeenCalled();
  expect(verify).toHaveBeenCalledTimes(2);

  expect(await first.cache.get("one /?", variant)).toBe(entry);
  expect(verify).toHaveBeenCalledTimes(3);
  const url = "/api/assets/one%20%2F%3F" + (variant === "thumbnail" ? "?variant=thumbnail" : "");
  expect(fetcher.mock.calls.map(([path, options]) => [path, options?.method, options?.credentials, options?.cache]))
    .toEqual([[url, "GET", "same-origin", "no-store"], [url, "HEAD", "same-origin", "no-store"], [url, "HEAD", "same-origin", "no-store"]]);
  first.cache.release("one /?", variant); first.cache.release("one /?", variant);
});
it.each([403, 404])("memory HEAD %s evicts both asset variants but preserves unrelated assets", async status => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => image());
  const verify = vi.fn(async () => {});
  const first = cache("account-a", verify);
  const original = await first.cache.get("one"), thumb = await first.cache.get("one", "thumbnail");
  const unrelated = await first.cache.get("two");
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  fetcher.mockResolvedValueOnce(new Response(null, { status }));
  await expect(first.cache.get("one", "thumbnail")).rejects.toThrow("图片加载失败");
  expect(fetcher.mock.calls.at(-1)?.slice(0, 1)).toEqual(["/api/assets/one?variant=thumbnail"]);
  expect(fetcher.mock.calls.at(-1)?.[1]?.method).toBe("HEAD");
  expect(revoke).toHaveBeenCalledWith(original.url); expect(revoke).toHaveBeenCalledWith(thumb.url);
  expect(revoke).not.toHaveBeenCalledWith(unrelated.url);
  expect(verify).toHaveBeenCalledTimes(3);
  await vi.waitFor(async () => expect((await first.cache.usage()).count).toBe(1));
});
it("memory HEAD 401 clears all private bytes and invalidates the owning lifetime", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => image());
  const controller = new AbortController(); controllers.push(controller);
  const unauthorized = vi.fn(() => controller.abort()), verify = vi.fn(async () => {});
  const first = assetCache(controller.signal, unauthorized, { owner: "account-a", verify });
  const original = await first.get("one"), thumb = await first.get("one", "thumbnail"), other = await first.get("two");
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  fetcher.mockResolvedValueOnce(new Response(null, { status: 401 }));
  await expect(first.get("one")).rejects.toThrow();
  expect(unauthorized).toHaveBeenCalledOnce();
  for (const entry of [original, thumb, other]) expect(revoke).toHaveBeenCalledWith(entry.url);
  expect(verify).toHaveBeenCalledTimes(3);
  await vi.waitFor(async () => expect((await first.usage()).count).toBe(0));
});
it("concurrent memory authorization failures reject all callers and permit a fresh retry", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => image());
  const first = cache(); const entry = await first.cache.get("one");
  let fail!: (error: Error) => void;
  fetcher.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  const pending = Promise.allSettled([first.cache.get("one"), first.cache.acquire("one")]);
  await vi.waitFor(() => expect(fail).toBeTypeOf("function"));
  fail(Error("offline"));
  expect(await pending).toEqual([{ status: "rejected", reason: Error("offline") }, { status: "rejected", reason: Error("offline") }]);
  const restored = await first.cache.get("one");
  expect(restored).not.toBe(entry);
  expect(fetcher.mock.calls.map(([, options]) => options?.method)).toEqual(["GET", "HEAD", "HEAD"]);
});
it.each(["clear", "evict", "abort"] as const)("%s rejects late memory authorization even after successful HEAD and verify", async action => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => image());
  let finish!: () => void;
  const verify = vi.fn(async () => {});
  const first = cache("account-a", verify); await first.cache.get("one");
  verify.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = first.cache.get("one");
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  if (action === "abort") first.controller.abort();
  else if (action === "evict") await first.cache.evict("one");
  else await first.cache.clear();
  finish(); await rejected;
});
it("a missing cached asset evicts both variants and cannot fall back to stale bytes", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => image());
  const first = cache(); await first.cache.get("one"); await first.cache.get("one", "thumbnail"); first.controller.abort();
  fetcher.mockResolvedValueOnce(new Response(null, { status: 404 }));
  const second = cache(); await expect(second.cache.get("one")).rejects.toThrow();
  await vi.waitFor(async () => expect((await second.cache.usage()).count).toBe(0));
});
it("401 clears persistent bytes and invokes the owning lifetime invalidation", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => image());
  const first = cache(); await first.cache.get("one"); first.controller.abort();
  const controller = new AbortController(); controllers.push(controller);
  const unauthorized = vi.fn(() => controller.abort());
  const second = assetCache(controller.signal, unauthorized, { owner: "account-a", verify: async () => {} });
  fetcher.mockResolvedValueOnce(new Response(null, { status: 401 }));
  await expect(second.get("one")).rejects.toThrow();
  await vi.waitFor(async () => expect((await second.usage()).count).toBe(0));
  expect(unauthorized).toHaveBeenCalledOnce();
});
it.each(["clear", "evict"] as const)("%s suppresses a late in-flight image and its persistent write", async action => {
  let finish!: (response: Response) => void;
  vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const first = cache(); const pending = first.cache.get("one");
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  if (action === "clear") await first.cache.clear(); else await first.cache.evict("one");
  finish(image()); await rejected;
  expect((await first.cache.usage()).count).toBe(0);
});
it("transaction epochs reject delayed writes captured before delete or clear", async () => {
  const before = (await persistentEpoch("account-a"))!;
  await clearPersistentAssets("account-a", "one");
  await writePersistentAsset("account-a", "one", "original", new Blob(["late"]), before);
  const current = (await persistentEpoch("account-a"))!;
  expect(await readPersistentAsset("account-a", "one", "original", current)).toBeUndefined();
});
it("global unauthenticated clear invalidates outstanding owner writes", async () => {
  const epoch = (await persistentEpoch("account-a"))!;
  await writePersistentAsset("account-a", "one", "original", new Blob(["before"]), epoch);
  await clearAllPersistentAssets();
  await writePersistentAsset("account-a", "one", "original", new Blob(["late"]), epoch);
  expect((await persistentAssetUsage("account-a")).count).toBe(0);
});
it("quota failure and unavailable IndexedDB never fail image delivery", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => image());
  vi.stubGlobal("indexedDB", { open() { throw new DOMException("unavailable", "QuotaExceededError"); } });
  expect(await (await cache().cache.get("one")).blob.text()).toBe("private");
  vi.stubGlobal("indexedDB", new IDBFactory());
  const { IDBObjectStore } = await import("fake-indexeddb");
  const original = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    const request = original.call(this, value, key);
    if (this.name === "assets") queueMicrotask(() => this.transaction.abort());
    return request;
  });
  const second = cache();
  expect(await (await second.cache.get("one")).blob.text()).toBe("private");
  expect((await second.cache.usage()).count).toBe(0);
});
it("synchronous storage write failures fall back to the fetched image", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => image());
  const { IDBObjectStore } = await import("fake-indexeddb");
  const original = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    if (this.name === "assets") throw new DOMException("full", "QuotaExceededError");
    return original.call(this, value, key);
  });
  expect(await (await cache().cache.get("one")).blob.text()).toBe("private");
});
it("persistent LRU evicts the oldest bytes to stay below 128 MB", async () => {
  const blob = new Blob([new Uint8Array(45 * 1024 * 1024)]);
  const epoch = (await persistentEpoch("account-a"))!;
  const clock = vi.spyOn(Date, "now").mockReturnValueOnce(1).mockReturnValueOnce(2).mockReturnValueOnce(3).mockReturnValueOnce(4);
  await writePersistentAsset("account-a", "oldest", "original", blob, epoch);
  await writePersistentAsset("account-a", "middle", "original", blob, epoch);
  await readPersistentAsset("account-a", "oldest", "original", epoch); // touch makes middle LRU
  await writePersistentAsset("account-a", "newest", "original", blob, epoch);
  expect(await readPersistentAsset("account-a", "middle", "original", epoch)).toBeUndefined();
  expect((await persistentAssetUsage("account-a")).count).toBe(2);
  expect((await persistentAssetUsage("account-a")).bytes).toBeLessThanOrEqual(128 * 1024 * 1024);
  clock.mockRestore();
});
it("deletion in one tab revokes both variants in another tab", async () => {
  const channels: { onmessage?: (event: { data: unknown }) => void }[] = [];
  vi.stubGlobal("BroadcastChannel", class {
    onmessage?: (event: { data: unknown }) => void;
    constructor() { channels.push(this); }
    postMessage(data: unknown) { channels.filter(c => c !== this).forEach(c => c.onmessage?.({ data })); }
    close() {}
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => image());
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  const first = cache(), second = cache();
  const original = await second.cache.get("one"), thumb = await second.cache.get("one", "thumbnail");
  await first.cache.evict("one");
  expect(revoke).toHaveBeenCalledWith(original.url); expect(revoke).toHaveBeenCalledWith(thumb.url);
  expect((await second.cache.usage()).count).toBe(0);
});
