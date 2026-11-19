import { tmpdir } from 'node:os';
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../backend/dist/app.js";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import path from "node:path";
test("draft discovery and saved provider support mixed model capabilities without disclosing keys", async () => {
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
  const s = await createApp({
    dir: mkdtempSync(path.join(tmpdir(), "mixed-")),
    adminKey: "test-admin",
    worker: false,
  });
  const server = s.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const call = async (p, b, method = b ? "POST" : "GET") => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api` + p, {
      method,
      headers: {
        authorization: "Bearer test-admin",
        "content-type": "application/json",
      },
      body: b ? JSON.stringify(b) : undefined,
    });
    return {
      status: r.status,
      data: await r.text().then((t) => {
        try {
          return JSON.parse(t);
        } catch {
          return { error: "route missing" };
        }
      }),
    };
  };
  try {
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
      [["image"], ["text"], ["image", "text"], []],
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
      allowPrivate: false,
    });
    assert.equal(blocked.status, 400);
  } finally {
    await new Promise((r) => server.close(r));
    s.close();
    await new Promise((r) => mock.close(r));
  }
});
