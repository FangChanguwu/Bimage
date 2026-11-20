import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { fail } from "./http.js";

const MIN_PASSWORD_LENGTH = 5;
const MAX_PASSWORD_BYTES = 256;
const COST = { N: 32768, r: 8, p: 3, maxmem: 48 * 1024 * 1024 };
// Service-wide cap prevents concurrent attempts from building an unbounded crypto queue.
let inFlight = 0;
function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (inFlight >= 4) throw fail(429, "请求过于频繁，请稍后再试");
  inFlight++;
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 32, COST, (error, key) =>
      error ? reject(fail(500, "密码处理失败")) : resolve(key),
    );
  }).finally(() => inFlight--);
}
export function isPassword(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= MIN_PASSWORD_LENGTH &&
    Buffer.byteLength(value) <= MAX_PASSWORD_BYTES &&
    !!value.trim() &&
    // Reject controls and ill-formed UTF-16 rather than altering the chosen secret.
    !/[\p{Cc}\p{Cs}]/u.test(value)
  );
}
export async function hashPassword(value: unknown): Promise<string> {
  if (!isPassword(value))
    throw fail(400, "密码需至少5个字符、不超过256字节且不含控制字符");
  const salt = randomBytes(16);
  return `scrypt-v1:${salt.toString("hex")}:${(await derive(value, salt)).toString("hex")}`;
}
const dummySalt = randomBytes(16);
export async function verifyPassword(
  password: string,
  digest?: string,
): Promise<boolean> {
  const parts = digest?.match(/^scrypt-v1:([0-9a-f]{32}):([0-9a-f]{64})$/);
  const key = await derive(
    password,
    parts ? Buffer.from(parts[1], "hex") : dummySalt,
  );
  return !!parts && timingSafeEqual(key, Buffer.from(parts[2], "hex"));
}
