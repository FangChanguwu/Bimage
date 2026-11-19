import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { createApp } from "../dist/app.js";

test("additive migration upgrades original SQLite columns without replacing stored records", async () => {
  const dir = mkdtempSync(path.join(process.env.TMPDIR, "bimage-schema-"));
  const legacy = new DatabaseSync(path.join(dir, "studio.sqlite"));
  legacy.exec(`
    CREATE TABLE keys(id TEXT PRIMARY KEY,hash TEXT UNIQUE,name TEXT,role TEXT,disabled INTEGER DEFAULT 0,expires TEXT);
    CREATE TABLE sessions(hash TEXT PRIMARY KEY,owner TEXT,csrf TEXT,expires INTEGER);
    CREATE TABLE providers(id TEXT PRIMARY KEY,owner TEXT,name TEXT,baseUrl TEXT,apiKey TEXT,kind TEXT,allowPrivate INTEGER DEFAULT 0);
    CREATE TABLE settings(owner TEXT PRIMARY KEY,json TEXT);
    CREATE TABLE assets(id TEXT PRIMARY KEY,owner TEXT,mime TEXT,bytes BLOB);
    CREATE TABLE jobs(id TEXT PRIMARY KEY,owner TEXT,form TEXT,status TEXT,created TEXT);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,job TEXT,status TEXT,attempts INTEGER DEFAULT 0,next INTEGER DEFAULT 0,asset TEXT,error TEXT);
  `);
  const digest = createHash("sha256").update("legacy-admin").digest("hex");
  legacy
    .prepare("INSERT INTO keys VALUES(?,?,?,?,?,?)")
    .run("stable-owner", digest, "Legacy", "admin", 0, null);
  legacy
    .prepare("INSERT INTO providers VALUES(?,?,?,?,?,?,?)")
    .run(
      "stable-provider",
      "stable-owner",
      "Legacy",
      "https://example.com",
      "fake-test-secret",
      "mixed",
      0,
    );
  const bytes = Buffer.from([1, 2, 3, 4]);
  legacy
    .prepare("INSERT INTO assets VALUES(?,?,?,?)")
    .run("original-asset", "stable-owner", "image/png", bytes);
  legacy
    .prepare("INSERT INTO settings VALUES(?,?)")
    .run(
      "stable-owner",
      '{"form":{"autoSize":false},"imageProvider":"stable-provider"}',
    );
  legacy
    .prepare("INSERT INTO jobs VALUES(?,?,?,?,?)")
    .run(
      "original-job",
      "stable-owner",
      '{"references":["original-asset"],"prompt":"saved"}',
      "running",
      "2025-01-01",
    );
  legacy
    .prepare("INSERT INTO tasks(id,job,status) VALUES(?,?,?)")
    .run("original-task", "original-job", "running");
  legacy.close();
  const service = await createApp({
    dir,
    worker: false,
    adminKey: "do-not-reset",
  });
  try {
    assert.equal(
      service.db.prepare("SELECT hash FROM keys").get().hash,
      digest,
    );
    assert.equal(
      service.db.prepare("SELECT id FROM keys").get().id,
      "stable-owner",
    );
    assert.equal(
      service.db.prepare("SELECT id FROM providers").get().id,
      "stable-provider",
    );
    assert.equal(
      service.db.prepare("SELECT models FROM providers").get().models,
      "[]",
    );
    assert.deepEqual(
      Buffer.from(service.db.prepare("SELECT bytes FROM assets").get().bytes),
      bytes,
    );
    assert.equal(
      JSON.parse(service.db.prepare("SELECT json FROM settings").get().json)
        .form.autoSize,
      false,
    );
    assert.equal(
      service.db.prepare("SELECT status FROM tasks").get().status,
      "interrupted",
    );
    assert.equal(
      service.db.prepare("SELECT form FROM jobs").get().form,
      '{"references":["original-asset"],"prompt":"saved"}',
    );
    for (const table of ["jobs", "tasks"])
      assert.ok(
        service.db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((row) => row.name === "finishedAt"),
      );
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
