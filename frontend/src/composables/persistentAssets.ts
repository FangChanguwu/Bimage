// Blob storage is optional: private browsing, quota and IndexedDB failures never
// turn a successful image response into an image error. No credentials are stored.
export type AssetVariant = "original" | "thumbnail";
const DATABASE = "bimage-assets-v1";
const VERSION = 2;
const MAX_ENTRIES = 2048;
const MAX_BYTES = 128 * 1024 * 1024;
interface StoredAsset { key: string; owner: string; asset: string; size: number; touched: number }
export interface CacheUsage { bytes: number; count: number; limit: number; available: boolean }
const key = (owner: string, asset: string, variant: AssetVariant) => JSON.stringify([owner, asset, variant, VERSION]);
let dbPromise: Promise<IDBDatabase> | undefined;
function database(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE, VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (db.objectStoreNames.contains("assets")) db.deleteObjectStore("assets");
        db.createObjectStore("assets", { keyPath: "key" });
        const metadata = db.createObjectStore("metadata", { keyPath: "key" });
        metadata.createIndex("touched", "touched");
        if (!db.objectStoreNames.contains("epochs")) db.createObjectStore("epochs");
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); dbPromise = undefined; };
        db.onclose = () => { dbPromise = undefined; };
        resolve(db);
      };
      request.onerror = () => { dbPromise = undefined; reject(request.error); };
      request.onblocked = () => { dbPromise = undefined; reject(Error("图片缓存不可用")); };
    });
  }
  return dbPromise;
}
async function transact<T>(mode: IDBTransactionMode, fallback: T, action: (tx: IDBTransaction, result: (value: T) => void) => void): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const db = await database();
      return await new Promise<T>((resolve, reject) => {
        let tx: IDBTransaction;
        try {
          tx = db.transaction(["assets", "epochs", "metadata"], mode);
        } catch (err) {
          dbPromise = undefined;
          reject(err);
          return;
        }
        let value = fallback;
        tx.oncomplete = () => resolve(value);
        tx.onabort = tx.onerror = () => resolve(fallback);
        try { action(tx, next => { value = next; }); } catch { tx.abort(); }
      });
    } catch {
      dbPromise = undefined;
    }
  }
  return fallback;
}
// Epoch checks live in the SAME transaction as writes/deletes. This prevents a
// delayed fetch in another tab from recreating data after logout or deletion.
export async function activatePersistentOwner(owner: string) {
  await transact("readwrite", undefined, (tx) => {
    const epochs = tx.objectStore("epochs"), active = epochs.get(["active-owner"]);
    active.onsuccess = () => {
      const previous = active.result as string | undefined;
      if (previous && previous !== owner) {
        const old = epochs.get(previous);
        old.onsuccess = () => epochs.put((old.result || 0) + 1, previous);
      }
      epochs.put(owner, ["active-owner"]);
      const cursor = tx.objectStore("metadata").openCursor();
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) return;
        if ((row.value as StoredAsset).owner !== owner) { tx.objectStore("assets").delete(row.primaryKey); row.delete(); }
        row.continue();
      };
    };
  });
}
export async function persistentEpoch(owner: string): Promise<number | undefined> {
  return transact<number | undefined>("readwrite", undefined, (tx, done) => {
    const store = tx.objectStore("epochs"), request = store.get(owner);
    request.onsuccess = () => {
      const epoch = request.result || 0;
      if (request.result === undefined) store.put(epoch, owner);
      done(epoch);
    };
  });
}
export async function readPersistentAsset(owner: string, asset: string, variant: AssetVariant, epoch: number): Promise<Blob | undefined> {
  return transact<Blob | undefined>("readwrite", undefined, (tx, done) => {
    const current = tx.objectStore("epochs").get(owner);
    current.onsuccess = () => {
      if ((current.result || 0) !== epoch) return;
      const store = tx.objectStore("assets"), request = store.get(key(owner, asset, variant));
      request.onsuccess = () => {
        if (!request.result) return;
        const info = tx.objectStore("metadata").get(key(owner, asset, variant));
        info.onsuccess = () => {
          if (info.result) tx.objectStore("metadata").put({ ...info.result, touched: Date.now() });
          done(request.result.blob as Blob);
        };
      };
    };
  });
}
export async function readPersistentAssetWithEpoch(owner: string, asset: string, variant: AssetVariant): Promise<{ epoch?: number; blob?: Blob }> {
  return transact<{ epoch?: number; blob?: Blob }>("readwrite", {}, (tx, done) => {
    const epochs = tx.objectStore("epochs"), current = epochs.get(owner);
    current.onsuccess = () => {
      const epoch = current.result === undefined ? 0 : (current.result as number);
      if (current.result === undefined) epochs.put(epoch, owner);
      const k = key(owner, asset, variant);
      const request = tx.objectStore("assets").get(k);
      request.onsuccess = () => {
        if (!request.result) { done({ epoch }); return; }
        const info = tx.objectStore("metadata").get(k);
        info.onsuccess = () => {
          if (info.result) tx.objectStore("metadata").put({ ...info.result, touched: Date.now() });
          done({ epoch, blob: request.result.blob as Blob });
        };
      };
    };
  });
}
export async function writePersistentAsset(owner: string, asset: string, variant: AssetVariant, blob: Blob, epoch: number) {
  if (blob.size > MAX_BYTES) return;
  await transact("readwrite", undefined, (tx) => {
    const current = tx.objectStore("epochs").get(owner);
    current.onsuccess = () => {
      if ((current.result || 0) !== epoch) return;
      const store = tx.objectStore("assets"), metadata = tx.objectStore("metadata");
      const record: StoredAsset = { key: key(owner, asset, variant), owner, asset, size: blob.size, touched: Date.now() };
      try {
        store.put({ key: record.key, blob });
        metadata.put(record);
      } catch { tx.abort(); return; }
      const all = metadata.getAll();
      all.onsuccess = () => {
        const rows = all.result as StoredAsset[];
        let bytes = rows.reduce((sum, row) => sum + row.size, 0), count = rows.length;
        for (const row of rows.sort((a, b) => a.touched - b.touched)) {
          if (bytes <= MAX_BYTES && count <= MAX_ENTRIES) break;
          store.delete(row.key); metadata.delete(row.key); bytes -= row.size; count--;
        }
      };
    };
  });
}
export async function clearAllPersistentAssets() {
  await transact("readwrite", undefined, (tx) => {
    tx.objectStore("assets").clear();
    tx.objectStore("metadata").clear();
    const cursor = tx.objectStore("epochs").openCursor();
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (!row) return;
      if (typeof row.key === "string") row.update((Number(row.value) || 0) + 1);
      row.continue();
    };
  });
}
export async function clearPersistentAssets(owner: string, asset?: string): Promise<boolean> {
  return transact<boolean>("readwrite", false, (tx, done) => {
    const epochs = tx.objectStore("epochs"), current = epochs.get(owner);
    current.onsuccess = () => epochs.put((current.result || 0) + 1, owner);
    const store = tx.objectStore("metadata"), request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { done(true); return; }
      const row = cursor.value as StoredAsset;
      if (row.owner === owner && (asset === undefined || row.asset === asset)) { tx.objectStore("assets").delete(row.key); cursor.delete(); }
      cursor.continue();
    };
  });
}
export async function persistentAssetUsage(owner: string): Promise<CacheUsage> {
  return transact<CacheUsage>("readonly", { bytes: 0, count: 0, limit: MAX_BYTES, available: false }, (tx, done) => {
    const request = tx.objectStore("metadata").getAll();
    request.onsuccess = () => {
      const rows = (request.result as StoredAsset[]).filter(row => row.owner === owner);
      done({ bytes: rows.reduce((sum, row) => sum + row.size, 0), count: rows.length, limit: MAX_BYTES, available: true });
    };
  });
}
