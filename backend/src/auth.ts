import { randomBytes, randomUUID } from "node:crypto";
import type { Express, Request, Response, CookieOptions } from "express";
import rateLimit from "express-rate-limit";
import { Store, hash } from "./db.js";
import { body, fail, requireSameOrigin, user } from "./http.js";
import {
  hashPassword,
  isPassword,
  verifyPassword,
} from "./account-password.js";
import { SetupCode, setupRequired } from "./account-setup.js";
import { accountEmail, accountView, mountUsers } from "./account-users.js";
import type { ClientRateLimitKey } from "./client-rate-limit.js";
import type { Account, AccountRow, Identity, SessionRow } from "./types.js";

const SESSION_LIFETIME = 7 * 86400000;
const COOKIE_NAME = "canvas_session";
const cookieOptions = (request: Request): CookieOptions => ({
  path: "/",
  httpOnly: true,
  sameSite: "strict",
  secure: request.secure || process.env.COOKIE_SECURE === "true",
});
const sessionHash = (request: Request): string | undefined => {
  const token = request.headers.cookie?.match(
    /(?:^|;\s*)canvas_session=([0-9a-f]{64})(?:;|$)/,
  )?.[1];
  return token && hash(token);
};

function createSession(store: Store, account: Account, previousHash?: string) {
  const token = randomBytes(32).toString("hex");
  const csrf = randomBytes(24).toString("hex");
  if (previousHash)
    store.run("DELETE FROM account_sessions WHERE hash=?", previousHash);
  store.run("DELETE FROM account_sessions WHERE expires<=?", Date.now());
  store.run(
    "INSERT INTO account_sessions(hash,owner,csrf,expires) VALUES(?,?,?,?)",
    hash(token),
    account.id,
    csrf,
    Date.now() + SESSION_LIFETIME,
  );
  const identity: Identity = { ...accountView(account), csrf };
  return { token, identity };
}
function sendSession(
  request: Request,
  response: Response,
  session: ReturnType<typeof createSession>,
) {
  response.cookie(COOKIE_NAME, session.token, {
    ...cookieOptions(request),
    maxAge: SESSION_LIFETIME,
  });
  response.json(session.identity);
}
const rate = (keyGenerator: ClientRateLimitKey) =>
  rateLimit({
    keyGenerator,
    windowMs: 15 * 60_000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "请求过于频繁，请稍后再试" },
  });

export function mountAuthentication(
  app: Express,
  store: Store,
  installer: SetupCode,
  keyGenerator: ClientRateLimitKey,
): void {
  app.use(
    ["/api/setup", "/api/login", "/api/logout", "/api/me", "/api/admin/users"],
    (_request, response, next) => {
      response.set("Cache-Control", "no-store");
      next();
    },
  );
  app.get("/api/setup", (_request, response) => {
    response.json({ required: setupRequired(store) });
  });
  app.post("/api/setup", rate(keyGenerator), async (request, response) => {
    requireSameOrigin(request);
    if (!setupRequired(store)) throw fail(409, "初始化已完成");
    const input = body(request);
    if (!installer.matches(input.token)) throw fail(403, "初始化链接无效");
    const email = accountEmail(input.email);
    const passwordHash = await hashPassword(input.password);
    const session = store.transaction(() => {
      if (!setupRequired(store)) throw fail(409, "初始化已完成");
      const old = store.legacyAdminRows()[0];
      const account: Account = {
        id: old?.id ?? randomUUID(),
        name: old?.name || "Administrator",
        email,
        role: "admin",
        concurrency: 1,
      };
      store.run(
        "INSERT INTO accounts(id,name,role,concurrency,email,passwordHash) VALUES(?,?,?,?,?,?)",
        account.id,
        account.name,
        account.role,
        account.concurrency,
        account.email,
        passwordHash,
      );
      return createSession(store, account, sessionHash(request));
    });
    installer.remove();
    sendSession(request, response, session);
  });
  app.post("/api/login", rate(keyGenerator), async (request, response) => {
    requireSameOrigin(request);
    const input = body(request);
    const login =
      typeof input.login === "string" && input.login.length <= 254
        ? input.login.trim().toLowerCase()
        : "";
    const invalid = () => fail(401, "账号或密码无效");
    if (!login || !isPassword(input.password)) throw invalid();
    const account = store.get<AccountRow>(
      "SELECT * FROM accounts WHERE email=?",
      login,
    );
    if (
      !(await verifyPassword(input.password, account?.passwordHash)) ||
      !account
    )
      throw invalid();
    const session = store.transaction(() =>
      createSession(store, account, sessionHash(request)),
    );
    sendSession(request, response, session);
  });
  app.post("/api/logout", (request, response) => {
    requireSameOrigin(request);
    const digest = sessionHash(request);
    const session =
      digest &&
      store.get<SessionRow>(
        "SELECT * FROM account_sessions WHERE hash=?",
        digest,
      );
    if (session && request.headers["x-csrf-token"] !== session.csrf)
      throw fail(403, "CSRF 校验失败");
    if (digest) store.run("DELETE FROM account_sessions WHERE hash=?", digest);
    response.clearCookie(COOKIE_NAME, cookieOptions(request));
    response.json({ ok: true });
  });
  app.use("/api", (request, response, next) => {
    const digest = sessionHash(request);
    const identity =
      digest &&
      store.get<Identity>(
        `SELECT accounts.id,accounts.name,accounts.role,accounts.email,accounts.concurrency,account_sessions.csrf
       FROM account_sessions JOIN accounts ON accounts.id=account_sessions.owner
       WHERE account_sessions.hash=? AND account_sessions.expires>?`,
        digest,
        Date.now(),
      );
    if (!identity) throw fail(401, "请登录");
    if (!["GET", "HEAD"].includes(request.method)) {
      requireSameOrigin(request);
      if (request.headers["x-csrf-token"] !== identity.csrf)
        throw fail(403, "CSRF 校验失败");
    }
    response.locals.user = accountView(identity);
    response.locals.csrf = identity.csrf;
    next();
  });
  app.get("/api/me", (request, response) => {
    response.json({ ...user(request), csrf: response.locals.csrf });
  });
  mountUsers(app, store);
}
