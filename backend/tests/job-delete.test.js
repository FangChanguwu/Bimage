import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { createServer } from "node:http";
import { createApp } from "../dist/app.js";
import { loopbackProvider } from "../../test/loopback-provider.js";
import { setupAccount, signIn } from "./account-fixture.js";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=";
const memberPassword = "isolated fixture member password";

async function fixture(t, options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "bimage-delete-"));
  const service = await createApp({ dir, worker: false, ...options });
  const { db } = service;
  const server = service.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const { identity, headers: admin } = await setupAccount(base, dir);
  const adminId = identity.id;
  const request = (route, { method = "GET", headers = admin, body } = {}) =>
    fetch(base + "/api" + route, {
      method,
      headers: {
        ...headers,
        ...(body && { "content-type": "application/json" }),
      },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  let members = 0;
  return {
    db,
    request,
    adminId,
    async member() {
      const email = `member-${++members}@example.test`;
      const response = await request("/admin/users", {
        method: "POST",
        body: {
          email,
          password: memberPassword,
          name: "Fixture member",
          role: "user",
          concurrency: 1,
        },
      });
      assert.equal(response.status, 201);
      const { id } = await response.json();
      const { headers } = await signIn(base, email, memberPassword);
      return { id, headers };
    },
    asset(id, owner = adminId) {
      db.prepare("INSERT INTO assets(id,owner,mime,bytes) VALUES(?,?,?,?)").run(
        id,
        owner,
        "image/png",
        Buffer.from(png, "base64"),
      );
    },
    job(
      id,
      { owner = adminId, references = [], tasks = [["succeeded", null]] } = {},
    ) {
      db.prepare(
        "INSERT INTO jobs(id,owner,form,status,created) VALUES(?,?,?,?,?)",
      ).run(
        id,
        owner,
        JSON.stringify({ references }),
        tasks[0][0],
        "2025-01-01",
      );
      const insert = db.prepare(
        "INSERT INTO tasks(id,job,status,asset) VALUES(?,?,?,?)",
      );
      tasks.forEach(([status, asset], index) =>
        insert.run(`${id}-${index}`, id, status, asset),
      );
    },
  };
}

test("hard delete removes the job, its tasks and its exclusive output bytes", async (t) => {
  const f = await fixture(t);
  f.asset("output");
  f.asset("upload");
  f.job("delete-me", {
    references: ["upload"],
    tasks: [
      ["succeeded", "output"],
      ["failed", null],
    ],
  });
  f.job("keep-me");
  assert.equal((await f.request("/jobs/delete-me")).status, 200);
  const download = await f.request("/jobs/delete-me/download");
  assert.equal(download.status, 200);
  assert.deepEqual(
    Buffer.from(await download.arrayBuffer()),
    Buffer.from(png, "base64"),
  );

  const deleted = await f.request("/jobs/delete-me", { method: "DELETE" });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { deletedAssetIds: ["output"] });

  for (const route of [
    "/jobs/delete-me",
    "/jobs/delete-me/download",
    "/assets/output",
  ])
    assert.equal((await f.request(route)).status, 404, route);
  assert.equal(
    (await f.request("/jobs/delete-me", { method: "DELETE" })).status,
    404,
  );
  const history = await (await f.request("/jobs")).json();
  assert.deepEqual(
    history.map(({ id }) => id),
    ["keep-me"],
  );
  assert.equal(
    f.db.prepare("SELECT id FROM jobs WHERE id='delete-me'").get(),
    undefined,
  );
  assert.equal(
    f.db.prepare("SELECT id FROM tasks WHERE job='delete-me'").get(),
    undefined,
  );
  assert.equal(
    f.db.prepare("SELECT id FROM assets WHERE id='output'").get(),
    undefined,
  );
  const upload = await f.request("/assets/upload");
  assert.equal(upload.status, 200);
  assert.deepEqual(
    Buffer.from(await upload.arrayBuffer()),
    Buffer.from(png, "base64"),
  );
});

test("hard delete preserves shared task outputs, history and draft references, and foreign assets", async (t) => {
  const f = await fixture(t);
  const other = await f.member();
  const protectedIds = ["task-output", "history-reference", "draft-reference"];
  for (const id of [...protectedIds, "exclusive"]) f.asset(id);
  f.asset("foreign", other.id);
  f.job("delete-me", {
    tasks: [
      ...protectedIds,
      "foreign",
      "exclusive",
      "exclusive",
      "missing",
    ].map((id) => ["succeeded", id]),
  });
  f.job("other-job", {
    references: ["history-reference"],
    tasks: [["succeeded", "task-output"]],
  });
  const draft = {
    form: { references: ["draft-reference"], prompt: "Keep my draft" },
  };
  assert.equal(
    (await f.request("/settings", { method: "PUT", body: draft })).status,
    200,
  );
  f.db
    .prepare("INSERT INTO settings VALUES(?,?)")
    .run(other.id, "{ malformed legacy JSON");
  f.job("malformed-legacy");
  f.db
    .prepare("UPDATE jobs SET form=? WHERE id=?")
    .run("{ malformed legacy JSON", "malformed-legacy");

  const deleted = await f.request("/jobs/delete-me", { method: "DELETE" });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { deletedAssetIds: ["exclusive"] });
  for (const id of [...protectedIds, "foreign"])
    assert.equal((await f.request(`/assets/${id}`)).status, 200, id);
  assert.deepEqual(await (await f.request("/settings")).json(), draft);
  assert.equal((await f.request("/jobs/other-job/download")).status, 200);
});

test("uploading identical generated bytes creates an independently retained reference", async (t) => {
  const f = await fixture(t);
  f.asset("output");
  f.job("delete-me", { tasks: [["succeeded", "output"]] });
  const upload = async () => {
    const response = await f.request("/assets", {
      method: "POST",
      body: { mime: "image/png", data: png },
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const { id } = await upload();
  assert.notEqual(id, "output");
  assert.equal((await upload()).id, id);

  const deleted = await f.request("/jobs/delete-me", { method: "DELETE" });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { deletedAssetIds: ["output"] });
  assert.equal((await f.request(`/assets/${id}`)).status, 200);
});

test("hard delete requires job ownership even for an admin and reuses session CSRF", async (t) => {
  const f = await fixture(t);
  const owner = await f.member();
  const other = await f.member();
  f.job("member-job", { owner: owner.id });
  const route = "/jobs/member-job";
  const method = "DELETE";
  assert.equal((await f.request(route, { method, headers: {} })).status, 401);
  for (const headers of [undefined, other.headers]) {
    const denied = await f.request(route, { method, headers });
    const missing = await f.request("/jobs/missing", { method, headers });
    assert.equal(denied.status, 404);
    assert.equal(missing.status, 404);
    assert.deepEqual(await denied.json(), await missing.json());
  }
  const headers = { cookie: owner.headers.cookie };
  assert.equal((await f.request(route, { method, headers })).status, 403);
  assert.equal((await f.request(route, { headers })).status, 200);
  const deleted = await f.request(route, {
    method,
    headers: owner.headers,
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { deletedAssetIds: [] });
});

test("hard delete returns conflict for queued jobs without changing them", async (t) => {
  const f = await fixture(t);
  f.job("queued", { tasks: [["queued", null]] });
  const route = "/jobs/queued";
  const before = await (await f.request(route)).json();
  assert.equal((await f.request(route, { method: "DELETE" })).status, 409);
  assert.deepEqual(await (await f.request(route)).json(), before);
  assert.equal(
    (await f.request(route + "/cancel", { method: "POST", body: {} })).status,
    200,
  );
  assert.equal((await f.request(route, { method: "DELETE" })).status, 200);
});

test(
  "hard delete refuses running and not-yet-unwound work",
  { timeout: 8000 },
  async (t) => {
    let started;
    const ready = new Promise((resolve) => (started = resolve));
    let upstreamCalls = 0;
    const upstream = createServer((req, res) => {
      req.resume();
      upstreamCalls++;
      started(res);
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const f = await fixture(t, { worker: true, providerNetwork: loopbackProvider(upstream) });
    t.after(async () => {
      upstream.closeAllConnections();
      await new Promise((resolve) => upstream.close(resolve));
    });
    const provider = await f.request("/providers", {
      method: "POST",
      body: {
        name: "Mock",
        baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
        allowPrivate: true,
      },
    });
    assert.equal(provider.status, 200);
    const { id: providerId } = await provider.json();
    const submitted = await f.request("/jobs", {
      method: "POST",
      body: {
        providerId,
        model: "mock",
        prompt: "test",
        count: 1,
        autoSize: true,
        quality: "auto",
        output_format: "png",
        references: [],
      },
    });
    assert.equal(submitted.status, 200);
    const { id } = await submitted.json();
    const upstreamResponse = await Promise.race([
      ready,
      once(AbortSignal.timeout(5000), "abort").then(() =>
        assert.fail("queue did not reach loopback upstream"),
      ),
    ]);
    const route = `/jobs/${id}`;
    const remove = () => f.request(route, { method: "DELETE" });
    assert.equal((await remove()).status, 409);

    // Model a terminal status while the worker still owns the upstream request.
    f.db.prepare("UPDATE tasks SET status='cancelled' WHERE job=?").run(id);
    f.db.prepare("UPDATE jobs SET status='cancelled' WHERE id=?").run(id);
    assert.equal((await remove()).status, 409);
    upstreamResponse.end(JSON.stringify({ data: [{ b64_json: png }] }));
    let deleted = await remove();
    for (let i = 0; deleted.status === 409 && i < 100; i++) {
      await deleted.json();
      await new Promise((resolve) => setTimeout(resolve, 10));
      deleted = await remove();
    }
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { deletedAssetIds: [] });
    assert.equal((await f.request(route)).status, 404);
    assert.equal(f.db.prepare("SELECT count(*) n FROM assets").get().n, 0);
    assert.equal(upstreamCalls, 1);
  },
);

test("hard delete rolls back jobs, tasks and earlier asset removals on a storage error", async (t) => {
  const f = await fixture(t);
  f.asset("first");
  f.asset("blocked");
  f.job("delete-me", {
    tasks: [
      ["succeeded", "first"],
      ["succeeded", "blocked"],
    ],
  });
  f.db.exec(`CREATE TRIGGER fail_asset_delete BEFORE DELETE ON assets
    WHEN OLD.id='blocked' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;`);
  const failed = await f.request("/jobs/delete-me", { method: "DELETE" });
  assert.equal(failed.status, 500);
  assert.doesNotMatch(JSON.stringify(await failed.json()), /fixture failure/);
  const job = await (await f.request("/jobs/delete-me")).json();
  assert.deepEqual(
    job.tasks.map((task) => task.asset),
    ["first", "blocked"],
  );
  for (const id of ["first", "blocked"])
    assert.equal((await f.request(`/assets/${id}`)).status, 200);
});
