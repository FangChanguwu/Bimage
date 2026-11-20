import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  existsSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createApp } from "../dist/app.js";

const password = "admin fixture password";
const memberPassword = "member fixture password";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "bimage-accounts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "setup-code.txt");
  return { dir, file, code: () => readFileSync(file, "utf8").trim() };
}

async function serve(dir, options) {
  const service = await createApp({ dir, worker: false, ...options });
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function request(
    route,
    { method = "GET", body, session, headers } = {},
  ) {
    const response = await fetch(origin + "/api" + route, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(session?.cookie ? { cookie: session.cookie } : {}),
        ...(session?.json.csrf ? { "x-csrf-token": session.json.csrf } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const setCookie = response.headers.get("set-cookie");
    return {
      status: response.status,
      json: await response.json(),
      cookie: setCookie?.split(";")[0],
      headers: response.headers,
    };
  }
  return {
    ...service,
    origin,
    request,
    async stop() {
      if (server.listening)
        await new Promise((resolve) => server.close(resolve));
      await service.close();
    },
  };
}

const post = (request, route, body, session, headers) =>
  request(route, { method: "POST", body, session, headers });

test("five-character passwords work for setup and new accounts, four characters fail", async (t) => {
  const { dir, code } = fixture(t);
  const api = await serve(dir);
  try {
    assert.equal((await post(api.request, "/setup", { code: code(), password: "1234" })).status, 400);
    const admin = await post(api.request, "/setup", { code: code(), password: "12345" });
    assert.equal(admin.status, 200);
    const input = { email: "short@example.test", password: "abcd", role: "user", concurrency: 1 };
    assert.equal((await post(api.request, "/admin/users", input, admin)).status, 400);
    assert.equal((await post(api.request, "/admin/users", { ...input, password: "abcde" }, admin)).status, 201);
    assert.equal((await post(api.request, "/login", { login: input.email, password: "abcde" })).status, 200);
    assert.equal((await post(api.request, "/login", { login: "admin", password: "12345" })).status, 200);
  } finally {
    await api.stop();
  }
});

test("setup requires a private persistent code and exactly one racing request claims it", async (t) => {
  const { dir, file, code } = fixture(t);
  const first = await serve(dir);
  let original;
  try {
    assert.deepEqual((await first.request("/setup")).json, { required: true });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    original = code();
    assert.ok(original.length >= 32);
    assert.equal((await first.request("/me")).status, 401);
  } finally {
    await first.stop();
  }
  const api = await serve(dir);
  try {
    assert.equal(code(), original);
    assert.equal(
      (await post(api.request, "/setup", { code: "bad", password })).status,
      403,
    );
    assert.equal(
      (await post(api.request, "/setup", { code: original, password: "four" }))
        .status,
      400,
    );
    assert.equal(
      (
        await post(
          api.request,
          "/setup",
          { code: original, password },
          undefined,
          { origin: "https://other.invalid" },
        )
      ).status,
      403,
    );
    const outcomes = await Promise.all([
      post(api.request, "/setup", { code: original, password }),
      post(api.request, "/setup", { code: original, password }),
    ]);
    assert.deepEqual(outcomes.map(({ status }) => status).sort(), [200, 409]);
    const session = outcomes.find(({ status }) => status === 200);
    assert.deepEqual(Object.keys(session.json).sort(), [
      "concurrency",
      "csrf",
      "email",
      "id",
      "name",
      "role",
    ]);
    assert.equal(session.json.email, "admin");
    assert.equal(session.json.role, "admin");
    assert.match(
      session.headers.get("set-cookie"),
      /HttpOnly; SameSite=Strict/i,
    );
    assert.equal(session.headers.get("cache-control"), "no-store");
    assert.deepEqual(
      (await api.request("/me", { session })).json,
      session.json,
    );
    assert.deepEqual((await api.request("/setup")).json, { required: false });
    assert.equal(existsSync(file), false);
    assert.equal(
      api.db.prepare("SELECT count(*) AS n FROM accounts").get().n,
      1,
    );
    assert.equal(
      (await post(api.request, "/login", { key: "old fixture bootstrap" }))
        .status,
      401,
    );
    assert.equal(
      (
        await api.request("/me", {
          headers: { authorization: "Bearer old fixture bootstrap" },
        })
      ).status,
      401,
    );
  } finally {
    await api.stop();
  }
});

test("setup refuses insecure files without generating or following a secret symlink", async (t) => {
  const { dir, file } = fixture(t);
  const target = path.join(dir, "unrelated.txt");
  writeFileSync(target, `${"x".repeat(43)}\n`, { mode: 0o600 });
  symlinkSync(target, file);
  await assert.rejects(createApp({ dir, worker: false }), { code: "ELOOP" });
  assert.equal(readFileSync(target, "utf8"), `${"x".repeat(43)}\n`);
  rmSync(file);
  writeFileSync(file, `${"x".repeat(43)}\n`, { mode: 0o644 });
  await assert.rejects(
    createApp({ dir, worker: false }),
    /regular mode-0600 file/,
  );
});

test("multiple legacy administrators refuse migration without changing legacy records", async (t) => {
  const { dir, file } = fixture(t);
  const pathname = path.join(dir, "studio.sqlite");
  const db = new DatabaseSync(pathname);
  try {
    db.exec(`CREATE TABLE keys(id TEXT PRIMARY KEY,hash TEXT,name TEXT,role TEXT);
      INSERT INTO keys VALUES('a','hash-a','A','admin'),('b','hash-b','B','admin');
      CREATE TABLE sessions(hash TEXT PRIMARY KEY, owner TEXT);
      INSERT INTO sessions VALUES('session-a', 'a');`);
    await assert.rejects(
      createApp({ dir, worker: false }),
      /Multiple legacy administrators/,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM keys WHERE role='admin'").get().n,
      2,
    );
    assert.equal(db.prepare("SELECT owner FROM sessions").get().owner, "a");
    assert.equal(existsSync(file), false);
  } finally {
    db.close();
  }
});

test("admin list and create enforce roles, CSRF, normalized emails and concurrency", async (t) => {
  const { dir, code } = fixture(t);
  const api = await serve(dir);
  const request = api.request;
  const route = "/admin/users";
  try {
    const admin = await post(request, "/setup", { code: code(), password });
    const input = {
      email: "  MEMBER@EXAMPLE.TEST  ",
      password: memberPassword,
      role: "user",
      concurrency: 8,
    };
    assert.equal((await request(route)).status, 401);
    assert.equal(
      (await post(request, route, input, admin, { "x-csrf-token": "" })).status,
      403,
    );
    assert.equal(
      (
        await post(request, route, input, admin, {
          origin: "https://other.invalid",
        })
      ).status,
      403,
    );
    for (const concurrency of [0, 9, 1.5, "2", null]) {
      assert.equal(
        (await post(request, route, { ...input, concurrency }, admin)).status,
        400,
      );
    }
    for (const invalid of [
      { role: "owner" },
      { email: "admin" },
      { email: "bad@-example.test" },
      { password: "\rmember password" },
    ]) {
      assert.equal(
        (await post(request, route, { ...input, ...invalid }, admin)).status,
        400,
      );
    }
    const member = await post(request, route, input, admin, {
      origin: api.origin,
    });
    assert.equal(member.status, 201);
    assert.match(
      member.json.id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.deepEqual(member.json, {
      id: member.json.id,
      email: "member@example.test",
      name: "member@example.test",
      role: "user",
      concurrency: 8,
    });
    const duplicate = await post(
      request,
      route,
      { ...input, email: "member@example.test" },
      admin,
    );
    assert.equal(duplicate.status, 409);
    const backup = await post(
      request,
      route,
      {
        ...input,
        email: "backup@example.test",
        role: "admin",
        concurrency: 1,
        name: " Backup Admin ",
      },
      admin,
    );
    assert.equal(backup.status, 201);
    assert.equal(backup.json.name, "Backup Admin");
    assert.equal(backup.json.role, "admin");
    const hashes = api.db
      .prepare(
        "SELECT passwordHash FROM accounts WHERE role='user' OR email='backup@example.test'",
      )
      .all();
    for (const { passwordHash } of hashes)
      assert.match(passwordHash, /^scrypt-v1:[a-f0-9]{32}:[a-f0-9]{64}$/);
    assert.notEqual(hashes[0].passwordHash, hashes[1].passwordHash);
    const session = await post(request, "/login", {
      login: " MEMBER@EXAMPLE.TEST ",
      password: memberPassword,
    });
    assert.equal(session.status, 200);
    assert.equal(session.json.id, member.json.id);
    assert.equal((await request(route, { session })).status, 403);
    assert.equal((await post(request, route, input, session)).status, 403);
    const list = (await request(route, { session: admin })).json;
    const { csrf, ...primary } = admin.json;
    assert.ok(csrf);
    assert.deepEqual(list, {
      users: [primary, backup.json, member.json],
    });
    assert.equal(
      (await request("/admin/keys", { session: admin })).status,
      404,
    );
  } finally {
    await api.stop();
  }
});

test("session replacement and logout revoke real tokens; expired sessions can still log out", async (t) => {
  const { dir, code } = fixture(t);
  const api = await serve(dir);
  try {
    const first = await post(api.request, "/setup", { code: code(), password });
    const login = { login: "admin", password };
    const wrong = await post(api.request, "/login", {
      ...login,
      password: memberPassword,
    });
    const unknown = await post(api.request, "/login", {
      ...login,
      login: "unknown@example.test",
    });
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.json, unknown.json);
    assert.equal(
      (
        await post(api.request, "/login", login, undefined, {
          "sec-fetch-site": "cross-site",
        })
      ).status,
      403,
    );
    const second = await post(api.request, "/login", login, first);
    assert.equal(second.status, 200);
    assert.equal(second.json.id, first.json.id);
    assert.notEqual(second.cookie, first.cookie);
    assert.notEqual(second.json.csrf, first.json.csrf);
    assert.equal((await api.request("/me", { session: first })).status, 401);
    assert.equal(
      (
        await post(api.request, "/logout", {}, second, {
          "x-csrf-token": first.json.csrf,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await post(api.request, "/logout", {}, second, {
          origin: "https://other.invalid",
        })
      ).status,
      403,
    );
    const saved = api.db
      .prepare("SELECT hash FROM account_sessions")
      .get().hash;
    assert.equal(saved, sha256(second.cookie.split("=")[1]));
    api.db.prepare("UPDATE account_sessions SET expires=0").run();
    assert.equal((await api.request("/me", { session: second })).status, 401);
    const loggedOut = await post(api.request, "/logout", {}, second);
    assert.equal(loggedOut.status, 200);
    assert.match(loggedOut.headers.get("set-cookie"), /^canvas_session=;/);
    assert.equal(
      api.db.prepare("SELECT * FROM account_sessions").get(),
      undefined,
    );

    const malformed = await fetch(api.origin + "/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "test-secret-not-json",
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(malformed.status, 400);
    assert.doesNotMatch(await malformed.text(), /test-secret-not-json/);
  } finally {
    await api.stop();
  }
});

test("legacy administrator migrates while retired member workspaces stay inactive and preserved", async (t) => {
  const { dir, code } = fixture(t);
  const legacy = new DatabaseSync(path.join(dir, "studio.sqlite"));
  legacy.exec(`
    CREATE TABLE keys(id TEXT PRIMARY KEY,hash TEXT UNIQUE,name TEXT,role TEXT,disabled INTEGER,expires TEXT);
    CREATE TABLE sessions(hash TEXT PRIMARY KEY,owner TEXT,csrf TEXT,expires INTEGER);
    CREATE TABLE settings(owner TEXT PRIMARY KEY,json TEXT);
    CREATE TABLE providers(id TEXT PRIMARY KEY,owner TEXT,name TEXT,baseUrl TEXT,apiKey TEXT,kind TEXT,allowPrivate INTEGER DEFAULT 0,shared INTEGER DEFAULT 0);
    CREATE TABLE jobs(id TEXT PRIMARY KEY,owner TEXT,form TEXT,status TEXT,created TEXT);
  `);
  const oldToken = "0".repeat(64),
    oldAdminKey = "legacy administrator fixture key";
  const insertKey = legacy.prepare("INSERT INTO keys VALUES(?,?,?,?,?,?)");
  insertKey.run(
    "old-admin",
    sha256(oldAdminKey),
    "Legacy Administrator",
    "admin",
    0,
    null,
  );
  insertKey.run(
    "old-member",
    sha256("legacy member fixture key"),
    "Legacy Member",
    "user",
    0,
    null,
  );
  legacy
    .prepare("INSERT INTO sessions VALUES(?,?,?,?)")
    .run(sha256(oldToken), "old-admin", "old-csrf", Date.now() + 3600000);
  legacy
    .prepare("INSERT INTO settings VALUES(?,?)")
    .run(
      "site",
      '{"title":"Custom Studio","icon":"data:image/png;base64,YQ=="}',
    );
  legacy
    .prepare("INSERT INTO settings VALUES(?,?)")
    .run("old-member", '{"form":{"prompt":"preserved"}}');
  legacy
    .prepare("INSERT INTO providers VALUES(?,?,?,?,?,?,?,?)")
    .run(
      "p",
      "old-admin",
      "Legacy",
      "https://example.test",
      "fixture provider credential",
      "mixed",
      0,
      1,
    );
  const form = JSON.stringify({
    prompt: "original\nnewlines",
    references: ["legacy-image"],
    size: "1024x1024",
    autoSize: false,
  });
  legacy
    .prepare("INSERT INTO jobs VALUES(?,?,?,?,?)")
    .run("legacy-job", "old-member", form, "succeeded", "2025-01-01");
  legacy.close();

  let api = await serve(dir);
  try {
    assert.equal(api.db.prepare("SELECT * FROM sessions").get(), undefined);
    assert.deepEqual((await api.request("/site")).json, {
      title: "Custom Studio",
      icon: "data:image/png;base64,YQ==",
    });
    assert.equal(
      (
        await api.request("/me", {
          headers: { cookie: `canvas_session=${oldToken}` },
        })
      ).status,
      401,
    );
    const admin = await post(api.request, "/setup", { code: code(), password });
    assert.equal(admin.json.id, "old-admin");
    assert.equal(admin.json.name, "Legacy Administrator");
    assert.equal(
      (
        await api.request("/me", {
          headers: { authorization: `Bearer ${oldAdminKey}` },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await post(api.request, "/login", {
          login: "admin",
          password: oldAdminKey,
        })
      ).status,
      401,
    );
    const { csrf, ...primary } = admin.json;
    assert.ok(csrf);
    assert.deepEqual(
      (await api.request("/admin/users", { session: admin })).json,
      { users: [primary] },
    );
    const input = {
      email: "new-member@example.test",
      role: "user",
      concurrency: 2,
      password: memberPassword,
    };
    for (const legacyId of [
      "old-member", "old-admin", "missing", "", null, 1, {},
    ]) {
      const rejected = await post(
        api.request,
        "/admin/users",
        { ...input, legacyId },
        admin,
      );
      assert.equal(rejected.status, 400);
    }
    assert.equal(
      api.db.prepare("SELECT count(*) AS n FROM accounts").get().n,
      1,
    );
    const created = await post(api.request, "/admin/users", input, admin);
    assert.equal(created.status, 201);
    assert.match(
      created.json.id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(
      api.db.prepare("SELECT id FROM accounts WHERE id='old-member'").get(),
      undefined,
    );
    assert.deepEqual(
      (await api.request("/admin/users", { session: admin })).json,
      { users: [primary, created.json] },
    );
    assert.equal(
      api.db
        .prepare(
          "SELECT shared FROM providers WHERE id='p' AND owner='old-admin'",
        )
        .get().shared,
      1,
    );
    assert.equal(
      api.db
        .prepare(
          "SELECT form FROM jobs WHERE id='legacy-job' AND owner='old-member'",
        )
        .get().form,
      form,
    );
    await api.stop();
    api = await serve(dir);
    assert.deepEqual((await api.request("/setup")).json, { required: false });
    const member = await post(api.request, "/login", {
      login: created.json.email,
      password: memberPassword,
    });
    assert.equal(member.json.id, created.json.id);
    assert.deepEqual(
      (await api.request("/settings", { session: member })).json,
      {},
    );
    assert.deepEqual(
      (await api.request("/jobs", { session: member })).json,
      [],
    );
    assert.equal(
      api.db
        .prepare("SELECT json FROM settings WHERE owner='old-member'")
        .get().json,
      '{"form":{"prompt":"preserved"}}',
    );
    assert.equal(
      api.db.prepare("SELECT name FROM keys WHERE id='old-member'").get().name,
      "Legacy Member",
    );
    api.db
      .prepare("UPDATE settings SET json=? WHERE owner=?")
      .run('{"title":"Bi.mage","icon":""}', "site");
    assert.deepEqual((await api.request("/site")).json, {
      title: "Bimage",
      icon: "/Bimage.png",
    });
  } finally {
    await api.stop();
  }
});
