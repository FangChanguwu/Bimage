import { tmpdir } from 'node:os';
import { loopbackProvider } from './loopback-provider.js';
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../backend/dist/app.js";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { request, setupAccount } from "./account-fixture.js";
import path from "node:path";
test("draft discovery and saved provider support mixed model capabilities without disclosing provider secrets", async () => {
  const mock = createServer((q, r) => {
    r.setHeader("content-type", "application/json");
    r.end(
      JSON.stringify(
        q.url.endsWith("/models")
          ? {
              data: [
                { id: "gpt-image-1" },
                { id: "gpt-4.1" },
                { id: "custom", capabilities: ["image", "text"] },
                { id: "unknown" },
              ],
            }
          : { choices: [{ message: { content: "rewritten" } }] },
      ),
    );
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(path.join(tmpdir(), "mixed-"));
  const s = await createApp({ dir, worker: false, providerNetwork: loopbackProvider(mock) });
  const server = s.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { headers } = await setupAccount(base, dir);
    const call = async (p, body) => {
      const r = await request(base, '/api' + p, { headers, body });
      return { status: r.status, data: await r.json() };
    };
    const draft = {
      name: "mixed",
      baseUrl: `http://127.0.0.1:${mock.address().port}/v1`,
      apiKey: "draft-private-test",
      allowPrivate: true,
    };
    const d = await call("/providers/models", draft);
    assert.equal(d.status, 200);
    assert.deepEqual(
      d.data.data.map((x) => x.types),
      [["image"], ["text"], ["image", "text"], ["text"]],
    );
    assert.ok(d.data.data.every((x) => x.reason));
    assert.ok(!JSON.stringify(d).includes(draft.apiKey));
    const p = await call("/providers", { ...draft, models: d.data.data });
    assert.equal(p.status, 200);
    assert.equal(p.data.models.length, 4);
    const rewrite = await call("/rewrite", {
      providerId: p.data.id,
      model: "gpt-4.1",
      prompt: "cat",
    });
    assert.equal(rewrite.status, 200);
    assert.equal(
      (await call("/providers/" + p.data.id + "/models")).data.data.length,
      4,
    );
    const blocked = await call("/providers/models", {
      ...draft,
      baseUrl: "http://127.0.0.1:9/v1",
    });
    assert.equal(blocked.status, 400);
  } finally {
    await new Promise((r) => server.close(r));
    await s.close();
    await new Promise((r) => mock.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
