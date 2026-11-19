import { tmpdir } from 'node:os';
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../backend/dist/app.js";
import { mkdtempSync } from "node:fs";
import path from "node:path";
test("member cannot grant draft private access and keys never escape model discovery", async () => {
  const s = await createApp({
    dir: mkdtempSync(path.join(tmpdir(), "draft-auth-")),
    adminKey: "test-admin",
    worker: false,
  });
  const server = s.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const call = async (p, b, key = "test-admin") => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api` + p, {
      method: "POST",
      headers: {
        authorization: "Bearer " + key,
        "content-type": "application/json",
      },
      body: JSON.stringify(b),
    });
    return { status: r.status, data: await r.json() };
  };
  try {
    const k = await call("/admin/keys", {
      name: "member",
      role: "user",
      expires: null,
    });
    const r = await call(
      "/providers/models",
      {
        baseUrl: "http://127.0.0.1/v1",
        apiKey: "private-test",
        allowPrivate: true,
      },
      k.data.key,
    );
    assert.equal(r.status, 403);
    assert.ok(!JSON.stringify(r).includes("private-test"));
  } finally {
    await new Promise((r) => server.close(r));
    s.close();
  }
});
