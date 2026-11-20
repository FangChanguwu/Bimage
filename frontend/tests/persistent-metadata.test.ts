// @vitest-environment node
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { persistentEpoch, writePersistentAsset, readPersistentAsset, persistentAssetUsage, clearPersistentAssets } from '../src/composables/persistentAssets';
beforeEach(()=>vi.stubGlobal('indexedDB',new IDBFactory()));
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
it('eviction, usage and owner clearing inspect metadata only, never scan stored Blobs',async()=>{
  const scans:string[]=[];
  const all=IDBObjectStore.prototype.getAll;
  const cursor=IDBObjectStore.prototype.openCursor;
  vi.spyOn(IDBObjectStore.prototype,'getAll').mockImplementation(function(this:IDBObjectStore,...args:Parameters<typeof all>){scans.push(this.name);return all.apply(this,args);});
  vi.spyOn(IDBObjectStore.prototype,'openCursor').mockImplementation(function(this:IDBObjectStore,...args:Parameters<typeof cursor>){scans.push(this.name);return cursor.apply(this,args);});
  const epoch=(await persistentEpoch('a'))!;
  for(let i=0;i<30;i++) await writePersistentAsset('a',String(i),'thumbnail',new Blob(['test']),epoch);
  expect((await persistentAssetUsage('a')).count).toBe(30);
  expect((await readPersistentAsset('a','1','thumbnail',epoch))?.size).toBe(4);
  await clearPersistentAssets('a','1');
  expect((await persistentAssetUsage('a')).count).toBe(29);
  expect(scans).not.toContain('assets');
});
