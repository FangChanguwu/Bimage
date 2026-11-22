import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { existsSync } from "node:fs";
import path from "node:path";
import { Store } from "./db.js";
import { mountAuthentication } from "./auth.js";
import { SetupCode } from "./account-setup.js";
import { mountPublicSettings, mountSettings } from "./settings.js";
import { errorHandler } from "./http.js";
import { Providers } from "./providers.js";
import { Assets } from "./assets.js";
import { mountRewrite } from "./rewrite.js";
import { Queue } from "./queue.js";
import { Favorites } from "./favorites.js";
import { AgentService } from "./agent.js";
import { mountVersion, readCurrentVersion } from "./version.js";
import { clientRateLimitKey } from "./client-rate-limit.js";
import type { ProviderNetwork } from "./network.js";
export { validateUrl } from "./network.js";
import type { AppOptions } from "./types.js";

export async function createApp(
  options: AppOptions & { trustedWebProxyIp?: string; providerNetwork?: ProviderNetwork } = {},
) {
  const keyGenerator = clientRateLimitKey(
    options.trustedWebProxyIp ?? process.env.TRUSTED_WEB_PROXY_IP,
  );
  const dir = options.dir ?? process.env.DATA_DIR ?? path.resolve("data");
  const store = new Store(dir);
  let installer: SetupCode;
  try {
    installer = new SetupCode(store, dir);
  } catch (error) {
    store.db.close();
    throw error;
  }
  const app = express();
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "img-src": ["'self'", "data:", "blob:"],
          "connect-src": ["'self'", "data:", "blob:"],
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
      keyGenerator,
      windowMs: 60000,
      limit: 180,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );
  app.get("/health", (_request, response) =>
    response.json({ ok: true, version: readCurrentVersion() }),
  );
  mountPublicSettings(app, store);
  mountAuthentication(app, store, installer, keyGenerator);
  mountSettings(app, store);
  mountVersion(app, store, keyGenerator, {
    dataDir: dir,
    onRestart: options.onRestart,
  });
  const providers = new Providers(store, options.providerNetwork);
  const assets = new Assets(store);
  const queue = new Queue(
    store,
    providers,
    assets,
    options.concurrency ?? 1,
    options.retryMs ?? 1000,
  );
  providers.mount(app, (provider) => queue.revokeShared(provider), keyGenerator);
  assets.mount(app);
  mountRewrite(app, providers, assets, keyGenerator);
  queue.mount(app);
  const agent = new AgentService(store, providers, assets, queue);
  agent.mount(app);
  new Favorites(store, assets).mount(app);
  app.use("/api", (_request, response) =>
    response.status(404).json({ error: "接口不存在" }),
  );
  const frontendDir = path.resolve(
    options.frontendDir ??
      process.env.BIMAGE_FRONTEND_DIR ??
      path.resolve(import.meta.dirname, "../../frontend/dist"),
  );
  const indexHtml = path.join(frontendDir, "index.html");
  if (existsSync(indexHtml)) {
    const assetsDir = path.join(frontendDir, "assets");
    if (existsSync(assetsDir)) {
      app.use(
        "/assets",
        express.static(assetsDir, {
          immutable: true,
          maxAge: "1y",
          fallthrough: false,
        }),
      );
    }
    app.use(
      express.static(frontendDir, {
        index: false,
        setHeaders(response) {
          response.setHeader("Referrer-Policy", "no-referrer");
        },
      }),
    );
    app.get(/^\/(?!api(?:\/|$)).*/, (_request, response) => {
      response.setHeader("Cache-Control", "no-cache");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.sendFile(indexHtml);
    });
  }
  app.use(errorHandler);
  if (options.worker !== false) queue.start();
  let closing: Promise<void> | undefined;
  return {
    app,
    db: store.db,
    get setupLink() { return installer.link; },
    close() {
      agent.shutdown();
      return (closing ??= queue.shutdown(() => store.db.close()));
    },
  };
}
