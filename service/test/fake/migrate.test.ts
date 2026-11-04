import { test } from "node:test";
import assert from "node:assert/strict";
import { createPool } from "../../src/db/pool.ts";
import { migrate } from "../../src/db/migrate.ts";
import { TEST_DATABASE_URL } from "../helpers/db.ts";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("DATA-01: migrations create the schema and are idempotent", async () => {
  const pool = createPool(TEST_DATABASE_URL);
  try {
    await pool.query("drop table if exists sync_jobs, updates, schema_migrations");
    const first = await migrate(pool);
    assert.deepEqual(first, ["001_init.sql"]);
    const second = await migrate(pool);
    assert.deepEqual(second, []);
    const tables = await pool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    );
    assert.deepEqual(tables.rows.map((r) => r.table_name), ["schema_migrations", "sync_jobs", "updates"]);
    const columns = await pool.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'sync_jobs' order by ordinal_position",
    );
    assert.deepEqual(columns.rows.map((r) => r.column_name), [
      "id", "seq", "update_id", "accommodation_id", "from_date", "to_date", "available", "price_per_night",
      "state", "attempts", "next_attempt_at", "locked_at", "last_error_code", "last_error_message", "last_error_at", "finished_at",
    ]);
  } finally {
    await pool.end();
  }
});

test("SEC-11: a failing migration rolls back and leaves no advisory lock behind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bad-migrations-"));
  await writeFile(join(dir, "001_bad.sql"), "create table sec11_probe (id int); select * from table_that_does_not_exist;");
  const pool = createPool(TEST_DATABASE_URL);
  try {
    await assert.rejects(migrate(pool, dir), /table_that_does_not_exist/);
    const locks = await pool.query("select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = 727001");
    assert.equal(locks.rows[0].n, 0, "the lock went with the rollback");
    const probe = await pool.query("select to_regclass('sec11_probe') as t");
    assert.equal(probe.rows[0].t, null, "the partial migration was rolled back");
    const recorded = await pool.query("select name from schema_migrations where name = '001_bad.sql'");
    assert.equal(recorded.rowCount, 0);
    assert.deepEqual(await migrate(pool), [], "a later start-up with the real migrations does not hang");
  } finally {
    await pool.end();
    await rm(dir, { recursive: true, force: true });
  }
});
