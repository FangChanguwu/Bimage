import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import sharp from "sharp";
import { createApp } from "../dist/app.js";
import { Assets } from "../dist/assets.js";
import { Store } from "../dist/db.js";
import { Thumbnails } from "../dist/thumbnails.js";
import { setupAccount, signIn } from "./account-fixture.js";

async function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "bimage-thumbnail-"));
  const service = await createApp({ dir, worker: false });
  const server = service.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const { identity, headers } = await setupAccount(base, dir);
  let members = 0;
  return {
    ...service,
    owner: identity.id,
    headers,
    request(route, options = {}) {
      return fetch(base + "/api/assets" + route, {
        headers,
        ...options,
        signal: AbortSignal.timeout(5000),
      });
    },
    insert(id, bytes, owner = identity.id, mime = "image/png") {
      service.db
        .prepare("INSERT INTO assets(id,owner,mime,bytes) VALUES(?,?,?,?)")
        .run(id, owner, mime, bytes);
    },
    async member() {
      const email = `thumb-${++members}@example.test`;
      const password = "isolated thumbnail member password";
      const response = await fetch(base + "/api/admin/users", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          name: "Thumbnail member",
          role: "user",
          concurrency: 1,
        }),
      });
      assert.equal(response.status, 201);
      const { id } = await response.json();
      return { id, ...(await signIn(base, email, password)) };
    },
  };
}

const image = (width = 960, height = 240) =>
  sharp({
    create: { width, height, channels: 3, background: "#123456" },
  })
    .png()
    .toBuffer();

function storeFixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "bimage-thumbnail-unit-"));
  const store = new Store(dir);
  t.after(() => {
    if (store.db.isOpen) store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

test("save schedules derived bytes without awaiting decode; corrupt saves remain usable originals", async (t) => {
  const store = storeFixture(t);
  const assets = new Assets(store);
  const id = assets.save("owner", await image(), "image/png");
  assert.equal(typeof id, "string");
  for (
    let i = 0;
    i < 100 && !store.get("SELECT 1 FROM asset_thumbnails WHERE asset=?", id);
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(store.get("SELECT 1 FROM asset_thumbnails WHERE asset=?", id));
  const bad = assets.save("owner", Buffer.from("bad history"), "image/png");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(
    Buffer.from(store.get("SELECT bytes FROM assets WHERE id=?", bad).bytes),
    Buffer.from("bad history"),
  );
  assert.equal(
    store.get("SELECT 1 FROM asset_thumbnails WHERE asset=?", bad),
    undefined,
  );
});

test("deduplicates concurrent work and bounds decoder concurrency to two", async (t) => {
  const store = storeFixture(t);
  const bytes = await image(20, 10);
  for (const id of ["one", "two", "three"])
    store.run(
      "INSERT INTO assets(id,owner,mime,bytes) VALUES(?,?,'image/png',?)",
      id,
      "owner",
      bytes,
    );
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const releases = [];
  const thumbnails = new Thumbnails(store, async (source) => {
    calls++;
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => releases.push(resolve));
    const result = await sharp(source).webp().toBuffer();
    active--;
    return result;
  });
  const requests = [
    thumbnails.get("one"),
    thumbnails.get("one"),
    thumbnails.get("two"),
    thumbnails.get("three"),
  ];
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 2);
  assert.equal(maximum, 2);
  releases.splice(0).forEach((release) => release());
  for (let i = 0; i < 100 && calls < 3; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 3);
  releases.splice(0).forEach((release) => release());
  const results = await Promise.all(requests);
  assert.deepEqual(results[0], results[1]);
  await thumbnails.get("one");
  assert.equal(calls, 3);
  assert.equal(maximum, 2);
});

test("database close during generation safely rejects pending and queued work without later SQL", async (t) => {
  const store = storeFixture(t);
  for (const id of ["one", "two", "three"])
    store.run(
      "INSERT INTO assets(id,owner,mime,bytes) VALUES(?,?,'image/png',?)",
      id,
      "owner",
      Buffer.from("source"),
    );
  const releases = [];
  const thumbnails = new Thumbnails(store, async () => {
    await new Promise((resolve) => releases.push(resolve));
    return Buffer.from("derived");
  });
  const requests = ["one", "two", "three"].map((id) => thumbnails.get(id));
  const checked = requests.map((request) =>
    assert.rejects(request, (error) => error.status === 503),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  store.db.close();
  releases.splice(0).forEach((release) => release());
  await Promise.all(checked);
  await assert.rejects(thumbnails.get("one"), (error) => error.status === 503);
});

test("deleting a source cascades cached bytes and does not resurrect an in-flight thumbnail", async (t) => {
  const store = storeFixture(t);
  const bytes = await image(20, 10);
  store.run(
    "INSERT INTO assets(id,owner,mime,bytes) VALUES('deleted','owner','image/png',?)",
    bytes,
  );
  let release;
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const thumbnails = new Thumbnails(store, async () => {
    started();
    await new Promise((resolve) => {
      release = resolve;
    });
    return Buffer.from("derived");
  });
  const pending = thumbnails.get("deleted");
  const rejected = assert.rejects(pending, (error) => error.status === 404);
  await ready;
  store.run("DELETE FROM assets WHERE id='deleted'");
  release();
  await rejected;
  assert.equal(store.get("SELECT count(*) n FROM asset_thumbnails").n, 0);
  store.run(
    "INSERT INTO assets(id,owner,mime,bytes) VALUES('cached','owner','image/png',?)",
    bytes,
  );
  await new Thumbnails(store).get("cached");
  assert.equal(store.get("SELECT count(*) n FROM asset_thumbnails").n, 1);
  store.run("DELETE FROM assets WHERE id='cached'");
  assert.equal(store.get("SELECT count(*) n FROM asset_thumbnails").n, 0);
});

test("lazy thumbnail is bounded WebP, cached separately, with byte-identical originals", async (t) => {
  const f = await fixture(t);
  const bytes = await image();
  f.insert("old", bytes);
  const response = await f.request("/old?variant=thumbnail");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/webp");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const preview = Buffer.from(await response.arrayBuffer());
  const metadata = await sharp(preview).metadata();
  assert.deepEqual([metadata.width, metadata.height], [480, 120]);
  assert.equal(metadata.format, "webp");
  const row = f.db
    .prepare("SELECT bytes FROM asset_thumbnails WHERE asset=?")
    .get("old");
  assert.deepEqual(Buffer.from(row.bytes), preview);
  assert.deepEqual(
    Buffer.from(await (await f.request("/old")).arrayBuffer()),
    bytes,
  );
});

test("owner and admin can read thumbnails but identical bytes never share tenant rows", async (t) => {
  const f = await fixture(t);
  const owner = await f.member();
  const other = await f.member();
  const bytes = await image(24, 12);
  f.insert("member", bytes, owner.id);
  f.insert("other", bytes, other.id);
  for (const headers of [owner.headers, f.headers]) {
    const response = await f.request("/member?variant=thumbnail", { headers });
    assert.equal(response.status, 200);
    const metadata = await sharp(
      Buffer.from(await response.arrayBuffer()),
    ).metadata();
    assert.deepEqual([metadata.width, metadata.height], [24, 12]);
  }
  assert.equal(
    (await f.request("/member?variant=thumbnail", { headers: other.headers }))
      .status,
    404,
  );
  assert.equal(
    f.db.prepare("SELECT asset FROM asset_thumbnails").all().length,
    1,
  );
  assert.equal(
    (await f.request("/other?variant=thumbnail", { headers: other.headers }))
      .status,
    200,
  );
  assert.deepEqual(
    f.db
      .prepare("SELECT asset FROM asset_thumbnails ORDER BY asset")
      .all()
      .map((row) => row.asset),
    ["member", "other"],
  );
});

test("JPEG EXIF orientation and WebP inputs produce bounded previews without rewriting source bytes", async (t) => {
  const f = await fixture(t);
  const source = await image(900, 300);
  for (const [id, bytes, mime] of [
    [
      "rotated",
      await sharp(source).jpeg().withMetadata({ orientation: 6 }).toBuffer(),
      "image/jpeg",
    ],
    ["webp", await sharp(source).webp().toBuffer(), "image/webp"],
  ]) {
    f.insert(id, bytes, f.owner, mime);
    const response = await f.request(`/${id}?variant=thumbnail`);
    assert.equal(response.status, 200);
    const metadata = await sharp(
      Buffer.from(await response.arrayBuffer()),
    ).metadata();
    assert.deepEqual(
      [metadata.width, metadata.height],
      id === "rotated" ? [160, 480] : [480, 160],
    );
    assert.deepEqual(
      Buffer.from(await (await f.request(`/${id}`)).arrayBuffer()),
      bytes,
    );
  }
});

test("corrupt and excessive-pixel history return a controlled preview error but originals stay intact", async (t) => {
  const f = await fixture(t);
  const excessive = await sharp({
    create: { width: 7000, height: 6000, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  for (const [id, bytes] of [
    ["bad", Buffer.from("not an image")],
    ["excessive", excessive],
  ]) {
    f.insert(id, bytes);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await f.request(`/${id}?variant=thumbnail`);
      assert.equal(response.status, 422);
      assert.deepEqual(await response.json(), {
        error: "无法生成缩略图，请使用原图",
      });
      assert.equal(response.headers.get("cache-control"), "private, no-store");
    }
    assert.deepEqual(
      Buffer.from(await (await f.request(`/${id}`)).arrayBuffer()),
      bytes,
    );
  }
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM asset_thumbnails").get().n,
    0,
  );
});

test("HEAD authorizes without reading blobs or generating previews, including corrupt history", async (t) => {
  const f = await fixture(t);
  const owner = await f.member();
  const other = await f.member();
  f.insert("corrupt", Buffer.from("historical corrupt bytes"), owner.id);
  const queries = [];
  const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = (sql) => {
    queries.push(sql);
    return prepare(sql);
  };
  for (const suffix of ["", "?variant=thumbnail"]) {
    for (const headers of [owner.headers, f.headers]) {
      const response = await f.request("/corrupt" + suffix, {
        method: "HEAD",
        headers,
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.equal(await response.text(), "");
    }
    for (const method of ["GET", "HEAD"]) {
      assert.equal(
        (
          await f.request("/corrupt" + suffix, {
            method,
            headers: other.headers,
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await f.request("/missing" + suffix, {
            method,
            headers: owner.headers,
          })
        ).status,
        404,
      );
      assert.equal(
        (await f.request("/corrupt" + suffix, { method, headers: {} })).status,
        401,
      );
    }
  }
  f.db.prepare = prepare;
  const assetQueries = queries.filter((sql) => /FROM assets\b/.test(sql));
  assert.ok(assetQueries.length > 0);
  assert.ok(
    assetQueries.every((sql) => !/SELECT \*|\bbytes\b/.test(sql)),
    assetQueries.join("\n"),
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM asset_thumbnails").get().n,
    0,
  );
});
