import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "./pool.ts";

const MIGRATIONS_DIR = join(import.meta.dirname, "migrations");

/** DATA-01: applies every migrations/*.sql not yet recorded, in name order, each in its own transaction. */
export async function migrate(pool: Pool): Promise<string[]> {
  await pool.query(`create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`);
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    // Serialises concurrent starters; the lock is released with the session.
    await client.query("select pg_advisory_lock(727001)");
    const done = new Set((await client.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [file]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
      applied.push(file);
    }
    await client.query("select pg_advisory_unlock(727001)");
  } finally {
    client.release();
  }
  return applied;
}
