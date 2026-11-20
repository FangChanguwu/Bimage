import { computed, onScopeDispose, ref, watch } from 'vue';
import type { Api, Job } from '../types';

interface HistoryPage {
  items?: Job[];
  total: number;
  nextCursor?: string | null;
  token: string;
  active: boolean;
  unchanged: boolean;
  removedIds?: string[];
}
/** A tenant-lifetime, serialized history stream. A missing page is never a deletion. */
export function useHistory(api: Api, signal: AbortSignal, removed?: (jobs: Job[]) => void) {
  const jobs = ref<Job[]>([]), query = ref(''), total = ref(0), hasActive = ref(false);
  const nextCursor = ref<string | null>(null), loadingMore = ref(false);
  const pending = new Set<string>(), deleted = new Set<string>();
  let alive = true, revision = 0, token = '', cursors: string[] = [], knownOffset = 0;
  let chain = Promise.resolve(), timer: ReturnType<typeof setTimeout> | undefined;
  let searchTimer: ReturnType<typeof setTimeout> | undefined, polling = false, started = false;
  const valid = (v: number) => alive && !signal.aborted && revision === v;
  const sorted = (values: Job[]) => values.sort((a, b) => b.created.localeCompare(a.created) || b.id.localeCompare(a.id));
  function merge(items: Job[]) {
    const records = new Map(jobs.value.map(j => [j.id, j]));
    for (const job of items) if (!deleted.has(job.id) && !pending.has(job.id)) records.set(job.id, job);
    jobs.value = sorted([...records.values()]);
  }
  function forget(ids: string[]) {
    const confirmed = new Set(ids), old = jobs.value.filter(j => confirmed.has(j.id));
    jobs.value = jobs.value.filter(j => !confirmed.has(j.id));
    for (const id of ids) deleted.add(id);
    if (old.length) removed?.(old);
  }
  function url(cursor?: string, version?: string, known?: string[]) {
    const p = new URLSearchParams({ limit: '30' });
    if (query.value) p.set('q', query.value);
    if (cursor) p.set('cursor', cursor);
    if (version) p.set('token', version);
    if (known?.length) p.set('known', JSON.stringify(known));
    return '/jobs?' + p;
  }
  function serialize(action: () => Promise<void>) {
    const result = chain.then(() => { if (alive && !signal.aborted) return action(); });
    chain = result.catch(() => {});
    return result;
  }
  async function refreshNow() {
    const v = revision;
    const known = jobs.value.slice(knownOffset, knownOffset + 100).map(j => j.id);
    knownOffset = knownOffset + 100 >= jobs.value.length ? 0 : knownOffset + 100;
    const first = await api<HistoryPage>(url(undefined, token, known));
    if (!valid(v)) return;
    total.value = first.total; hasActive.value = first.active;
    forget(first.removedIds ?? []);
    if (first.unchanged) return;
    const refreshed = new Set(first.items?.map(job => job.id));
    merge(first.items ?? []);
    // Refresh the windows already loaded, without dropping records displaced by new jobs.
    const refreshedCursors: string[] = [];
    let cursor = first.nextCursor ?? null;
    for (let index = 0; index < cursors.length && cursor; index++) {
      refreshedCursors.push(cursor);
      const part = await api<HistoryPage>(url(cursor));
      if (!valid(v)) return;
      for (const job of part.items ?? []) refreshed.add(job.id);
      merge(part.items ?? []);
      cursor = part.nextCursor ?? null;
    }
    // A burst of new jobs can displace an active card outside every loaded window.
    // Read that known owned record explicitly; never infer deletion from a gap.
    for (const job of jobs.value.filter(job => !refreshed.has(job.id) && job.tasks.some(task => ['queued', 'running'].includes(task.status)))) {
      const latest = await api<Job>('/jobs/' + encodeURIComponent(job.id));
      if (!valid(v)) return;
      merge([latest]);
    }
    cursors = refreshedCursors;
    nextCursor.value = cursor;
    token = first.token;
  }
  async function refresh() { await serialize(refreshNow); schedule(); }
  async function loadMore() {
    if (loadingMore.value || !nextCursor.value) return;
    loadingMore.value = true;
    try {
      await serialize(async () => {
        const cursor = nextCursor.value, v = revision;
        if (!cursor) return;
        const result = await api<HistoryPage>(url(cursor));
        if (!valid(v)) return;
        merge(result.items ?? []); total.value = result.total; hasActive.value = result.active;
        cursors.push(cursor); nextCursor.value = result.nextCursor ?? null;
      });
    } finally { loadingMore.value = false; schedule(); }
  }
  function schedule() {
    clearTimeout(timer);
    if (started && alive && !signal.aborted) timer = setTimeout(poll, document.hidden ? 60000 : hasActive.value ? 2200 : 25000);
  }
  async function poll() {
    if (polling || !alive || signal.aborted) return;
    polling = true;
    clearTimeout(timer);
    try { await serialize(refreshNow); } catch { /* session API owns authentication invalidation */ }
    finally { polling = false; schedule(); }
  }
  function foreground() { if (!document.hidden) void poll(); else schedule(); }
  function start() {
    if (started) return;
    started = true;
    window.addEventListener('focus', foreground);
    window.addEventListener('online', foreground);
    document.addEventListener('visibilitychange', foreground);
    schedule();
  }
  watch(query, () => {
    if (!alive || signal.aborted) return;
    revision++; token = ''; cursors = []; knownOffset = 0;
    jobs.value = []; total.value = 0; nextCursor.value = null;
    clearTimeout(searchTimer); clearTimeout(timer);
    searchTimer = setTimeout(() => { void refresh().catch(() => {}); }, 250);
  }, { flush: 'sync' });
  function beginMutation(id: string) { pending.add(id); revision++; token = ''; }
  function endMutation(id: string, job?: Job) {
    revision++; token = ''; pending.delete(id);
    if (job && !deleted.has(id) && jobs.value.some(current => current.id === id)) merge([job]);
    schedule();
  }
  function remove(id: string) {
    revision++; token = '';
    if (jobs.value.some(j => j.id === id)) total.value = Math.max(0, total.value - 1);
    forget([id]); schedule();
  }
  function stop() {
    alive = false; clearTimeout(timer); clearTimeout(searchTimer);
    window.removeEventListener('focus', foreground); window.removeEventListener('online', foreground);
    document.removeEventListener('visibilitychange', foreground);
    jobs.value = []; query.value = ''; total.value = 0;
  }
  signal.addEventListener('abort', stop, { once: true });
  onScopeDispose(() => { signal.removeEventListener('abort', stop); stop(); });
  return { jobs, query, total, hasActive, nextCursor, loadingMore,
    hasMore: computed(() => nextCursor.value !== null), refresh, loadMore, start, beginMutation, endMutation, remove };
}
