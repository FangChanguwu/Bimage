import { readFileSync } from "node:fs";
import path from "node:path";
import { createApp } from "./app.js";

process.umask(0o077);
const dir =
  process.env.DATA_DIR || path.resolve(import.meta.dirname, "../../data");
const port = process.env.PORT === undefined ? 6768 : Number(process.env.PORT);
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error("Invalid PORT");
let stopping = false;
let server: ReturnType<typeof service.app.listen> | undefined;
function shutdown(exitCode: number): void {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => process.exit(exitCode || 1), 5000);
  timeout.unref();
  const finish = () => {
    void service.close().then(() => {
      clearTimeout(timeout);
      process.exit(exitCode);
    });
  };
  if (server) {
    server.close(finish);
  } else {
    finish();
  }
  // Abort upstream before waiting for open HTTP connections to finish.
  void service.close();
}
const service = await createApp({
  dir,
  concurrency: Math.max(1, Math.min(8, Number(process.env.CONCURRENCY) || 1)),
  onRestart: () => shutdown(process.env.BIMAGE_LAUNCHER === "1" ? 75 : 0),
});
server = service.app.listen(port, process.env.HOST || "0.0.0.0", () => {
  const address = server?.address();
  const { version } = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  console.log(
    `Bimage-panel REST ${version} listening on ` +
      (typeof address === "object" && address ? address.port : port),
  );
  if (service.setupLink)
    console.log("First administrator setup (keep this link private): " + service.setupLink);
});
process.once("SIGTERM", () => shutdown(0));
process.once("SIGINT", () => shutdown(0));
