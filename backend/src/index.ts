import { readFileSync } from "node:fs";
import path from "node:path";
import { createApp } from "./app.js";

process.umask(0o077);
const dir =
  process.env.DATA_DIR || path.resolve(import.meta.dirname, "../../data");
const port = process.env.PORT === undefined ? 6768 : Number(process.env.PORT);
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error("Invalid PORT");
const service = await createApp({
  dir,
  concurrency: Math.max(1, Math.min(8, Number(process.env.CONCURRENCY) || 1)),
});
const server = service.app.listen(port, process.env.HOST || "0.0.0.0", () => {
  const address = server.address();
  const { version } = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  console.log(
    `Bimage-panel REST ${version} listening on ` +
      (typeof address === "object" && address ? address.port : port),
  );
});
let stopping = false;
function stop(): void {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => process.exit(1), 5000);
  timeout.unref();
  server.close(() => {
    void service.close().then(() => {
      clearTimeout(timeout);
      process.exit(0);
    });
  });
  // Abort upstream before waiting for open HTTP connections to finish.
  void service.close();
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
