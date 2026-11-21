# Bimage 后端

Independent Node.js TypeScript REST service. No frontend static files are served here.

```sh
npm ci
npm run build
HOST=127.0.0.1 npm start
```

`npm run build` compiles strict TypeScript from `src/*.ts` to `dist/*.js`; `npm run typecheck` checks types without emitting files. `src/app.js` remains a small compatibility export; the implementation is TypeScript.

## Runtime configuration

- Node.js 24 or newer; verified with Node.js 26.
- `PORT`: internal API port, default `6768`.
- `HOST`: bind address, default `0.0.0.0`.
- `DATA_DIR`: database directory; defaults to the repository's `data/` for `npm start`.
- `CONCURRENCY`: site-wide simultaneous image tasks (1–8); Compose defaults to 8. Each account has its own limit. Neither limit caps the number of enqueued images.
- `COOKIE_SECURE=true`: HTTPS-only cookies. Leave unset for local HTTP.
- `BIMAGE_PUBLIC_URL`: trusted HTTP(S) origin for the first administrator setup link, default `http://localhost:6767`. No path, credentials, query or fragment; use the actual frontend address, not the internal API port. Local Vite uses `http://127.0.0.1:5178`.
- `TRUSTED_WEB_PROXY_IP`: optional exact socket address of the private web proxy. Only that peer can provide the client IP for rate limits. Leave unset for direct API access. Configure nginx to trust only the ingress peer in `bimage-ingress*.inc` and have that ingress overwrite `X-Real-IP`; do not enable this on a publicly reachable backend.

Before initialization, the service console prints a private link with a one-time `setup_token` parameter. Read it privately with `docker compose logs api`, open it and submit an email and password (at least 5 characters) to create the first administrator. The link is built only from `BIMAGE_PUBLIC_URL`, never a request's Host header. Its 256-bit secret persists in `$DATA_DIR/setup-code.txt` (0600) across restarts and is removed after setup; SQLite serializes competing requests. Merely opening the link never consumes it. Existing accounts and sessions remain unchanged, including older `admin` logins, and no public registration is available. The page strips the parameter immediately, stores it only in memory and uses `no-referrer`; refresh requires reopening the console link. Protect console logs and omit query strings and Referer in any outer proxy logs. Never share the setup link or password.

Use a same-origin HTTPS reverse proxy preserving the original Host header, and bind the Compose web upstream to loopback on production hosts. `/api/*` and `/health` belong to this service. Bare HTTP does not protect login credentials or the setup link.

## Compatibility and migration

Back up SQLite and drain the image queue before upgrading an existing site. Migration refuses to proceed while legacy tasks are queued or running. Old key login, Bearer authentication and legacy sessions are disabled. The first administrator keeps the previous administrator's identity and data when migrating from access keys. Legacy member data remains stored but inactive; the retired workspace-association feature is not available, and newly created users always receive new identities. Nothing changes the ownership of providers, settings, jobs or assets during account migration.

Site defaults are `title: "Bimage"`, `icon: "/Bimage.png"`. The exact legacy default title `Bi.mage` is mapped to `Bimage` on public reads; custom titles/icons are preserved. This mapping does not rewrite the stored site JSON. Empty icons resolve to the new default logo. Administrative site updates still allow custom PNG/JPEG/WebP data URIs.

The persistent queue stores every requested task and submits `n: 1` per image. Only explicit generation/edit HTTP 429 errors retry, at most three attempts. Unknown connection outcomes, timeouts, process interruptions, result download failures and other status codes never trigger automatic paid-request replay. Inflight tasks become interrupted on restart; queued tasks remain queued. Manual retry requires `confirm: true`, and cancellation must unwind before retry. Outputs are separate assets even if returned bytes match; upload deduplication is scoped to the owner.

`DELETE /api/jobs/:id` is owner-only, requires the normal session/CSRF checks, and returns `{ deletedAssetIds }`. It refuses queued or active jobs and transactions remove the job, child tasks and output images not used by other records or saved drafts. It does not purge backups.

## Modules

- `app.ts`: middleware and composition, public factory and lifecycle.
- `auth.ts`: administrator setup, account login, session/CSRF/logout and administrative user management.
- `db.ts`: compatible SQLite schema and typed query boundary.
- `providers.ts`, `models.ts`: secret-safe catalog and shared-provider management.
- `network.ts`: DNS-checked/pinned requests, redirect denial, bounded streaming.
- `queue.ts`: persistent jobs, execution, cancellation, retry and original-byte downloads.
- `assets.ts`: tenant ownership, byte-sniffed MIME, dimensions and metadata cache.
- `rewrite.ts`: vision references and cancellable prompt rewriting.
- `settings.ts`: site branding and tenant settings.
- `contracts/`: frontend-compatible API types and the single shared 16-reference limit.

Programmatic integration: `createApp({dir, worker, concurrency, retryMs})` returns `{app, db, close, setupLink}`; `setupLink` is private and must not be returned in an HTTP response. `close()` stops scheduling immediately and returns a promise that resolves after requests unwind and SQLite closes. Await it when an active service will immediately be reopened. `worker: false` allows deterministic queue/recovery inspection.
