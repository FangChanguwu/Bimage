import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { Store } from "./db.js";
import { hash } from "./db.js";

const pattern = /^[A-Za-z0-9_-]{43}$/;
const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

export function setupRequired(store: Store): boolean {
  return !store.get("SELECT 1 FROM accounts WHERE role='admin' LIMIT 1");
}

/** Share one private setup token across restarts and concurrent processes. */
export class SetupCode {
  private file: string;
  private digest?: Buffer;
  link?: string;
  constructor(store: Store, dir: string) {
    this.file = path.join(dir, "setup-code.txt");
    store.transaction(() => {
      if (!setupRequired(store)) {
        this.remove();
        return;
      }
      // Only explicit operator configuration may determine the public origin.
      let url: URL;
      try {
        url = new URL(process.env.BIMAGE_PUBLIC_URL ?? "http://localhost:6767");
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username || url.password || url.pathname !== "/" || url.search || url.hash
        ) throw new Error();
      } catch {
        throw new Error("BIMAGE_PUBLIC_URL must be an HTTP(S) origin without credentials, path, query or fragment");
      }
      let fd: number;
      try {
        fd = openSync(
          this.file,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
        const code = randomBytes(32).toString("base64url");
        writeFileSync(this.file, code + "\n", { mode: 0o600, flag: "wx" });
        this.digest = Buffer.from(hash(code), "hex");
        url.searchParams.set("setup_token", code);
        this.link = url.href;
        return;
      }
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size !== 44)
          throw new Error(
            "setup-code.txt must be a regular mode-0600 file containing a generated code",
          );
        const line = readFileSync(fd, "utf8");
        const code = line.slice(0, -1);
        if (!line.endsWith("\n") || !pattern.test(code))
          throw new Error(
            "Invalid setup-code.txt; remove it and restart to regenerate the installer code",
          );
        this.digest = Buffer.from(hash(code), "hex");
        url.searchParams.set("setup_token", code);
        this.link = url.href;
      } finally {
        closeSync(fd);
      }
    });
  }
  matches(value: unknown): boolean {
    return (
      !!this.digest &&
      typeof value === "string" &&
      pattern.test(value) &&
      timingSafeEqual(this.digest, Buffer.from(hash(value), "hex"))
    );
  }
  remove(): void {
    this.digest = undefined;
    this.link = undefined;
    try {
      unlinkSync(this.file);
    } catch (error) {
      // An already completed setup is enforced by SQLite even if cleanup fails.
      if (!hasCode(error, "ENOENT"))
        console.warn("Could not remove consumed setup-code.txt");
    }
  }
}
