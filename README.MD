<p align="center">
  <img src="frontend/public/Bimage.png" width="160" height="160" alt="Bimage logo" />
</p>

<h1 align="center">Bimage</h1>

<div align="center">

**A self-hosted AI image workbench.**

**English** · [简体中文](README_CN.MD)

![Version](https://img.shields.io/badge/version-0.3.1-blue)
![License](https://img.shields.io/badge/license-MIT-green)

</div>

## Overview

Connect your own OpenAI-compatible provider to generate images, edit them with references, and refine prompts. The workbench lets you queue jobs, search past prompts, and download the original images without leaving the page.

![English Bimage workbench with creation settings on the left and task history on the right](docs/preview-en.png)

## Features

- **Generate and edit images.** Use text or up to 16 reference images. Let the model pick the image dimensions, or set them yourself. Export as PNG, JPEG, or WebP.
- **Refine prompts.** Draft a prompt from a short brief or review suggested edits character by character before applying them.
- **Keep track of jobs.** Bimage saves progress and sends a separate request for each image. Cancel images that are still queued without interrupting those already in progress.
- **Revisit past work.** Search all prompts, load history in pages, restore job settings, and download originals individually or as a ZIP archive.
- **Load images efficiently.** Server-generated previews and account-scoped browser caching reduce repeated transfers. Clear local images in Settings; logout clears private cached data.
- **Manage workspaces.** Sign in with an account, share providers, and customize site branding. Administrators can create users and set their image-generation concurrency limits.
- **Switch languages.** Choose English or Simplified Chinese on the sign-in page or in the workbench sidebar. Bimage remembers your choice in the browser and keeps your current draft when you switch.

## Prompt optimization

Choose **Optimize** in the prompt editor to send the current prompt and any attached references to your configured text model. Bimage highlights additions and strikes through removals right in the editor. Edit the suggestion before choosing **Apply**, or choose **Cancel** to keep the original. Reviewing a suggestion does not queue an image job.

![English prompt optimization review showing highlighted additions, struck-through removals, and Cancel and Apply buttons](docs/prompt-refinement-en.png)

## Tech stack

- **Frontend:** Vue 3, TypeScript, and Vite
- **Backend:** Node.js, Express, and TypeScript
- **Database:** SQLite (`node:sqlite`)

## Quick start

### Requirements

- Local development: Node.js 24+ and npm.
- Container deployment: Docker and Docker Compose v2. You do not need Node.js on the host.

### Local development

In one terminal, install dependencies, build the API, and start it:

```bash
git clone https://github.com/FangChanguwu/Bimage.git
cd Bimage
npm ci
npm --prefix backend ci
npm --prefix frontend ci
npm --prefix backend run build
HOST=127.0.0.1 npm --prefix backend start
```

In a second terminal, open the repository directory and start the frontend:

```bash
npm --prefix frontend run dev
```

Open [http://127.0.0.1:5178](http://127.0.0.1:5178). For first-time setup, read the one-time code from `data/setup-code.txt` on the server and set your own password for `admin` in the web UI.

Sign in, open **Settings**, and add an OpenAI-compatible provider. In the Providers tab, choose independent defaults for image generation, quick prompts, and prompt optimization. You can skip text models if you only need image generation.

## Deployment

### Docker Compose

From the repository root, run:

```bash
cp .env.example .env
docker compose up -d --build --wait
```

The workbench is available at [http://localhost:6767](http://localhost:6767) by default. Compose does not publish a separate API port. Use the same one-time setup flow; for public deployments, use HTTPS and keep the upstream port private.

### Environment variables

- `BIMAGE_PORT`: host port for the workbench. Defaults to `6767`.
- `BIMAGE_COOKIE_SECURE`: set to `true` when serving Bimage behind an HTTPS reverse proxy. Keep it `false` for local HTTP testing.

Use HTTPS for public deployments. Back up `data/` and keep it out of Git because it contains job history, images, and provider credentials. See the [backend configuration](backend/README.md) and the [API reference (Chinese)](docs/API.md) for details.

## Build checks

After installing dependencies, run `npm run typecheck` and `npm run build` from the repository root to check and compile both services. Private development tests and their npm scripts are not included in the public deployment source.

## License

Bimage is licensed under the [MIT License](LICENSE).
