import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { IdentityBase } from "./types.js";

export const hash = (secret: string): string =>
  createHash("sha256").update(secret).digest("hex");
/** SQL result casts are confined to this boundary; callers name the selected row shape. */
export class Store {
  readonly db: DatabaseSync;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(dir, "studio.sqlite"), {
      timeout: 5000,
    });
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
      this.transaction(() => {
        const migrating = !this.hasTable("account_sessions");
        if (migrating && this.legacyAdminRows().length > 1)
          throw new Error(
            "Multiple legacy administrators found; explicit migration required",
          );
        this.assertLegacyQueueIdle(migrating);
        if (migrating && this.hasTable("sessions"))
          this.run("DELETE FROM sessions");
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS accounts(
            id TEXT NOT NULL PRIMARY KEY,
            name TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('admin','user')),
            concurrency INTEGER NOT NULL CHECK(concurrency BETWEEN 1 AND 8 AND typeof(concurrency)='integer'),
            email TEXT NOT NULL UNIQUE COLLATE NOCASE,
            passwordHash TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS account_sessions(
            hash TEXT NOT NULL PRIMARY KEY,
            owner TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            csrf TEXT NOT NULL,
            expires INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS account_session_expiry ON account_sessions(expires);
          CREATE TABLE IF NOT EXISTS providers(id TEXT PRIMARY KEY,owner TEXT,name TEXT,baseUrl TEXT,apiKey TEXT,kind TEXT,allowPrivate INTEGER DEFAULT 0);
          CREATE TABLE IF NOT EXISTS settings(owner TEXT PRIMARY KEY,json TEXT);
          CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,owner TEXT,mime TEXT,bytes BLOB);
          CREATE TABLE IF NOT EXISTS asset_thumbnails(
            asset TEXT NOT NULL PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
            bytes BLOB NOT NULL
          );
          CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,owner TEXT,form TEXT,status TEXT,created TEXT);
          CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,job TEXT,status TEXT,attempts INTEGER DEFAULT 0,next INTEGER DEFAULT 0,asset TEXT,error TEXT);
        `);
        const additions: Record<string, Record<string, string>> = {
          jobs: { startedAt: "TEXT", finishedAt: "TEXT" },
          tasks: { startedAt: "TEXT", finishedAt: "TEXT" },
          assets: { width: "INTEGER", height: "INTEGER" },
          providers: {
            models: "TEXT DEFAULT '[]'",
            shared: "INTEGER DEFAULT 0",
          },
        };
        for (const [table, fields] of Object.entries(additions)) {
          const columns = new Set(
            this.all<{ name: string }>(`PRAGMA table_info(${table})`).map(
              (column) => column.name,
            ),
          );
          for (const [column, type] of Object.entries(fields))
            if (!columns.has(column))
              this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        }
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private hasTable(name: string): boolean {
    return !!this.get(
      "SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?",
      name,
    );
  }
  legacyAdminRows(): IdentityBase[] {
    // Legacy credential digests are never read or copied by account auth.
    return this.hasTable("keys")
      ? this.all<IdentityBase>(
          "SELECT id,name,role FROM keys WHERE role='admin' ORDER BY id",
        )
      : [];
  }
  private assertLegacyQueueIdle(migrating: boolean): void {
    if (!this.hasTable("keys") || !this.hasTable("tasks")) return;
    // On later restarts only unclaimed legacy owners are still migrating.
    const pending = migrating
      ? this.get(
          "SELECT 1 FROM tasks WHERE status IN ('queued','running') LIMIT 1",
        )
      : this.hasTable("jobs") &&
        this.get(`
          SELECT 1 FROM tasks JOIN jobs ON jobs.id=tasks.job
          JOIN keys ON keys.id=jobs.owner
          LEFT JOIN accounts ON accounts.id=jobs.owner
          WHERE accounts.id IS NULL AND tasks.status IN ('queued','running') LIMIT 1
        `);
    if (pending)
      throw new Error(
        "Legacy account migration blocked: queued or running tasks remain; drain or cancel legacy work before upgrading",
      );
  }
  get<T = Record<string, unknown>>(
    sql: string,
    ...values: SQLInputValue[]
  ): T | undefined {
    return this.db.prepare(sql).get(...values) as T | undefined;
  }
  all<T = Record<string, unknown>>(
    sql: string,
    ...values: SQLInputValue[]
  ): T[] {
    return this.db.prepare(sql).all(...values) as T[];
  }
  run(sql: string, ...values: SQLInputValue[]): void {
    this.db.prepare(sql).run(...values);
  }
  transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
