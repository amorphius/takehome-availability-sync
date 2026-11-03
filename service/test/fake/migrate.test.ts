import { test } from "node:test";
import assert from "node:assert/strict";
import { createPool } from "../../src/db/pool.ts";
import { migrate } from "../../src/db/migrate.ts";
import { TEST_DATABASE_URL } from "../helpers/db.ts";

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
