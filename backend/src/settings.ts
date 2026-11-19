import type { Express } from "express";
import { Store } from "./db.js";
import { admin, body, fail, user } from "./http.js";

export const DEFAULT_SITE = { title: "Bimage", icon: "/Bimage.png" };
export function mountPublicSettings(app: Express, store: Store): void {
  app.get("/api/site", (_request, response) => {
    const saved = store.get<{ json: string }>(
      "SELECT json FROM settings WHERE owner='site'",
    );
    if (!saved) {
      response.json(DEFAULT_SITE);
      return;
    }
    const site = JSON.parse(saved.json) as { title: string; icon?: string };
    // Only the legacy default name is rebranded; custom titles/icons remain untouched.
    response.json({
      ...site,
      title: site.title === "Bi.mage" ? DEFAULT_SITE.title : site.title,
      icon: site.icon || DEFAULT_SITE.icon,
    });
  });
}
export function mountSettings(app: Express, store: Store): void {
  app.put("/api/admin/site", admin, (request, response) => {
    const { title, icon = "" } = body(request);
    if (
      typeof title !== "string" ||
      title.length > 100 ||
      !title.trim() ||
      typeof icon !== "string" ||
      !(
        icon === "" ||
        icon === "/Bimage.png" ||
        /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(icon)
      ) ||
      icon.length > 400000
    )
      throw fail(400, "标题或图标无效（PNG/JPEG/WebP，最大300KB）");
    store.run(
      "INSERT OR REPLACE INTO settings VALUES(?,?)",
      "site",
      JSON.stringify({ title, icon }),
    );
    response.json({ title, icon });
  });
  app.get("/api/settings", (request, response) =>
    response.json(
      JSON.parse(
        store.get<{ json: string }>(
          "SELECT json FROM settings WHERE owner=?",
          user(request).id,
        )?.json || "{}",
      ),
    ),
  );
  app.put("/api/settings", (request, response) => {
    store.run(
      "INSERT OR REPLACE INTO settings VALUES(?,?)",
      user(request).id,
      JSON.stringify(body(request)),
    );
    response.json({ ok: true });
  });
}
