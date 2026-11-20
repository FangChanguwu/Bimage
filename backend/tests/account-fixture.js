import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const adminPassword = "isolated backend admin password";
export async function accountRequest(
  origin,
  pathname,
  { method = "GET", headers, body } = {},
) {
  return fetch(origin + pathname, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}
async function session(response) {
  assert.equal(response.status, 200);
  const identity = await response.json();
  return {
    identity,
    headers: {
      cookie: response.headers.get("set-cookie").split(";")[0],
      "x-csrf-token": identity.csrf,
    },
  };
}
export async function setupAccount(origin, dir, password = adminPassword) {
  const code = readFileSync(path.join(dir, "setup-code.txt"), "utf8").trim();
  return session(
    await accountRequest(origin, "/api/setup", {
      method: "POST",
      body: { code, password },
    }),
  );
}
export async function signIn(origin, login, password = adminPassword) {
  return session(
    await accountRequest(origin, "/api/login", {
      method: "POST",
      body: { login, password },
    }),
  );
}
