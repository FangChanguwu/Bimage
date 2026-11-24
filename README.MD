<p align="center">
  <img src="frontend/public/Bimage.png" width="144" height="144" alt="Bimage logo" />
</p>

<h1 align="center">Bimage</h1>

<div align="center">

**A self-hosted AI image workbench.**

**English** · [简体中文](README_CN.MD)

![Version](https://img.shields.io/badge/version-0.4.3-blue)
![License](https://img.shields.io/badge/license-MIT-green)

</div>

Connect your own OpenAI-compatible provider to generate images, edit with references, refine prompts, and manage task history in one workspace.

![Bimage workbench](docs/preview-en.png)

## Features

- **Agent creation mode** — Conversational multi-turn workspace with reference image upload/paste, thinking effort & speed tier controls, editable batch generation plans, live queue gallery, automatic vision inspection & iterative retries, and curated deliverables.
- **Generate & edit** — Text-to-image, reference editing (up to 16 images), one-click **Use as reference** directly from task cards, lightbox, or favorites without re-uploading, auto or custom dimensions, and PNG / JPEG / WebP export.
- **Local repair & pixel mask inpainting** — Dual-mode editor supporting native transparent PNG pixel masks (`/images/edits` `mask`, with brush, eraser, rectangle/circle selection, invert, undo/redo) as well as freehand annotation guides.
- **Prompt optimization** — Draft prompts from short briefs or review inline word-level diffs before applying.
- **Favorites gallery & task details** — Star images from history or the lightbox into a dedicated sidebar pure-image gallery; click any artwork to inspect its full prompt, generation settings, reference images, and pixel mask, with asset GC protection even after the original job is deleted.
- **Persistent queue** — Submits one request per image and saves progress; cancel queued items without interrupting running ones.
- **History & fast loading** — Full-history prompt search, paginated loading, one-click settings restore, original / batch ZIP downloads, and server-generated thumbnails with account-scoped browser cache.
- **Multi-user & admin** — Account login, shared providers, custom branding, per-user concurrency limits, and admin-only GitHub update checks, in-container hot updates with automatic crash rollback, and one-click version rollback.
- **Bilingual UI** — Instant English / Simplified Chinese switching with draft preservation.

### Agent Creation Mode

Collaborate with an AI agent in multi-turn conversations with reference images, thinking effort and speed controls, editable batch generation plans, live gallery progress, automatic vision inspection, and curated deliverables.

![Agent creation mode](docs/agent-en.png)

### Prompt Optimization

Expand brief ideas or polish existing prompts with inline word-level diff previews before applying.

![Prompt optimization diff view](docs/prompt-refinement-en.png)

### Local Repair & Pixel Mask Inpainting

Paint mask regions with brush, eraser, rectangle, circle, or invert tools to generate transparent PNG masks for `/images/edits`, or switch to annotation guide mode for visual callouts.

![Local repair pixel mask inpainting](docs/inpainting-en.png)

### Favorites Gallery & Job Details

Browse saved artworks in a distraction-free image grid from the sidebar, and open any tile to inspect its prompt, parameters, reference images, and pixel mask, or reuse it as a reference in one click.

![Favorites gallery](docs/favorites-en.png)

![Favorite job details modal](docs/favorites-detail-en.png)

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
