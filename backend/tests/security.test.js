import test from "node:test";
import { loopbackProvider } from '../../test/loopback-provider.js';
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp, validateUrl } from "../dist/app.js";
import { setupAccount } from "./account-fixture.js";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function fixture(handler) {
  const upstream = createServer(handler);
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const dir = mkdtempSync(path.join(tmpdir(), "bimage-security-"));
  const service = await createApp({ dir, retryMs: 5, providerNetwork: loopbackProvider(upstream) });
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = await setupAccount(base, dir);
  const call = async (route, payload) => {
    const response = await fetch(base + "/api" + route, {
      method: payload ? "POST" : "GET",
      headers: {
        ...admin.headers,
        "content-type": "application/json",
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    return { status: response.status, data: await response.json() };
  };
  const provider = (
    await call("/providers", {
      name: "isolated",
      baseUrl: `http://127.0.0.1:${upstream.address().port}`,
      allowPrivate: true,
    })
  ).data;
  const submit = async (count = 1) =>
    (
      await call("/jobs", {
        providerId: provider.id,
        model: "mock",
        prompt: "no production",
        count,
        autoSize: true,
        quality: "auto",
        output_format: "png",
        references: [],
      })
    ).data;
  const wait = async (id) => {
    for (let i = 0; i < 200; i++) {
      const { data } = await call("/jobs/" + id);
      if (!["queued", "running"].includes(data.status)) return data;
      await delay(20);
    }
    throw Error("queue timeout");
  };
  const close = async () => {
    await service.close();
    await new Promise((resolve) => server.close(resolve));
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  };
  return { call, submit, wait, close, service };
}
test("unknown connection failure is never replayed automatically", async () => {
  let calls = 0;
  const f = await fixture((request) => {
    calls++;
    request.resume();
    request.socket.destroy();
  });
  try {
    const job = await f.submit();
    const done = await f.wait(job.id);
    assert.equal(done.status, "failed");
    await delay(300);
    assert.equal(calls, 1);
    assert.equal(done.tasks[0].attempts, 1);
  } finally {
    await f.close();
  }
});
test("a 429 downloading an already charged result never regenerates", async () => {
  let generations = 0,
    downloads = 0;
  let origin;
  const f = await fixture((request, response) => {
    request.resume();
    if (request.url === "/result") {
      downloads++;
      response.writeHead(429);
      response.end("{}");
      return;
    }
    generations++;
    response.end(JSON.stringify({ data: [{ url: origin + "/result" }] }));
  });
  origin = f.service.db.prepare("SELECT baseUrl FROM providers").get().baseUrl;
  try {
    const job = await f.submit();
    const done = await f.wait(job.id);
    assert.equal(done.status, "failed");
    await delay(300);
    assert.equal(generations, 1);
    assert.equal(downloads, 1);
  } finally {
    await f.close();
  }
});
for (const count of [1, 3]) {
  test(`cancel with ${count} slots never aborts a submitted request`, { timeout: 8000 }, async () => {
    let calls = 0, started;
    const ready = new Promise((resolve) => (started = resolve));
    const f = await fixture((request, response) => {
      request.resume();
      request.on("end", () => {
        calls++;
        started(response);
      });
    });
    try {
      const job = await f.submit(count);
      const upstreamResponse = await ready;
      const path = "/jobs/" + job.id;
      const before = (await f.call(path)).data;
      assert.deepEqual(before.tasks.map(t => t.status), ["running", ...Array(count - 1).fill("queued")]);
      const { status, data } = await f.call(path + "/cancel", {});
      assert.equal(status, 200);
      assert.equal(data.status, "running");
      assert.deepEqual(data.tasks[0], before.tasks[0]);
      assert.deepEqual(data.tasks.slice(1).map(t => [t.status, t.attempts]),
        Array.from({ length: count - 1 }, () => ["cancelled", 0]));
      assert.equal(data.cancelledCount, count - 1);
      assert.equal((await f.call(path + "/cancel", {})).data.cancelledCount, 0);
      upstreamResponse.end(JSON.stringify({ data: [{ b64_json: png }] }));
      const done = await f.wait(job.id);
      assert.equal(done.status, "succeeded");
      assert.ok(done.tasks[0].asset);
      assert.equal(done.tasks[0].attempts, 1);
      await delay(250);
      assert.equal(calls, 1);
      assert.deepEqual((await f.call(path + "/cancel", {})).data.tasks, done.tasks);
    } finally {
      await f.close();
    }
  });
}
test("SSRF rejects credentials, queries, fragments, mapped loopback and private networks", async () => {
  for (const raw of [
    "http://u:p@example.com",
    "https://example.com/v1?q=1",
    "https://example.com/#a",
    "file:///etc/passwd",
    "http://[::ffff:127.0.0.1]",
    "http://10.0.0.1",
    "http://100.64.0.1",
    "http://172.16.0.1",
    "http://192.168.1.1",
    "http://192.0.0.8",
    "http://192.0.2.5",
    "http://198.18.0.1",
    "http://198.51.100.5",
    "http://203.0.113.5",
  ])
    await assert.rejects(validateUrl(raw));
});
