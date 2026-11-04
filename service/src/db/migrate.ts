import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "./pool.ts";

export const MIGRATIONS_DIR = join(import.meta.dirname, "migrations");
const LOCK_KEY = 727001;

/**
 * DATA-01: applies every `*.sql` in `dir` not yet recorded, in name order, in one transaction.
 * SEC-11: the advisory lock that serialises concurrent starters is transaction-scoped, so a failing
 * migration rolls back and releases it in the same step; nothing is left held on a pooled connection.
 */
export async function migrate(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await pool.query(`create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock($1)", [LOCK_KEY]);
    const done = new Set((await client.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      await client.query(await readFile(join(dir, file), "utf8"));
      await client.query("insert into schema_migrations (name) values ($1)", [file]);
      applied.push(file);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return applied;
}
