# Bimage 后端

Independent Node.js TypeScript REST service. No frontend static files are served here.

```sh
npm ci
npm test
HOST=127.0.0.1 npm start
```

`npm test` compiles strict TypeScript, then runs backend tests against isolated SQLite databases and local HTTP mocks. The root `npm test` runs the compatibility suite separately. No real provider credentials or paid endpoints are used. `src/app.js` is a small compatibility export for historical tests; the implementation is TypeScript in `src/*.ts`, compiled to `dist/*.js`.

## Runtime configuration

- Node.js 24 or newer; verified with Node.js 26.
- `PORT`: internal API port, default `6768`.
- `HOST`: bind address, default `0.0.0.0`.
- `DATA_DIR`: database directory; defaults to the repository's `data/` for `npm start`.
- `ADMIN_KEY_FILE`: bootstrap secret output, default `$DATA_DIR/admin-key.txt`.
- `CONCURRENCY`: workers, clamped to 1–8, default 1. Does not limit the number of enqueued images.
- `COOKIE_SECURE=true`: HTTPS-only cookies. Leave unset for local HTTP tests.

When no `studio.sqlite` exists, the runtime generates an administrator secret into a new 0600 file. It refuses to overwrite an existing bootstrap file. When the database already exists, the bootstrap file is neither read nor written: administrator rotation stored in SQLite remains authoritative, including with obsolete/read-only secret mounts.

Use a same-origin reverse proxy on external port 6767, preserving the original Host header. `/api/*` and `/health` belong to this service. This backend does not configure or deploy the proxy. No credentials are logged. Bare HTTP does not protect access keys in transit.

## Compatibility and migration

Database filename, table names, original columns, identity IDs, hashes, session cookies, provider ownership/shared flags, settings JSON, asset bytes, jobs and task forms retain the legacy schema. Only missing metadata columns and the unique-admin partial index are added. Multiple legacy administrators cause startup refusal without selecting or disabling anyone. Prepare an explicit offline migration rather than silently selecting an administrator.

Site defaults are `title: "Bimage"`, `icon: "/Bimage.png"`. The exact legacy default title `Bi.mage` is mapped to `Bimage` on public reads; custom titles/icons are preserved. This mapping does not rewrite the stored site JSON. Empty icons resolve to the new default logo. Administrative site updates still allow custom PNG/JPEG/WebP data URIs.

The persistent queue stores every requested task and submits `n: 1` per image. Only explicit generation/edit HTTP 429 errors retry, at most three attempts. Unknown connection outcomes, timeouts, process interruptions, result download failures and other status codes never trigger automatic paid-request replay. Inflight tasks become interrupted on restart; queued tasks remain queued. Manual retry requires `confirm: true`, and cancellation must unwind before retry. Outputs are separate assets even if returned bytes match; upload deduplication is scoped to the owner.

`DELETE /api/jobs/:id` is owner-only, requires the normal session/CSRF checks, and returns `{ deletedAssetIds }`. It refuses queued or active jobs and transactions remove the job, child tasks and output images not used by other records or saved drafts. It does not purge backups.

## Modules

- `app.ts`: middleware and composition, public factory and lifecycle.
- `auth.ts`: session/CSRF/logout, administrator survival and transactional custom-key rotation.
- `db.ts`: compatible SQLite schema and typed query boundary.
- `providers.ts`, `models.ts`: secret-safe catalog and shared-provider management.
- `network.ts`: DNS-checked/pinned requests, redirect denial, bounded streaming.
- `queue.ts`: persistent jobs, execution, cancellation, retry and original-byte downloads.
- `assets.ts`: tenant ownership, byte-sniffed MIME, dimensions and metadata cache.
- `rewrite.ts`: vision references and cancellable prompt rewriting.
- `settings.ts`: site branding and tenant settings.
- `contracts/`: frontend-compatible API types and the single shared 16-reference limit.

Programmatic integration: `createApp({dir, adminKey, worker, concurrency, retryMs})` returns `{app, db, close}`. `close()` stops scheduling immediately and returns a promise that resolves after requests unwind and SQLite closes. Await it when an active service will immediately be reopened. `worker: false` allows deterministic queue/recovery inspection.
