<p align="center">
  <img src="frontend/public/Bimage.png" width="144" height="144" alt="Bimage logo" />
</p>

<h1 align="center">Bimage</h1>

<div align="center">

**A self-hosted AI image workbench.**

**English** · [简体中文](README_CN.MD)

![Version](https://img.shields.io/badge/version-0.3.6-blue)
![License](https://img.shields.io/badge/license-MIT-green)

</div>

Connect your own OpenAI-compatible provider to generate images, edit with references, refine prompts, and manage task history in one workspace.

![Bimage workbench](docs/preview-en.png)

## Features

- **Generate & edit** — Text-to-image, reference editing (up to 16 images), one-click "Use as reference", pixel mask inpainting (`/images/edits` `mask`), auto or custom dimensions, and PNG / JPEG / WebP export.
- **Prompt optimization** — Draft prompts from short briefs or review inline word-level diffs before applying.
- **Persistent queue** — Submits one request per image and saves progress; cancel queued items without interrupting running ones.
- **History & Favorites** — Full-history prompt search, paginated loading, image Favorites gallery in sidebar (with full prompt, settings, references, and mask detail view), one-click settings restore, and original / batch ZIP downloads.
- **Fast loading** — Server-generated thumbnails with account-scoped browser cache (clearable in Settings; wiped on logout).
- **Multi-user & admin** — Account login, shared providers, custom branding, per-user concurrency limits, and admin-only GitHub update checks, one-click update to latest release, and version rollback.
- **Bilingual UI** — Instant English / Simplified Chinese switching with draft preservation.

![Prompt optimization diff view](docs/prompt-refinement-en.png)

## Deployment (Docker Compose)

Requires Docker and Docker Compose v2+ (`--wait`). Images are built locally from source.

```bash
git clone https://github.com/FangChanguwu/Bimage.git
cd Bimage
test -f .env || cp .env.example .env
# Edit .env if needed
docker compose build
docker compose up -d --wait
```

- **First-time setup:** Run `docker compose logs api` privately, open the one-time setup link, and create the first admin account.
- **Persistent data:** `./data` stores SQLite, images, and settings. Back it up before updates and do not run `docker compose down -v`.
- **HTTPS:** For public access, use a same-origin HTTPS reverse proxy, set `BIMAGE_PUBLIC_URL` to your public origin, `BIMAGE_COOKIE_SECURE=true`, and `BIMAGE_BIND_HOST=127.0.0.1`. See [backend/README.md](backend/README.md) for trusted proxy headers.

| Variable | Default | Description |
| --- | --- | --- |
| `BIMAGE_PORT` | `6767` | Published web port (API stays internal on `6768`). |
| `BIMAGE_PUBLIC_URL` | `http://localhost:6767` | Public HTTP(S) origin used for setup links (no path). |
| `BIMAGE_BIND_HOST` | `0.0.0.0` | Set to `127.0.0.1` when behind a local reverse proxy. |
| `BIMAGE_COOKIE_SECURE` | `false` | Set to `true` when served over HTTPS. |
| `BIMAGE_CONCURRENCY` | `8` | Site-wide image concurrency limit (1–8). |

### Update & rollback

Wait for running/queued jobs to finish and back up `./data` and `.env`, then update:

```bash
git pull --ff-only
docker compose build
docker compose up -d --force-recreate --wait
```

To roll back, stop the containers, restore the matching `./data` backup, check out the target tag (`git checkout <tag>`), and rebuild with the commands above.

## Local development

Requires Node.js 24+ and npm.

```bash
# Terminal 1: API
git clone https://github.com/FangChanguwu/Bimage.git
cd Bimage
npm ci && npm --prefix backend ci && npm --prefix frontend ci
npm --prefix backend run build
BIMAGE_PUBLIC_URL=http://127.0.0.1:5178 HOST=127.0.0.1 npm --prefix backend start
```

```bash
# Terminal 2: Frontend
npm --prefix frontend run dev
```

Open the setup link printed in the API terminal to create the first admin, then sign in at [http://127.0.0.1:5178](http://127.0.0.1:5178) and add an OpenAI-compatible provider in **Settings**. Run `npm run build` at the root to compile both services.

## Stack & Docs

- **Stack:** Vue 3 · TypeScript · Vite · Node.js · Express · SQLite (`node:sqlite`)
- **Docs:** [API Reference (ZH)](docs/API.md) · [Backend Configuration](backend/README.md) · [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
