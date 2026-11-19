import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

test("new backend boots an isolated database with Bimage branding", async () => {
  const module = await import("../dist/app.js").catch(() => null);
  assert.ok(module, "compiled TypeScript backend must exist");
  const dir = mkdtempSync(path.join(process.env.TMPDIR, "bimage-bootstrap-"));
  const service = await module.createApp({
    dir,
    adminKey: "isolated-bootstrap",
    worker: false,
  });
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    assert.deepEqual(await (await fetch(origin + "/health")).json(), {
      ok: true,
    });
    assert.deepEqual(await (await fetch(origin + "/api/site")).json(), {
      title: "Bimage",
      icon: "/Bimage.png",
    });
    assert.equal((await fetch(origin + "/api/me")).status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
