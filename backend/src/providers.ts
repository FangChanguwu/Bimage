import { randomUUID } from "node:crypto";
import type { Express } from "express";
import rateLimit from "express-rate-limit";
import { Store } from "./db.js";
import { body, fail, param, user } from "./http.js";
import { createProviderNetwork, upstream, upstreamStream, type ProviderNetwork } from "./network.js";
import type { FormData } from "undici";
import { cleanModels, modelInfo } from "./models.js";
import type { ClientRateLimitKey } from "./client-rate-limit.js";
import type { ProviderRow, ProviderConfig } from "./types.js";

type Owner = { id: string; role: "admin" | "user" };

export class Providers {
  constructor(private store: Store, private network: ProviderNetwork = createProviderNetwork()) {}
  request(provider: ProviderConfig, endpoint: string, payload?: Record<string, unknown> | FormData, signal?: AbortSignal) {
    return upstream(this.network, provider, endpoint, payload, signal);
  }
  requestStream(provider: ProviderConfig, endpoint: string, payload: Record<string, unknown>, signal?: AbortSignal) {
    return upstreamStream(this.network, provider, endpoint, payload, signal);
  }
  download(url: string, signal: AbortSignal) {
    return this.network.fetch(url, { signal });
  }
  manageable(id: string, identity: Owner): ProviderRow {
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
  usable(id: unknown, identity: Owner): ProviderRow {
    if (typeof id !== "string") throw fail(400, "供应商参数无效");
    const provider = this.store.get<ProviderRow>(
      "SELECT * FROM providers WHERE id=?",
      id,
    );
    if (!provider || (provider.owner !== identity.id && !provider.shared))
      throw fail(404, "供应商不存在");
    return provider;
  }
  view(provider: ProviderRow, identity: Owner) {
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
          }
        : {}),
    };
  }
  async draft(
    input: Record<string, unknown>,
    old?: ProviderRow,
    options?: { allowEmptyName?: boolean },
  ): Promise<ProviderConfig> {
    const rawName = typeof input.name === "string" ? input.name : undefined;
    const name = options?.allowEmptyName
      ? (rawName?.trim() ? rawName : old?.name || "draft")
      : (input.name ?? old?.name ?? "draft");
    const baseUrl = input.baseUrl ?? old?.baseUrl;
    const kind = input.kind ?? old?.kind ?? "mixed";
    const submittedKey = typeof input.apiKey === "string" ? input.apiKey : "";
    const clearApiKey = input.clearApiKey === true;
    const reuseApiKey = input.reuseApiKey === true;

    if (
      typeof name !== "string" ||
      !name.trim() ||
      typeof baseUrl !== "string" ||
      !baseUrl.trim() ||
      (input.apiKey !== undefined && typeof input.apiKey !== "string") ||
      submittedKey.length > 8192 ||
      typeof kind !== "string" ||
      !["mixed", "image", "text"].includes(kind)
    )
      throw fail(400, "供应商参数无效");
    await this.network.validate(baseUrl);
    const normalizedUrl = baseUrl.trim().replace(/\/$/, "");
    const oldUrl = (old?.baseUrl || "").trim().replace(/\/$/, "");
    let apiKey = "";
    if (submittedKey) {
      apiKey = submittedKey;
    } else if (clearApiKey) {
      apiKey = "";
    } else if (old?.apiKey) {
      if (oldUrl && normalizedUrl !== oldUrl && !reuseApiKey) {
        throw fail(400, "Base URL 已变更，请重新输入 API Key 或明确确认复用原密钥");
      }
      apiKey = old.apiKey;
    }
    return {
      name: name.trim().slice(0, 100),
      baseUrl: normalizedUrl,
      apiKey,
      kind,
    };
  }
  async discover(provider: ProviderConfig) {
    const result = await this.request(provider, "/models");
    if (!Array.isArray(result.data) || result.data.length > 2000)
      throw fail(502, "模型列表无效");
    return result.data.map(modelInfo).filter((model) => !!model.id);
  }
  mount(
    app: Express,
    revokeShared: (provider: ProviderRow) => void,
    keyGenerator: ClientRateLimitKey,
  ): void {
    const limit = rateLimit({ keyGenerator, windowMs: 60000, limit: 20 });
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
          await this.draft(body(request), undefined, { allowEmptyName: true }),
        ),
      }),
    );
    app.post("/api/providers", async (request, response) => {
      const input = body(request),
        identity = user(request),
        draft = await this.draft(input);
      const models = cleanModels(input.models || []),
        id = randomUUID();
      this.store.run(
        "INSERT INTO providers(id,owner,name,baseUrl,apiKey,kind,models,shared) VALUES(?,?,?,?,?,?,?,?)",
        id,
        identity.id,
        draft.name,
        draft.baseUrl,
        draft.apiKey,
        draft.kind,
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
          await this.draft(body(request), old, { allowEmptyName: true }),
        ),
      });
    });
    app.patch("/api/providers/:id", async (request, response) => {
      const input = body(request),
        identity = user(request),
        old = this.manageable(param(request), identity);
      const draft = await this.draft(input, old);
      const models = cleanModels(
        input.models ?? JSON.parse(old.models || "[]"),
      );
      const shared =
        input.shared === undefined ? !!old.shared : input.shared === true;
      this.store.run(
        "UPDATE providers SET name=?,baseUrl=?,kind=?,apiKey=?,allowPrivate=0,models=?,shared=? WHERE id=?",
        draft.name,
        draft.baseUrl,
        draft.kind,
        draft.apiKey,
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
