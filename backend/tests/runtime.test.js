import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  statSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { setupAccount, signIn } from "./account-fixture.js";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

test(
  "runtime preserves its private installer code until setup, then restarts without it",
  { timeout: 15_000 },
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bimage-runtime-"));
    const file = path.join(dir, "setup-code.txt");
    async function run(check) {
      const child = spawn(
        process.execPath,
        [new URL("../dist/index.js", import.meta.url).pathname],
        {
          env: { ...process.env, DATA_DIR: dir, PORT: "0", HOST: "127.0.0.1" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const exited = once(child, "exit");
      let log = "";
      let match;
      child.stderr.on("data", (chunk) => {
        log += chunk;
      });
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("entrypoint startup timed out: " + log)),
            5000,
          );
          child.once("exit", (code) => {
            clearTimeout(timer);
            reject(new Error("entrypoint exited " + code + ": " + log));
          });
          child.stdout.on("data", (chunk) => {
            log += chunk;
            match = log.match(/Bimage-panel REST \S+ listening on (\d+)/);
            if (match) {
              clearTimeout(timer);
              resolve();
            }
          });
        });
        await check(`http://127.0.0.1:${match[1]}`);
      } finally {
        child.kill("SIGTERM");
        await exited;
      }
      assert.match(
        log,
        new RegExp(
          `Bimage-panel REST ${version.replaceAll(".", "\\.")} listening on `,
        ),
      );
      return log;
    }
    try {
      let original, id;
      const firstLog = await run(async () => {
        original = readFileSync(file, "utf8");
        assert.ok(original.trim().length >= 32);
        assert.equal(statSync(file).mode & 0o777, 0o600);
        assert.equal(existsSync(path.join(dir, "admin-key.txt")), false);
      });
      assert.equal(firstLog.includes(original.trim()), false);
      const setupLog = await run(async (origin) => {
        assert.equal(readFileSync(file, "utf8"), original);
        id = (await setupAccount(origin, dir)).identity.id;
        assert.equal(existsSync(file), false);
      });
      assert.equal(setupLog.includes(original.trim()), false);
      await run(async (origin) => {
        assert.equal(existsSync(file), false);
        assert.equal((await signIn(origin, "admin")).identity.id, id);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
