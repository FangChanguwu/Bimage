import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Store } from "./db.js";
import { admin, body, fail } from "./http.js";
import { hashPassword } from "./account-password.js";
import type { Account } from "./types.js";

export const accountView = ({
  id,
  email,
  name,
  role,
  concurrency,
}: Account): Account => ({ id, email, name, role, concurrency });

function accountEmail(value: unknown): string {
  if (typeof value !== "string" || value.length > 254)
    throw fail(400, "邮箱无效");
  const email = value.trim().toLowerCase();
  const match =
    /^([a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*)@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/.exec(
      email,
    );
  if (!match || match[1].length > 64) throw fail(400, "邮箱无效");
  return email;
}

export function mountUsers(app: Express, store: Store): void {
  app.get("/api/admin/users", admin, (_request, response) => {
    const data = store.transaction(() => ({
      users: store.all<Account>(
        "SELECT id,email,name,role,concurrency FROM accounts ORDER BY email",
      ),
    }));
    response.json(data);
  });
  app.post("/api/admin/users", admin, async (request, response) => {
    const input = body(request);
    if (Object.hasOwn(input, "legacyId"))
      throw fail(400, "不再支持关联旧工作空间");
    const email = accountEmail(input.email);
    const role = input.role;
    const concurrency = input.concurrency;
    const name = input.name;
    if (
      (role !== "admin" && role !== "user") ||
      typeof concurrency !== "number" ||
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > 8 ||
      (name !== undefined &&
        (typeof name !== "string" ||
          name.length > 100 ||
          /[\p{Cc}\p{Cs}]/u.test(name)))
    )
      throw fail(400, "用户参数无效");
    const passwordHash = await hashPassword(input.password);
    const account: Account = {
      id: randomUUID(),
      email,
      name: name?.trim() || email,
      role,
      concurrency,
    };
    store.transaction(() => {
      if (store.get("SELECT 1 FROM accounts WHERE email=?", email))
        throw fail(409, "邮箱已被使用");
      store.run(
        "INSERT INTO accounts(id,name,role,concurrency,email,passwordHash) VALUES(?,?,?,?,?,?)",
        account.id,
        account.name,
        account.role,
        account.concurrency,
        account.email,
        passwordHash,
      );
    });
    response.status(201).json(account);
  });
}
