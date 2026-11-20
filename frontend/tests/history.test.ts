import { afterEach, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { useHistory } from '../src/composables/useHistory';
import type { Api, Job } from '../src/types';

const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => { scopes.splice(0).forEach(s => s.stop()); vi.useRealTimers(); });
const job = (id: string) => ({ id, created: id, form: { prompt: id, references: [] }, tasks: [], status: 'succeeded' } as unknown as Job);
const page = (items: Job[], nextCursor: string | null = null, token = 'v1', active = false) => ({ items, total: 65, nextCursor, token, active, unchanged: false });
function setup(api: Api) {
  const scope = effectScope(); scopes.push(scope);
  return scope.run(() => useHistory(api, new AbortController().signal))!;
}
it('loads bounded pages and retains older records across a changed first page', async () => {
  const calls: string[] = [];
  const api = vi.fn(async (url: string) => {
    calls.push(url);
    if (url.startsWith('/jobs/')) return job('old');
    const query = new URLSearchParams(url.split('?')[1]);
    return query.has('cursor') ? page([job('old')], null, 'older') : page([job(calls.length > 2 ? 'new' : 'first')], 'older');
  }) as Api;
  const h = setup(api);
  await h.refresh();
  expect(calls[0]).toBe('/jobs?limit=30');
  await h.loadMore();
  expect(h.jobs.value.map(j => j.id)).toEqual(['old', 'first']);
  await h.refresh();
  expect(h.jobs.value.map(j => j.id)).toContain('old');
  expect(h.jobs.value.map(j => j.id)).toContain('first');
  expect(h.total.value).toBe(65);
});
it('debounces full prompt searches and rejects the previous query response', async () => {
  vi.useFakeTimers();
  let finish!: (value: unknown) => void;
  const api = vi.fn((url: string) => url.includes('q=') ? Promise.resolve(page([job('needle')])) : new Promise(resolve => finish = resolve)) as Api;
  const h = setup(api);
  const initial = h.refresh();
  await Promise.resolve();
  h.query.value = 'tail\n%_';
  await vi.advanceTimersByTimeAsync(250);
  finish(page([job('stale')])); await initial;
  await vi.advanceTimersByTimeAsync(0);
  expect(h.jobs.value.map(j => j.id)).toEqual(['needle']);
  expect(vi.mocked(api).mock.calls[1][0]).toContain('q=tail%0A%25_');
});
it('polls idle at 25s, busy at 2.2s and hidden at 60s; foreground is immediate and coalesced', async () => {
  vi.useFakeTimers();
  let active = false;
  const api = vi.fn(async () => page([job('a')], null, 'v', active)) as Api;
  const h = setup(api);
  await h.refresh(); h.start();
  await vi.advanceTimersByTimeAsync(5000); expect(api).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(20000); expect(api).toHaveBeenCalledTimes(2);
  active = true;
  window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online'));
  await vi.advanceTimersByTimeAsync(0); expect(api).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(2199); expect(api).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1); expect(api).toHaveBeenCalledTimes(4);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(59999); expect(api).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(1); expect(api).toHaveBeenCalledTimes(5);
  vi.restoreAllMocks();
});
it('does not overlap refresh/load-more requests and ignores stale cancel/delete snapshots', async () => {
  let resolve!: (value: unknown) => void;
  let calls = 0, concurrent = 0, maximum = 0;
  const api = vi.fn(async () => {
    maximum = Math.max(maximum, ++concurrent);
    const result = ++calls === 2 ? await new Promise(r => resolve = r) : page([job('a')], 'next');
    concurrent--; return result;
  }) as Api;
  const h = setup(api);
  await h.refresh();
  const stale = h.refresh(); await Promise.resolve(); await Promise.resolve();
  h.beginMutation('a');
  h.endMutation('a', { ...job('a'), status: 'cancelled' });
  resolve(page([job('a')], 'next')); await stale;
  expect(h.jobs.value[0].status).toBe('cancelled');
  const more = h.loadMore(); const refresh = h.refresh(); await Promise.all([more, refresh]);
  expect(maximum).toBe(1);
  h.remove('a'); await h.refresh();
  expect(h.jobs.value).toEqual([]);
});
it('only confirmed removed IDs evict records, including on unchanged polls', async () => {
  let changed = false;
  const removed = vi.fn();
  const api = vi.fn(async () => changed ? { token: 'v1', total: 0, active: false, unchanged: true, removedIds: ['a'] } : page([job('a')])) as Api;
  const scope = effectScope(); scopes.push(scope);
  const h = scope.run(() => useHistory(api, new AbortController().signal, removed))!;
  await h.refresh(); changed = true; await h.refresh();
  expect(h.jobs.value).toEqual([]); expect(removed).toHaveBeenCalledOnce();
  expect(vi.mocked(api).mock.calls[1][0]).toContain('known=');
});
it('retries older loaded windows after a partial refresh failure instead of accepting the new token', async () => {
  let fail = false, firstToken = 'initial';
  const api = vi.fn(async (url: string) => {
    const q = new URLSearchParams(url.split('?')[1]);
    if (q.has('cursor')) {
      if (fail) { fail = false; throw Error('offline'); }
      return page([job('older')]);
    }
    return q.get('token') === firstToken
      ? { unchanged: true, token: firstToken, total: 65, active: false }
      : page([job('first')], 'next', firstToken);
  }) as Api;
  const h = setup(api); await h.refresh(); await h.loadMore();
  firstToken = 'changed'; fail = true;
  await expect(h.refresh()).rejects.toThrow('offline');
  const before = vi.mocked(api).mock.calls.filter(([url]) => url.includes('cursor=')).length;
  await h.refresh();
  expect(vi.mocked(api).mock.calls.filter(([url]) => url.includes('cursor=')).length).toBe(before + 1);
});
it('refreshes a busy loaded record displaced beyond the new first page', async () => {
  let changed = false;
  const queued = { ...job('old'), tasks: [{ id: 't', status: 'queued' }], status: 'queued' };
  const api = vi.fn(async (url: string) => url.startsWith('/jobs/') ? { ...queued, tasks: [{ id: 't', status: 'succeeded' }], status: 'succeeded' } : page(changed ? [job('new')] : [queued])) as Api;
  const h = setup(api); await h.refresh(); changed = true; await h.refresh();
  expect(h.jobs.value.find(j => j.id === 'old')!.status).toBe('succeeded');
});
it('a cancel response cannot insert a nonmatching job after the search changes', async () => {
  const api = vi.fn(async () => page([job('old')])) as Api;
  const h = setup(api); await h.refresh(); h.beginMutation('old');
  h.query.value = 'different';
  h.endMutation('old', { ...job('old'), status: 'cancelled' });
  expect(h.jobs.value).toEqual([]);
});
it('refresh follows the new first-page cursor so inserts cannot leave a history gap', async () => {
  let changed = false;
  const api = vi.fn(async (url: string) => {
    const cursor = new URLSearchParams(url.split('?')[1]).get('cursor');
    if (cursor) return page([job(cursor)], null);
    return page([job(changed ? 'new' : 'first')], changed ? 'new-boundary' : 'old-boundary');
  }) as Api;
  const h = setup(api); await h.refresh(); await h.loadMore();
  changed = true; await h.refresh();
  expect(h.jobs.value.map(j => j.id)).toContain('new-boundary');
  expect(h.jobs.value.map(j => j.id)).toContain('old-boundary');
});
it('scope teardown cancels search timers and never publishes late tenant responses', async () => {
  vi.useFakeTimers();
  let finish!: (v: unknown) => void;
  const api = vi.fn(() => new Promise(r => finish = r)) as Api;
  const scope = effectScope(); scopes.push(scope);
  const h = scope.run(() => useHistory(api, new AbortController().signal))!;
  const first = h.refresh(); await Promise.resolve();
  h.query.value = 'pending'; scope.stop();
  expect(vi.getTimerCount()).toBe(0);
  finish(page([job('private')])); await first;
  expect(h.jobs.value).toEqual([]);
});
