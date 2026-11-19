import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";

export const hash = (secret: string): string =>
  createHash("sha256").update(secret).digest("hex");
/** SQL result casts are confined to this boundary; callers name the selected row shape. */
export class Store {
  readonly db: DatabaseSync;
  constructor(dir: string, adminKey?: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(dir, "studio.sqlite"));
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS keys(id TEXT PRIMARY KEY,hash TEXT UNIQUE,name TEXT,role TEXT,disabled INTEGER DEFAULT 0,expires TEXT);
        CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,owner TEXT,csrf TEXT,expires INTEGER);
        CREATE TABLE IF NOT EXISTS providers(id TEXT PRIMARY KEY,owner TEXT,name TEXT,baseUrl TEXT,apiKey TEXT,kind TEXT,allowPrivate INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS settings(owner TEXT PRIMARY KEY,json TEXT);
        CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,owner TEXT,mime TEXT,bytes BLOB);
        CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,owner TEXT,form TEXT,status TEXT,created TEXT);
        CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,job TEXT,status TEXT,attempts INTEGER DEFAULT 0,next INTEGER DEFAULT 0,asset TEXT,error TEXT);
      `);
      const additions: Record<string, Record<string, string>> = {
        jobs: { startedAt: "TEXT", finishedAt: "TEXT" },
        tasks: { startedAt: "TEXT", finishedAt: "TEXT" },
        assets: { width: "INTEGER", height: "INTEGER" },
        providers: { models: "TEXT DEFAULT '[]'", shared: "INTEGER DEFAULT 0" },
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
      if (
        this.get<{ n: number }>(
          "SELECT count(*) n FROM keys WHERE role='admin'",
        )!.n > 1
      )
        throw new Error(
          "Multiple administrators found; explicit migration required",
        );
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS unique_administrator ON keys(role) WHERE role='admin'",
      );
      if (!this.get("SELECT id FROM keys LIMIT 1")) {
        if (!adminKey) throw new Error("Bootstrap key required");
        this.run(
          "INSERT INTO keys(id,hash,name,role) VALUES(?,?,?,?)",
          randomUUID(),
          hash(adminKey),
          "Administrator",
          "admin",
        );
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
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
