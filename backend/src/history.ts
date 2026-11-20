import { createHash } from 'node:crypto';
import type { Store } from './db.js';
import type { JobRow } from './types.js';
import { fail } from './http.js';

type Cursor = { created: string; id: string };
function encode(row: Cursor): string {
  return Buffer.from(JSON.stringify({ created: row.created, id: row.id })).toString('base64url');
}
function decode(value: unknown): Cursor | undefined {
  if (value === undefined) return;
  try {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(value)) throw Error();
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString()) as Cursor;
    if (!parsed || typeof parsed.created !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(parsed.created) || !Number.isFinite(Date.parse(parsed.created)) || typeof parsed.id !== 'string' || !parsed.id || parsed.id.length > 256 || encode(parsed) !== value) throw Error();
    return parsed;
  } catch { throw fail(400, '历史游标无效'); }
}
/** Owner-scoped, stable keyset history. No OFFSET or asset materialization for other pages. */
export class History {
  constructor(private store: Store) {
    store.db.function('history_contains', { deterministic: true }, (prompt, query) => typeof prompt === 'string' && typeof query === 'string' && prompt.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ? 1 : 0);
    store.db.exec('CREATE INDEX IF NOT EXISTS jobs_history ON jobs(owner,created DESC,id DESC)');
  }
  page(owner: string, query: Record<string, unknown>) {
    const rawLimit = query.limit === undefined ? '30' : query.limit;
    if (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit) || +rawLimit < 1 || +rawLimit > 100) throw fail(400, '历史页大小范围1–100');
    const cursor = decode(query.cursor), limit = +rawLimit;
    if (query.q !== undefined && (typeof query.q !== 'string' || query.q.length > 16000)) throw fail(400, '搜索词无效');
    const search = typeof query.q === 'string' ? query.q : '';
    const where = `owner=?${search ? " AND history_contains(json_extract(form,'$.prompt'),?)=1" : ''}`;
    const values = search ? [owner, search] : [owner];
    let known: string[] = [];
    if (query.known !== undefined) {
      try {
        if (typeof query.known !== 'string' || query.known.length > 26000) throw Error();
        const parsed: unknown = JSON.parse(query.known);
        if (!Array.isArray(parsed) || parsed.length > 100 || parsed.some(id => typeof id !== 'string' || !id || id.length > 256)) throw Error();
        known = [...new Set(parsed as string[])];
      } catch { throw fail(400, '历史记录校验无效'); }
    }
    const existing = new Set(known.length ? this.store.all<{ id: string }>(`SELECT id FROM jobs WHERE owner=? AND id IN (${known.map(() => '?').join(',')})`, owner, ...known).map(row => row.id) : []);
    const removedIds = known.filter(id => !existing.has(id));
    const total = this.store.get<{ n: number }>(`SELECT count(*) n FROM jobs WHERE ${where}`, ...values)!.n;
    const activeCount = this.store.get<{ n: number }>("SELECT count(*) n FROM tasks JOIN jobs ON jobs.id=tasks.job WHERE jobs.owner=? AND tasks.status IN ('queued','running')", owner)!.n;
    const active = activeCount > 0;
    if (query.token !== undefined && (typeof query.token !== 'string' || query.token.length > 128)) throw fail(400, '历史令牌无效');
    // Immutable job prompts need not be transferred or parsed to check a poll.
    // Include all owner task states so active work outside this page is detected.
    const revision = this.store.all(`SELECT j.id,j.status,j.created,j.startedAt,j.finishedAt,t.id task,t.status state,t.attempts,t.next,t.asset,t.error,t.startedAt taskStarted,t.finishedAt taskFinished FROM jobs j LEFT JOIN tasks t ON t.job=j.id WHERE j.owner=? ORDER BY j.id,t.id`, owner);
    const token = createHash('sha256').update(JSON.stringify([owner, search, limit, query.cursor ?? null, revision])).digest('hex');
    if (query.token === token) return { items: undefined, total, active, activeCount, removedIds, nextCursor: undefined, token, unchanged: true };
    const rows = this.store.all<JobRow>(`SELECT * FROM jobs WHERE ${where} ${cursor ? 'AND (created < ? OR (created = ? AND id < ?))' : ''} ORDER BY created DESC,id DESC LIMIT ?`, ...values, ...(cursor ? [cursor.created, cursor.created, cursor.id] : []), limit + 1);
    const items = rows.slice(0, limit);
    return { items, total, active, activeCount, removedIds, token, unchanged: false, nextCursor: rows.length > limit ? encode(items[items.length - 1]) : null };
  }
}
