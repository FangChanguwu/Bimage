import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Store } from "./db.js";
import type { Assets } from "./assets.js";
import { body, fail, param, user } from "./http.js";
import type { AssetRow, FavoriteRow, ImageForm, JobRow, TaskRow } from "./types.js";

export class Favorites {
  constructor(
    private store: Store,
    private assets: Assets,
  ) {}

  private present(row: FavoriteRow) {
    const asset = this.store.get<Pick<AssetRow, "id" | "width" | "height" | "mime">>(
      "SELECT id,width,height,mime FROM assets WHERE id=? AND owner=?",
      row.asset,
      row.owner,
    );
    const measured = asset ? this.assets.measure(asset) : { width: null, height: null };
    return {
      id: row.id,
      asset: row.asset,
      mime: asset?.mime,
      width: measured.width,
      height: measured.height,
      jobId: row.jobId,
      taskId: row.taskId,
      form: JSON.parse(row.form) as ImageForm,
      jobCreated: row.jobCreated,
      createdAt: row.createdAt,
    };
  }

  private collectOrphanAssets(owner: string, candidates: Iterable<string>): string[] {
    const remove = this.store.db.prepare(`
      DELETE FROM assets AS a WHERE id=? AND owner=?
        AND NOT EXISTS (SELECT 1 FROM tasks WHERE asset=a.id)
        AND NOT EXISTS (SELECT 1 FROM favorites WHERE asset=a.id AND owner=a.owner)
        AND NOT EXISTS (
          SELECT 1 FROM jobs AS j,
            json_each(CASE WHEN json_valid(j.form) THEN j.form ELSE '{}' END, '$.references') AS ref
          WHERE j.owner=a.owner AND typeof(ref.key)='integer' AND ref.value=a.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM jobs AS j
          WHERE j.owner=a.owner AND json_valid(j.form) AND json_extract(j.form, '$.mask')=a.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM favorites AS f,
            json_each(CASE WHEN json_valid(f.form) THEN f.form ELSE '{}' END, '$.references') AS ref
          WHERE f.owner=a.owner AND typeof(ref.key)='integer' AND ref.value=a.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM favorites AS f
          WHERE f.owner=a.owner AND json_valid(f.form) AND json_extract(f.form, '$.mask')=a.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM settings AS s,
            json_each(CASE WHEN json_valid(s.json) THEN s.json ELSE '{}' END, '$.form.references') AS ref
          WHERE s.owner=a.owner AND typeof(ref.key)='integer' AND ref.value=a.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM settings AS s
          WHERE s.owner=a.owner AND json_valid(s.json) AND json_extract(s.json, '$.form.mask')=a.id
        )
      RETURNING id
    `);
    const deleted: string[] = [];
    for (const id of new Set(candidates)) {
      if (id && remove.get(id, owner)) deleted.push(id);
    }
    return deleted;
  }

  mount(app: Express): void {
    app.get("/api/favorites", (request, response) => {
      const owner = user(request).id;
      const rows = this.store.all<FavoriteRow>(
        "SELECT * FROM favorites WHERE owner=? ORDER BY createdAt DESC, id DESC",
        owner,
      );
      response.set("Cache-Control", "private, no-store");
      response.json({ items: rows.map((row) => this.present(row)) });
    });

    app.post("/api/favorites", (request, response) => {
      const owner = user(request).id;
      const input = body(request);
      const jobId = typeof input.jobId === "string" ? input.jobId.trim() : "";
      const taskId = typeof input.taskId === "string" ? input.taskId.trim() : "";
      if (!jobId || !taskId) throw fail(400, "收藏参数无效");

      const job = this.store.get<JobRow>(
        "SELECT * FROM jobs WHERE id=? AND owner=?",
        jobId,
        owner,
      );
      if (!job) throw fail(404, "任务不存在");

      const task = this.store.get<TaskRow>(
        "SELECT * FROM tasks WHERE id=? AND job=?",
        taskId,
        job.id,
      );
      if (!task || !task.asset) throw fail(404, "图片不存在");

      // Verify asset still exists and belongs to owner.
      this.assets.owned(task.asset, owner);

      const existing = this.store.get<FavoriteRow>(
        "SELECT * FROM favorites WHERE owner=? AND asset=?",
        owner,
        task.asset,
      );
      if (existing) {
        response.json(this.present(existing));
        return;
      }

      const id = randomUUID();
      const createdAt = new Date().toISOString();
      this.store.run(
        `INSERT INTO favorites(id,owner,asset,jobId,taskId,form,jobCreated,createdAt)
         VALUES(?,?,?,?,?,?,?,?)`,
        id,
        owner,
        task.asset,
        job.id,
        task.id,
        job.form,
        job.created,
        createdAt,
      );
      const row = this.store.get<FavoriteRow>("SELECT * FROM favorites WHERE id=?", id)!;
      response.status(201).json(this.present(row));
    });

    app.delete("/api/favorites/:asset", (request, response) => {
      const owner = user(request).id;
      const assetId = param(request, "asset");
      const deletedAssetIds = this.store.transaction(() => {
        const existing = this.store.get<FavoriteRow>(
          "SELECT * FROM favorites WHERE owner=? AND asset=?",
          owner,
          assetId,
        );
        if (!existing) return [];
        this.store.run("DELETE FROM favorites WHERE id=? AND owner=?", existing.id, owner);
        const candidates = [existing.asset];
        try {
          const parsed = JSON.parse(existing.form) as Partial<ImageForm>;
          if (Array.isArray(parsed.references)) {
            for (const ref of parsed.references) {
              if (typeof ref === "string") candidates.push(ref);
            }
          }
          if (typeof parsed.mask === "string") candidates.push(parsed.mask);
        } catch {
          /* Ignore malformed form JSON */
        }
        return this.collectOrphanAssets(owner, candidates);
      });
      response.json({ ok: true, asset: assetId, deletedAssetIds });
    });
  }
}
