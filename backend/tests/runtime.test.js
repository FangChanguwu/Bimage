import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { createApp } from "../dist/app.js";
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const isolated = (prefix) => mkdtempSync(path.join(process.env.TMPDIR, prefix));
test("runtime entrypoint creates a bootstrap-only secret and never overwrites it on restart", async () => {
  assert.ok(
    existsSync(new URL("../dist/index.js", import.meta.url)),
    "runtime entrypoint must be compiled",
  );
  const dir = isolated("bimage-runtime-"),
    secret = path.join(dir, "secret", "admin.txt");
  async function run() {
    const child = spawn(
      process.execPath,
      [new URL("../dist/index.js", import.meta.url).pathname],
      {
        env: {
          ...process.env,
          DATA_DIR: dir,
          ADMIN_KEY_FILE: secret,
          PORT: "0",
          HOST: "127.0.0.1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let log = "";
    child.stdout.on("data", (chunk) => (log += chunk));
    child.stderr.on("data", (chunk) => (log += chunk));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("entrypoint startup timed out: " + log)),
        5000,
      );
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error("entrypoint exited " + code + ": " + log));
      });
      child.stdout.on("data", () => {
        if (log.includes("listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
    }).catch((error) => {
      child.kill("SIGKILL");
      throw error;
    });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
    assert.ok(log.includes(`Bimage-panel REST ${version} listening on `), log);
  }
  try {
    await run();
    const original = readFileSync(secret, "utf8");
    assert.ok(original.trim().length >= 32);
    await run();
    assert.equal(readFileSync(secret, "utf8"), original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy schema migrates preserving identity, grants, historical form and custom branding", async () => {
  const dir = isolated("bimage-migrate-");
  let service = await createApp({ dir, adminKey: "original", worker: false });
  const owner = service.db.prepare("SELECT id FROM keys").get().id;
  const form = JSON.stringify({
    prompt: "original\nnewlines",
    references: ["legacy-image"],
    size: "1024x1024",
    autoSize: false,
  });
  service.db
    .prepare(
      "INSERT INTO providers(id,owner,name,baseUrl,apiKey,kind,shared,models) VALUES(?,?,?,?,?,?,?,?)",
    )
    .run(
      "legacy-provider",
      owner,
      "private",
      "https://example.com",
      "fake-only",
      "mixed",
      1,
      '[{"id":"legacy","types":["image"]}]',
    );
  service.db
    .prepare("INSERT INTO jobs(id,owner,form,status,created) VALUES(?,?,?,?,?)")
    .run("legacy-job", owner, form, "queued", "2025-01-01");
  service.db
    .prepare("INSERT INTO tasks(id,job,status) VALUES(?,?,?)")
    .run("legacy-task", "legacy-job", "queued");
  service.db
    .prepare("INSERT INTO settings VALUES(?,?)")
    .run(
      "site",
      '{"title":"Custom Studio","icon":"data:image/png;base64,YQ=="}',
    );
  await service.close();
  service = await createApp({
    dir,
    adminKey: "must-not-replace",
    worker: false,
  });
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.deepEqual(await (await fetch(base + "/api/site")).json(), {
      title: "Custom Studio",
      icon: "data:image/png;base64,YQ==",
    });
    assert.equal(
      service.db.prepare("SELECT owner,form FROM jobs").get().owner,
      owner,
    );
    assert.equal(service.db.prepare("SELECT form FROM jobs").get().form, form);
    assert.equal(
      service.db.prepare("SELECT shared FROM providers").get().shared,
      1,
    );
    assert.equal(
      (
        await fetch(base + "/api/me", {
          headers: { authorization: "Bearer original" },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(base + "/api/me", {
          headers: { authorization: "Bearer must-not-replace" },
        })
      ).status,
      401,
    );
    service.db
      .prepare("UPDATE settings SET json=? WHERE owner=?")
      .run('{"title":"Bi.mage","icon":""}', "site");
    assert.deepEqual(await (await fetch(base + "/api/site")).json(), {
      title: "Bimage",
      icon: "/Bimage.png",
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
