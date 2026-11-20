import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../dist/app.js";
import { accountRequest, setupAccount } from "./account-fixture.js";

function legacyFixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "bimage-legacy-queue-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(dir, "studio.sqlite"));
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE keys(id TEXT PRIMARY KEY, hash TEXT UNIQUE, name TEXT, role TEXT);
    INSERT INTO keys VALUES
      ('old-admin', 'admin-fixture-digest', 'Old Admin', 'admin'),
      ('old-member', 'member-fixture-digest', 'Old Member', 'user');
    CREATE TABLE sessions(hash TEXT PRIMARY KEY, owner TEXT, csrf TEXT, expires INTEGER);
    INSERT INTO sessions VALUES('session-fixture-digest', 'old-admin', 'fixture-csrf', 0);
    CREATE TABLE jobs(id TEXT PRIMARY KEY, owner TEXT, form TEXT, status TEXT, created TEXT);
    CREATE TABLE tasks(id TEXT PRIMARY KEY, job TEXT, status TEXT, attempts INTEGER DEFAULT 0, next INTEGER DEFAULT 0, asset TEXT, error TEXT);
  `);
  return { dir, db };
}

function addWork(db, id, owner, status, next = 0) {
  db.prepare(
    "INSERT INTO jobs(id,owner,form,status,created) VALUES(?,?,?,?,?)",
  ).run(id, owner, '{"prompt":"legacy history"}', status, "2025-01-01");
  db.prepare(
    "INSERT INTO tasks(id,job,status,attempts,next) VALUES(?,?,?,?,?)",
  ).run(id, id, status, status === "running" ? 1 : 0, next);
}

async function assertBlocked(dir) {
  await assert.rejects(async () => {
    const service = await createApp({ dir, worker: false });
    await service.close();
  }, /Legacy account migration blocked: queued or running tasks remain/);
}

for (const [status, owner] of [
  ["queued", "old-member"],
  ["running", "old-admin"],
]) {
  test(`legacy migration refuses ${status} work before changing sessions, schema or queue`, async (t) => {
    const { dir, db } = legacyFixture(t);
    const next = status === "queued" ? Date.now() + 3600000 : 0;
    addWork(db, "pending", owner, status, next);
    await assertBlocked(dir);
    assert.equal(existsSync(path.join(dir, "setup-code.txt")), false);
    assert.equal(
      db
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE name IN ('accounts','account_sessions')",
        )
        .get(),
      undefined,
    );
    assert.equal(
      db.prepare("SELECT owner FROM sessions").get().owner,
      "old-admin",
    );
    assert.deepEqual(
      {
        ...db
          .prepare("SELECT status,attempts,next FROM tasks WHERE id='pending'")
          .get(),
      },
      { status, attempts: status === "running" ? 1 : 0, next },
    );
    assert.equal(
      db.prepare("SELECT status FROM jobs WHERE id='pending'").get().status,
      status,
    );
  });
}

test("partial migration refuses unclaimed work without disrupting active-account restart recovery", async (t) => {
  const { dir, db } = legacyFixture(t);
  const first = await createApp({ dir, worker: false });
  const server = first.app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const admin = await setupAccount(
      `http://127.0.0.1:${server.address().port}`,
      dir,
    );
    assert.equal(admin.identity.id, "old-admin");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await first.close();
  }

  addWork(db, "unclaimed", "old-member", "queued");
  addWork(db, "normal-queued", "old-admin", "queued");
  addWork(db, "normal-inflight", "old-admin", "running");
  await assertBlocked(dir);
  const states = () =>
    Object.fromEntries(
      db
        .prepare("SELECT id,status FROM tasks")
        .all()
        .map(({ id, status }) => [id, status]),
    );
  assert.deepEqual(states(), {
    unclaimed: "queued",
    "normal-queued": "queued",
    "normal-inflight": "running",
  });

  db.prepare("UPDATE tasks SET status='cancelled' WHERE id='unclaimed'").run();
  db.prepare("UPDATE jobs SET status='cancelled' WHERE id='unclaimed'").run();
  const restarted = await createApp({ dir, worker: false });
  try {
    assert.deepEqual(states(), {
      unclaimed: "cancelled",
      "normal-queued": "queued",
      "normal-inflight": "interrupted",
    });
    assert.equal(
      db.prepare("SELECT owner FROM jobs WHERE id='unclaimed'").get().owner,
      "old-member",
    );
  } finally {
    await restarted.close();
  }
});

test("retired workspace claim is rejected before and after cancelling pending work", async (t) => {
  const { dir, db } = legacyFixture(t);
  const service = await createApp({ dir, worker: false });
  const server = service.app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const admin = await setupAccount(origin, dir);
    const post = (route, body) =>
      accountRequest(origin, route, {
        method: "POST",
        headers: admin.headers,
        body,
      });
    const claim = () =>
      post("/api/admin/users", {
        legacyId: "old-member",
        email: "member@example.test",
        password: "isolated fixture member password",
        role: "user",
        concurrency: 1,
      });

    addWork(db, "pending", "old-member", "queued");
    assert.equal((await claim()).status, 400);
    assert.equal(
      db.prepare("SELECT id FROM accounts WHERE id='old-member'").get(),
      undefined,
    );
    assert.equal(
      db.prepare("SELECT status FROM tasks WHERE id='pending'").get().status,
      "queued",
    );

    const cancelled = await post("/api/jobs/pending/cancel", {});
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).cancelledCount, 1);
    assert.equal((await claim()).status, 400);
    assert.equal(
      db.prepare("SELECT id FROM accounts WHERE id='old-member'").get(),
      undefined,
    );
    assert.equal(
      db.prepare("SELECT status FROM tasks WHERE id='pending'").get().status,
      "cancelled",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await service.close();
  }
});

test("admin retry leaves unclaimed work untouched and still supports active owners", async (t) => {
  const { dir, db } = legacyFixture(t);
  addWork(db, "failed-job", "old-member", "failed");
  const service = await createApp({ dir, worker: false });
  const server = service.app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const admin = await setupAccount(origin, dir);
    db.prepare(
      "INSERT INTO providers(id,owner,shared) VALUES('legacy-provider','old-member',0)",
    ).run();
    db.prepare("UPDATE jobs SET form=? WHERE id='failed-job'").run(
      JSON.stringify({
        providerId: "legacy-provider",
        model: "mock-image",
        prompt: "legacy history",
        count: 1,
        autoSize: true,
        quality: "auto",
        output_format: "png",
        references: [],
      }),
    );
    const post = (route, body) =>
      accountRequest(origin, route, {
        method: "POST",
        headers: admin.headers,
        body,
      });
    const retry = () => post("/api/jobs/failed-job/retry", { confirm: true });
    assert.equal((await retry()).status, 409);
    for (const table of ["tasks", "jobs"]) {
      assert.equal(
        db.prepare(`SELECT status FROM ${table} WHERE id='failed-job'`).get()
          .status,
        "failed",
      );
    }

    const created = await post("/api/admin/users", {
      email: "member@example.test",
      password: "isolated fixture member password",
      role: "user",
      concurrency: 1,
    });
    assert.equal(created.status, 201);
    const member = await created.json();
    db.prepare(
      "INSERT INTO providers(id,owner,shared) VALUES('active-provider',?,0)",
    ).run(member.id);
    addWork(db, "active-job", member.id, "failed");
    const form = JSON.parse(
      db.prepare("SELECT form FROM jobs WHERE id='failed-job'").get().form,
    );
    db.prepare("UPDATE jobs SET form=? WHERE id='active-job'").run(
      JSON.stringify({ ...form, providerId: "active-provider" }),
    );
    const retried = await post("/api/jobs/active-job/retry", { confirm: true });
    assert.equal(retried.status, 200);
    assert.equal((await retried.json()).tasks[0].status, "queued");
    assert.equal((await retry()).status, 409);
    assert.equal(
      db.prepare("SELECT id FROM accounts WHERE id='old-member'").get(),
      undefined,
    );
    for (const table of ["tasks", "jobs"]) {
      assert.equal(
        db.prepare(`SELECT status FROM ${table} WHERE id='failed-job'`).get()
          .status,
        "failed",
      );
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await service.close();
  }
});
