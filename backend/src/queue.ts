import { randomUUID } from "node:crypto";
import { FormData } from "undici";
import { zipSync } from "fflate";
import type { Express } from "express";
import { Store } from "./db.js";
import { Assets, detectMime } from "./assets.js";
import { Providers } from "./providers.js";
import { body, fail, HttpError, object, param, user } from "./http.js";
import { validKey } from "./auth.js";
import { limited, safeFetch, upstream } from "./network.js";
import { MAX_REFERENCE_IMAGES } from "./limits.js";
import type {
  AssetRow,
  ImageForm,
  JobRow,
  KeyRow,
  ProviderRow,
  TaskRow,
  TaskStatus,
} from "./types.js";

export class Queue {
  private controllers = new Map<string, AbortController>();
  private active = 0;
  private closed = false;
  private timer?: ReturnType<typeof setInterval>;
  private executions = new Set<Promise<void>>();
  constructor(
    private store: Store,
    private providers: Providers,
    private assets: Assets,
    private concurrency = 1,
    private retryMs = 1000,
  ) {
    store.run(
      "UPDATE tasks SET status='interrupted',error='服务重启；上游可能已收费，请核对后手动重试' WHERE status='running'",
    );
    for (const job of store.all<{ id: string }>("SELECT id FROM jobs"))
      this.refresh(job.id);
  }
  start(): void {
    this.timer = setInterval(() => {
      if (this.closed) return;
      const capacity = Math.max(0, this.concurrency - this.active);
      const tasks = this.store.all<TaskRow>(
        "SELECT * FROM tasks WHERE status='queued' AND next<=? ORDER BY rowid LIMIT ?",
        Date.now(),
        capacity,
      );
      for (const task of tasks) {
        const execution = this.run(task);
        this.executions.add(execution);
        void execution.finally(() => this.executions.delete(execution));
      }
    }, 100);
  }
  /** Stop scheduling synchronously; defer closing SQLite until aborted requests unwind. */
  shutdown(onIdle: () => void): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const controller of this.controllers.values()) controller.abort();
    if (!this.executions.size) {
      onIdle();
      return Promise.resolve();
    }
    return Promise.allSettled([...this.executions]).then(() => {
      onIdle();
    });
  }
  validate(input: unknown, identity: KeyRow): ImageForm {
    const form = object(input);
    this.providers.usable(form.providerId, identity);
    if (
      typeof form.prompt !== "string" ||
      !form.prompt.trim() ||
      form.prompt.length > 16000 ||
      typeof form.model !== "string" ||
      !form.model ||
      form.model.length > 200
    )
      throw fail(400, "请填写图像供应商、模型和提示词");
    if (form.autoSize !== undefined && typeof form.autoSize !== "boolean")
      throw fail(400, "自动规格参数无效");
    if (
      typeof form.count !== "number" ||
      !Number.isInteger(form.count) ||
      form.count < 1 ||
      form.count > 16
    )
      throw fail(400, "张数1–16");
    if (form.autoSize !== true) {
      if (typeof form.size !== "string" || !/^\d{2,5}x\d{2,5}$/.test(form.size))
        throw fail(400, "分辨率格式为宽x高");
      const [width, height] = form.size.split("x").map(Number);
      if (width < 64 || height < 64 || width > 8192 || height > 8192)
        throw fail(400, "分辨率范围64–8192");
    }
    if (
      typeof form.quality !== "string" ||
      !["auto", "low", "medium", "high", "standard", "hd"].includes(
        form.quality,
      ) ||
      typeof form.output_format !== "string" ||
      !["png", "jpeg", "webp"].includes(form.output_format)
    )
      throw fail(400, "质量或格式无效");
    if (
      !Array.isArray(form.references) ||
      form.references.length > MAX_REFERENCE_IMAGES
    )
      throw fail(400, `参考图最多${MAX_REFERENCE_IMAGES}张`);
    for (const id of form.references) this.assets.owned(id, identity.id);
    return form as ImageForm;
  }
  ownJob(id: string, identity: KeyRow): JobRow {
    const job = this.store.get<JobRow>("SELECT * FROM jobs WHERE id=?", id);
    if (!job || (job.owner !== identity.id && identity.role !== "admin"))
      throw fail(404, "任务不存在");
    return job;
  }
  view(job: JobRow) {
    const tasks = this.store
      .all<TaskRow>("SELECT * FROM tasks WHERE job=? ORDER BY rowid", job.id)
      .map((task) => {
        const asset = task.asset
          ? this.store.get<Pick<AssetRow, "id" | "width" | "height" | "mime">>(
              "SELECT id,width,height,mime FROM assets WHERE id=? AND owner=?",
              task.asset,
              job.owner,
            )
          : undefined;
        return {
          ...task,
          ...(asset ? { ...this.assets.measure(asset), mime: asset.mime } : {}),
        };
      });
    return { ...job, form: JSON.parse(job.form) as ImageForm, tasks };
  }
  refresh(id: string): void {
    const states = this.store
      .all<{ status: TaskStatus }>("SELECT status FROM tasks WHERE job=?", id)
      .map((task) => task.status);
    const status: TaskStatus = states.includes("running")
      ? "running"
      : states.includes("queued")
        ? "queued"
        : states.includes("succeeded") &&
            states.every((state) => state === "succeeded" || state === "cancelled")
          ? "succeeded"
          : states.every((state) => state === "cancelled")
            ? "cancelled"
            : states.includes("interrupted")
              ? "interrupted"
              : "failed";
    const now = new Date().toISOString();
    this.store.run(
      "UPDATE jobs SET status=?,startedAt=CASE WHEN ?='running' THEN COALESCE(startedAt,?) ELSE startedAt END,finishedAt=CASE WHEN ? IN ('queued','running') THEN NULL ELSE COALESCE(finishedAt,?) END WHERE id=?",
      status,
      status,
      now,
      status,
      now,
      id,
    );
    this.store.run(
      "UPDATE tasks SET finishedAt=COALESCE(finishedAt,?) WHERE job=? AND status NOT IN ('queued','running')",
      now,
      id,
    );
  }
  revokeShared(provider: ProviderRow): void {
    for (const job of this.store.all<JobRow>(
      "SELECT * FROM jobs WHERE owner<>?",
      provider.owner,
    )) {
      const form = JSON.parse(job.form) as ImageForm;
      if (form.providerId !== provider.id) continue;
      this.store.run(
        "UPDATE tasks SET status='cancelled',error='供应商共享已撤销；未提交上游的任务已取消' WHERE job=? AND status='queued'",
        job.id,
      );
      this.refresh(job.id);
    }
  }
  private async imageRequest(
    form: ImageForm,
    owner: string,
    provider: ProviderRow,
    signal: AbortSignal,
  ): Promise<{ bytes: Buffer; mime: string }> {
    const fields = {
      model: form.model,
      prompt: form.prompt,
      n: 1,
      ...(form.autoSize === true ? {} : { size: form.size }),
      quality: form.quality,
      output_format: form.output_format,
    };
    let payload: Record<string, unknown> | FormData = fields;
    let endpoint = "/images/generations";
    if (form.references.length) {
      endpoint = "/images/edits";
      const multipart = new FormData();
      for (const [name, value] of Object.entries(fields))
        multipart.append(name, String(value));
      for (const id of form.references) {
        const asset = this.assets.owned(id, owner);
        multipart.append(
          "image[]",
          new Blob([new Uint8Array(asset.bytes)], { type: asset.mime }),
          id + "." + asset.mime.split("/")[1],
        );
      }
      payload = multipart;
    }
    const result = await upstream(provider, endpoint, payload, signal);
    const image =
      Array.isArray(result.data) && result.data[0]
        ? object(result.data[0])
        : {};
    let bytes: Buffer;
    if (typeof image.b64_json === "string") {
      if (image.b64_json.length > 32 * 1024 * 1024)
        throw new Error("图片响应过大");
      bytes = Buffer.from(image.b64_json, "base64");
    } else if (typeof image.url === "string") {
      const response = await safeFetch(
        image.url,
        { signal },
        !!provider.allowPrivate,
      );
      if (!response.ok) throw new Error("图片下载失败");
      bytes = await limited(response, 24 * 1024 * 1024);
    } else throw new Error("上游没有返回图片");
    const mime = detectMime(bytes);
    if (!mime) throw new Error("上游返回了无效图片");
    return { bytes, mime };
  }
  private async run(task: TaskRow): Promise<void> {
    this.active++;
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    this.store.run(
      "UPDATE tasks SET status='running',attempts=attempts+1,startedAt=COALESCE(startedAt,?),finishedAt=NULL WHERE id=?",
      new Date().toISOString(),
      task.id,
    );
    this.refresh(task.job);
    try {
      const job = this.store.get<JobRow>(
        "SELECT * FROM jobs WHERE id=?",
        task.job,
      )!;
      const identity = this.store.get<KeyRow>(
        "SELECT * FROM keys WHERE id=?",
        job.owner,
      );
      if (!validKey(identity)) throw new Error("访问密钥已失效");
      const form = JSON.parse(job.form) as ImageForm;
      // Recheck sharing at dequeue, not just submission.
      const provider = this.providers.usable(form.providerId, identity);
      const { bytes, mime } = await this.imageRequest(
        form,
        job.owner,
        provider,
        controller.signal,
      );
      if (this.closed) return;
      const state = this.store.get<{ status: TaskStatus }>(
        "SELECT status FROM tasks WHERE id=?",
        task.id,
      );
      if (state?.status === "running") {
        const asset = this.assets.save(job.owner, bytes, mime);
        this.store.run(
          "UPDATE tasks SET status='succeeded',asset=?,error=NULL WHERE id=?",
          asset,
          task.id,
        );
      }
    } catch (error) {
      if (this.closed) return; // Keep inflight as running; restart must mark it interrupted.
      const state = this.store.get<Pick<TaskRow, "status" | "attempts">>(
        "SELECT status,attempts FROM tasks WHERE id=?",
        task.id,
      );
      if (state?.status === "running") {
        if (
          error instanceof HttpError &&
          error.status === 429 &&
          state.attempts < 3
        ) {
          this.store.run(
            "UPDATE tasks SET status='queued',next=?,error=? WHERE id=?",
            Date.now() + this.retryMs * state.attempts,
            error.message,
            task.id,
          );
        } else
          this.store.run(
            "UPDATE tasks SET status='failed',error=? WHERE id=?",
            error instanceof Error ? error.message : "上游请求失败",
            task.id,
          );
      }
    } finally {
      if (!this.closed) this.refresh(task.job);
      this.controllers.delete(task.id);
      this.active--;
    }
  }
  private deleteJob(id: string, owner: string): string[] {
    return this.store.transaction(() => {
      // Unlike read access via ownJob(), hard deletion never grants an admin override.
      const job = this.store.get<Pick<JobRow, "status">>(
        "SELECT status FROM jobs WHERE id=? AND owner=?",
        id,
        owner,
      );
      if (!job) throw fail(404, "任务不存在");
      const tasks = this.store.all<Pick<TaskRow, "id" | "status" | "asset">>(
        "SELECT id,status,asset FROM tasks WHERE job=? ORDER BY rowid",
        id,
      );
      if (
        job.status === "queued" ||
        job.status === "running" ||
        tasks.some(
          (task) =>
            task.status === "queued" ||
            task.status === "running" ||
            this.controllers.has(task.id),
        )
      )
        throw fail(409, "任务尚未结束，请取消或等待任务结束后再删除");

      this.store.run("DELETE FROM tasks WHERE job=?", id);
      this.store.run("DELETE FROM jobs WHERE id=? AND owner=?", id, owner);

      // Only collect this job's output IDs, and keep any still used by a task,
      // other job's reference list, or the owner's saved draft.
      const remove = this.store.db.prepare(`
        DELETE FROM assets AS a WHERE id=? AND owner=?
          AND NOT EXISTS (SELECT 1 FROM tasks WHERE asset=a.id)
          AND NOT EXISTS (
            SELECT 1 FROM jobs AS j,
              json_each(CASE WHEN json_valid(j.form) THEN j.form ELSE '{}' END, '$.references') AS ref
            WHERE j.owner=a.owner AND typeof(ref.key)='integer' AND ref.value=a.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM settings AS s,
              json_each(CASE WHEN json_valid(s.json) THEN s.json ELSE '{}' END, '$.form.references') AS ref
            WHERE s.owner=a.owner AND typeof(ref.key)='integer' AND ref.value=a.id
          )
        RETURNING id
      `);
      const deleted: string[] = [];
      for (const asset of new Set(tasks.map((task) => task.asset))) {
        if (asset && remove.get(asset, owner)) deleted.push(asset);
      }
      return deleted;
    });
  }
  mount(app: Express): void {
    app.post("/api/jobs", (request, response) => {
      const identity = user(request),
        form = this.validate(body(request), identity),
        id = randomUUID();
      this.store.transaction(() => {
        this.store.run(
          "INSERT INTO jobs(id,owner,form,status,created) VALUES(?,?,?,?,?)",
          id,
          identity.id,
          JSON.stringify(form),
          "queued",
          new Date().toISOString(),
        );
        for (let index = 0; index < form.count; index++)
          this.store.run(
            "INSERT INTO tasks(id,job,status) VALUES(?,?,?)",
            randomUUID(),
            id,
            "queued",
          );
      });
      response.json(this.view(this.ownJob(id, identity)));
    });
    app.get("/api/jobs", (request, response) =>
      response.json(
        this.store
          .all<JobRow>(
            "SELECT * FROM jobs WHERE owner=? ORDER BY created DESC",
            user(request).id,
          )
          .map((job) => this.view(job)),
      ),
    );
    app.get("/api/jobs/:id", (request, response) =>
      response.json(this.view(this.ownJob(param(request), user(request)))),
    );
    app.delete("/api/jobs/:id", (request, response) => {
      try {
        const deletedAssetIds = this.deleteJob(
          param(request),
          user(request).id,
        );
        response.json({ deletedAssetIds });
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw fail(500, "删除任务失败");
      }
    });
    app.get("/api/jobs/:id/download", (request, response) => {
      const job = this.ownJob(param(request), user(request));
      const assets = this.store.all<AssetRow>(
        "SELECT a.* FROM tasks t JOIN assets a ON a.id=t.asset WHERE t.job=? AND t.status='succeeded' AND a.owner=? ORDER BY t.rowid",
        job.id,
        job.owner,
      );
      if (!assets.length) throw fail(404, "暂无可下载图片");
      if (
        assets.reduce((total, asset) => total + asset.bytes.length, 0) >
        128 * 1024 * 1024
      )
        throw fail(413, "归档超过128MB，请逐张下载");
      response.set("Cache-Control", "private, no-store");
      if (assets.length === 1) {
        const asset = assets[0];
        response
          .attachment(`image-${job.id}.${asset.mime.split("/")[1]}`)
          .type(asset.mime)
          .send(Buffer.from(asset.bytes));
      } else {
        const entries = Object.fromEntries(
          assets.map((asset, index) => [
            `${index + 1}-${asset.id}.${asset.mime.split("/")[1]}`,
            new Uint8Array(asset.bytes),
          ]),
        );
        response
          .attachment(`images-${job.id}.zip`)
          .type("application/zip")
          .send(Buffer.from(zipSync(entries, { level: 0 })));
      }
    });
    app.post("/api/jobs/:id/cancel", (request, response) => {
      const identity = user(request),
        job = this.ownJob(param(request), identity);
      const cancelledCount = this.store.transaction(() => {
        // Running tasks already belong to the worker; let them finish and save their results.
        const cancelled = this.store.all<{ id: string }>(
          "UPDATE tasks SET status='cancelled',error=NULL WHERE job=? AND status='queued' RETURNING id",
          job.id,
        ).length;
        if (cancelled) this.refresh(job.id);
        return cancelled;
      });
      response.json({ ...this.view(this.ownJob(job.id, identity)), cancelledCount });
    });
    app.post("/api/jobs/:id/retry", (request, response) => {
      if (body(request).confirm !== true)
        throw fail(400, "重试可能再次收费，必须确认");
      const identity = user(request),
        job = this.ownJob(param(request), identity);
      if (
        this.store
          .all<{ id: string }>("SELECT id FROM tasks WHERE job=?", job.id)
          .some((task) => this.controllers.has(task.id))
      )
        throw fail(409, "任务仍在生成中，请等待结束后再重试");
      this.validate(JSON.parse(job.form), { ...identity, id: job.owner });
      this.store.run(
        "UPDATE tasks SET status='queued',attempts=0,next=0,error=NULL,finishedAt=NULL WHERE job=? AND status IN ('failed','interrupted','cancelled')",
        job.id,
      );
      this.refresh(job.id);
      response.json(this.view(this.ownJob(job.id, identity)));
    });
  }
}
