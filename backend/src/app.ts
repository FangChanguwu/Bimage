import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { Store } from "./db.js";
import { mountAuthentication } from "./auth.js";
import { mountPublicSettings, mountSettings } from "./settings.js";
import { errorHandler } from "./http.js";
import { Providers } from "./providers.js";
import { Assets } from "./assets.js";
import { mountRewrite } from "./rewrite.js";
import { Queue } from "./queue.js";
export { validateUrl } from "./network.js";
import type { AppOptions } from "./types.js";

export async function createApp(options: AppOptions = {}) {
  const store = new Store(
    options.dir ?? process.env.DATA_DIR ?? path.resolve("data"),
    options.adminKey,
  );
  const app = express();
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "img-src": ["'self'", "data:", "blob:"],
          "script-src": ["'self'"],
          "style-src": ["'self'", "'unsafe-inline'"],
          "upgrade-insecure-requests": null,
        },
      },
    }),
  );
  app.use(express.json({ limit: "24mb" }));
  app.use(
    "/api",
    rateLimit({
      windowMs: 60000,
      limit: 180,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );
  app.get("/health", (_request, response) => response.json({ ok: true }));
  mountPublicSettings(app, store);
  mountAuthentication(app, store);
  mountSettings(app, store);
  const providers = new Providers(store);
  const assets = new Assets(store);
  const queue = new Queue(
    store,
    providers,
    assets,
    options.concurrency ?? 1,
    options.retryMs ?? 1000,
  );
  providers.mount(app, (provider) => queue.revokeShared(provider));
  assets.mount(app);
  mountRewrite(app, providers, assets);
  queue.mount(app);
  app.use("/api", (_request, response) =>
    response.status(404).json({ error: "接口不存在" }),
  );
  app.use(errorHandler);
  if (options.worker !== false) queue.start();
  let closing: Promise<void> | undefined;
  return {
    app,
    db: store.db,
    close() {
      return (closing ??= queue.shutdown(() => store.db.close()));
    },
  };
}
