import { randomBytes, randomUUID } from "node:crypto";
import type { Express, Request, Response, CookieOptions } from "express";
import rateLimit from "express-rate-limit";
import { Store, hash } from "./db.js";
import { admin, body, fail, param, user } from "./http.js";
import type { KeyRow, SessionRow } from "./types.js";

const SESSION_LIFETIME = 7 * 86400000;
const cookieOptions = (): CookieOptions => ({
  path: "/",
  httpOnly: true,
  sameSite: "strict",
  secure: process.env.COOKIE_SECURE === "true",
});
const cookieToken = (request: Request): string | undefined =>
  request.headers.cookie?.match(/(?:^|;\s*)canvas_session=([^;]+)/)?.[1];
export function validKey(key: KeyRow | undefined): key is KeyRow {
  return (
    !!key &&
    !key.disabled &&
    (!key.expires || Date.parse(key.expires) > Date.now())
  );
}
const view = (key: KeyRow) => ({
  id: key.id,
  name: key.name,
  role: key.role,
  disabled: !!key.disabled,
  expires: key.expires,
});
function createSession(store: Store, owner: string) {
  const token = randomBytes(32).toString("hex");
  const csrf = randomBytes(24).toString("hex");
  store.run(
    "INSERT INTO sessions VALUES(?,?,?,?)",
    hash(token),
    owner,
    csrf,
    Date.now() + SESSION_LIFETIME,
  );
  return { token, csrf };
}
function setSessionCookie(response: Response, token: string): void {
  response.cookie("canvas_session", token, {
    ...cookieOptions(),
    maxAge: SESSION_LIFETIME,
  });
}
export function mountAuthentication(app: Express, store: Store): void {
  app.post(
    "/api/login",
    rateLimit({ windowMs: 900000, limit: 20 }),
    (request, response) => {
      const key = store.get<KeyRow>(
        "SELECT * FROM keys WHERE hash=?",
        hash(String(body(request).key || "")),
      );
      if (!validKey(key)) throw fail(401, "访问密钥无效或已停用");
      const session = createSession(store, key.id);
      setSessionCookie(response, session.token);
      response.json({ ...view(key), csrf: session.csrf });
    },
  );
  // This route deliberately precedes validity checks: stale identities can still revoke cookies.
  app.post("/api/logout", (request, response) => {
    if (
      request.headers["sec-fetch-site"] === "cross-site" ||
      (request.headers.origin &&
        request.headers.origin !==
          `${request.protocol}://${request.get("host")}`)
    )
      throw fail(403, "跨站请求被拒绝");
    const token = cookieToken(request);
    const session = token
      ? store.get<SessionRow>(
          "SELECT * FROM sessions WHERE hash=?",
          hash(token),
        )
      : undefined;
    if (session && request.headers["x-csrf-token"] !== session.csrf)
      throw fail(403, "CSRF 校验失败");
    if (token) store.run("DELETE FROM sessions WHERE hash=?", hash(token));
    response.clearCookie("canvas_session", cookieOptions());
    response.json({ ok: true });
  });
  app.use("/api", (request, response, next) => {
    if (request.path === "/site" || request.path === "/login") {
      next();
      return;
    }
    const bearer = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    let key: KeyRow | undefined;
    if (bearer)
      key = store.get<KeyRow>("SELECT * FROM keys WHERE hash=?", hash(bearer));
    else {
      const token = cookieToken(request);
      const session = token
        ? store.get<SessionRow>(
            "SELECT * FROM sessions WHERE hash=? AND expires>?",
            hash(token),
            Date.now(),
          )
        : undefined;
      if (session) {
        key = store.get<KeyRow>("SELECT * FROM keys WHERE id=?", session.owner);
        response.locals.csrf = session.csrf;
        if (
          !["GET", "HEAD"].includes(request.method) &&
          request.headers["x-csrf-token"] !== session.csrf
        ) {
          next(fail(403, "CSRF 校验失败"));
          return;
        }
      }
    }
    if (!validKey(key)) {
      next(fail(401, "请登录"));
      return;
    }
    response.locals.user = key;
    next();
  });
  app.get("/api/me", (request, response) =>
    response.json({ ...view(user(request)), csrf: response.locals.csrf }),
  );
  app.post("/api/admin/rotate-key", admin, (request, response) => {
    const input = body(request);
    if (input.confirm !== true) throw fail(400, "必须确认更换管理员密钥");
    const identity = user(request);
    const session = store.transaction(() => {
      const current = store.get<KeyRow>(
        "SELECT * FROM keys WHERE id=?",
        identity.id,
      );
      if (
        !validKey(current) ||
        current.role !== "admin" ||
        hash(String(input.currentKey || "")) !== current.hash
      )
        throw fail(401, "当前管理员密钥不正确");
      const replacement = input.newKey;
      if (
        typeof replacement !== "string" ||
        replacement.length < 16 ||
        replacement.length > 256 ||
        !replacement.trim() ||
        /[\u0000-\u001f\u007f-\u009f]/.test(replacement) ||
        replacement !== input.confirmKey ||
        hash(replacement) === current.hash ||
        store.get("SELECT id FROM keys WHERE hash=?", hash(replacement))
      )
        throw fail(
          400,
          "新密钥无效，请使用16–256字符、无控制字符且两次一致的不同密钥",
        );
      store.run(
        "UPDATE keys SET hash=? WHERE id=?",
        hash(replacement),
        current.id,
      );
      store.run("DELETE FROM sessions WHERE owner=?", current.id);
      return createSession(store, current.id);
    });
    response.set("Cache-Control", "no-store");
    setSessionCookie(response, session.token);
    response.json({ ok: true, csrf: session.csrf });
  });
  app.get("/api/admin/keys", admin, (_request, response) =>
    response.json(store.all<KeyRow>("SELECT * FROM keys").map(view)),
  );
  app.post("/api/admin/keys", admin, (request, response) => {
    const input = body(request),
      role = input.role ?? "user",
      expires = input.expires ?? null;
    if (
      typeof input.name !== "string" ||
      !input.name.trim() ||
      role !== "user" ||
      (expires !== null &&
        (typeof expires !== "string" || !Number.isFinite(Date.parse(expires))))
    )
      throw fail(400, "密钥参数无效");
    const key = randomBytes(32).toString("base64url"),
      id = randomUUID();
    store.run(
      "INSERT INTO keys VALUES(?,?,?,?,0,?)",
      id,
      hash(key),
      input.name.slice(0, 100),
      role,
      expires,
    );
    response.json({ id, key });
  });
  function preserveAdmin(action: () => void): void {
    store.transaction(() => {
      action();
      const admins = store.all<KeyRow>("SELECT * FROM keys WHERE role='admin'");
      if (admins.length !== 1 || admins[0].disabled || admins[0].expires)
        throw fail(400, "必须保留唯一、已启用且永不过期的管理员");
    });
  }
  app.patch("/api/admin/keys/:id", admin, (request, response) => {
    const id = param(request),
      input = body(request);
    if (id === user(request).id) throw fail(400, "不能修改自己的管理密钥");
    const key = store.get<KeyRow>("SELECT * FROM keys WHERE id=?", id);
    if (!key) throw fail(404, "密钥不存在");
    if ((input.role || key.role) !== "user")
      throw fail(400, "管理员唯一，不可提升成员权限");
    const expires = input.expires === undefined ? key.expires : input.expires;
    if (
      expires !== null &&
      (typeof expires !== "string" || !Number.isFinite(Date.parse(expires)))
    )
      throw fail(400, "过期时间无效");
    preserveAdmin(() =>
      store.run(
        "UPDATE keys SET disabled=?,role=?,expires=? WHERE id=?",
        input.disabled === undefined ? key.disabled : Number(!!input.disabled),
        "user",
        expires,
        id,
      ),
    );
    response.json({ ok: true });
  });
  app.delete("/api/admin/keys/:id", admin, (request, response) => {
    const id = param(request);
    if (id === user(request).id) throw fail(400, "不能删除自己");
    preserveAdmin(() => {
      store.run("DELETE FROM keys WHERE id=?", id);
      store.run("DELETE FROM sessions WHERE owner=?", id);
    });
    response.json({ ok: true });
  });
}
