import { randomUUID } from "node:crypto";
import type { Express } from "express";
import rateLimit from "express-rate-limit";
import { Store } from "./db.js";
import { body, fail, param, user } from "./http.js";
import { validateUrl, upstream } from "./network.js";
import { cleanModels, modelInfo } from "./models.js";
import type { KeyRow, ProviderRow, ProviderConfig } from "./types.js";

export class Providers {
  constructor(private store: Store) {}
  manageable(id: string, identity: KeyRow): ProviderRow {
    const provider = this.store.get<ProviderRow>(
      "SELECT * FROM providers WHERE id=?",
      id,
    );
    if (
      !provider ||
      (provider.owner !== identity.id && identity.role !== "admin")
    )
      throw fail(404, "供应商不存在");
    return provider;
  }
  usable(id: unknown, identity: KeyRow): ProviderRow {
    if (typeof id !== "string") throw fail(400, "供应商参数无效");
    const provider = this.store.get<ProviderRow>(
      "SELECT * FROM providers WHERE id=?",
      id,
    );
    if (!provider || (provider.owner !== identity.id && !provider.shared))
      throw fail(404, "供应商不存在");
    return provider;
  }
  view(provider: ProviderRow, identity: KeyRow) {
    const canManage =
      provider.owner === identity.id || identity.role === "admin";
    return {
      id: provider.id,
      name: provider.name,
      kind: provider.kind,
      models: JSON.parse(provider.models || "[]") as unknown,
      shared: !!provider.shared,
      canManage,
      hasKey: !!provider.apiKey,
      ...(canManage
        ? {
            owner: provider.owner,
            baseUrl: provider.baseUrl,
            allowPrivate: !!provider.allowPrivate,
          }
        : {}),
    };
  }
  async draft(
    input: Record<string, unknown>,
    identity: KeyRow,
    old?: ProviderRow,
  ): Promise<ProviderConfig> {
    const name = input.name ?? old?.name ?? "draft",
      baseUrl = input.baseUrl ?? old?.baseUrl;
    const apiKey = input.apiKey || old?.apiKey || "",
      kind = input.kind ?? old?.kind ?? "mixed";
    const allowPrivate = input.allowPrivate ?? old?.allowPrivate ?? false;
    if (
      typeof name !== "string" ||
      !name.trim() ||
      typeof baseUrl !== "string" ||
      typeof apiKey !== "string" ||
      apiKey.length > 8192 ||
      typeof kind !== "string" ||
      !["mixed", "image", "text"].includes(kind)
    )
      throw fail(400, "供应商参数无效");
    if (allowPrivate && identity.role !== "admin")
      throw fail(403, "仅管理员可授权");
    await validateUrl(baseUrl, !!allowPrivate);
    return {
      name: name.slice(0, 100),
      baseUrl: baseUrl.replace(/\/$/, ""),
      apiKey,
      kind,
      allowPrivate: !!allowPrivate,
    };
  }
  async discover(provider: ProviderConfig) {
    const result = await upstream(provider, "/models");
    if (!Array.isArray(result.data) || result.data.length > 2000)
      throw fail(502, "模型列表无效");
    return result.data.map(modelInfo).filter((model) => !!model.id);
  }
  mount(app: Express, revokeShared: (provider: ProviderRow) => void): void {
    const limit = rateLimit({ windowMs: 60000, limit: 20 });
    app.get("/api/providers", (request, response) => {
      const identity = user(request);
      const providers =
        identity.role === "admin"
          ? this.store.all<ProviderRow>("SELECT * FROM providers")
          : this.store.all<ProviderRow>(
              "SELECT * FROM providers WHERE owner=? OR shared=1",
              identity.id,
            );
      response.json(providers.map((provider) => this.view(provider, identity)));
    });
    app.post("/api/providers/models", limit, async (request, response) =>
      response.json({
        data: await this.discover(
          await this.draft(body(request), user(request)),
        ),
      }),
    );
    app.post("/api/providers", async (request, response) => {
      const input = body(request),
        identity = user(request),
        draft = await this.draft(input, identity);
      const models = cleanModels(input.models || []),
        id = randomUUID();
      this.store.run(
        "INSERT INTO providers(id,owner,name,baseUrl,apiKey,kind,allowPrivate,models,shared) VALUES(?,?,?,?,?,?,?,?,?)",
        id,
        identity.id,
        draft.name,
        draft.baseUrl,
        draft.apiKey,
        draft.kind,
        Number(!!draft.allowPrivate),
        JSON.stringify(models),
        Number(input.shared === true),
      );
      response.json(this.view(this.manageable(id, identity), identity));
    });
    app.post("/api/providers/:id/models", limit, async (request, response) => {
      const identity = user(request),
        old = this.manageable(param(request), identity);
      response.json({
        data: await this.discover(
          await this.draft(body(request), identity, old),
        ),
      });
    });
    app.patch("/api/providers/:id", async (request, response) => {
      const input = body(request),
        identity = user(request),
        old = this.manageable(param(request), identity);
      const draft = await this.draft(input, identity, old);
      const models = cleanModels(
        input.models ?? JSON.parse(old.models || "[]"),
      );
      const shared =
        input.shared === undefined ? !!old.shared : input.shared === true;
      this.store.run(
        "UPDATE providers SET name=?,baseUrl=?,kind=?,apiKey=?,allowPrivate=?,models=?,shared=? WHERE id=?",
        draft.name,
        draft.baseUrl,
        draft.kind,
        draft.apiKey,
        Number(!!draft.allowPrivate),
        JSON.stringify(models),
        Number(shared),
        old.id,
      );
      if (old.shared && !shared) revokeShared(old);
      response.json(this.view(this.manageable(old.id, identity), identity));
    });
    app.delete("/api/providers/:id", (request, response) => {
      const old = this.manageable(param(request), user(request));
      this.store.run("DELETE FROM providers WHERE id=?", old.id);
      revokeShared(old);
      response.json({ ok: true });
    });
    app.get("/api/providers/:id/models", limit, async (request, response) => {
      const provider = this.manageable(param(request), user(request));
      const data = await this.discover(provider);
      this.store.run(
        "UPDATE providers SET models=? WHERE id=?",
        JSON.stringify(data),
        provider.id,
      );
      response.json({ data });
    });
  }
}
