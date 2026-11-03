import { createPool, type Pool } from "../../src/db/pool.ts";
import { migrate } from "../../src/db/migrate.ts";

export const TEST_DATABASE_URL = process.env.DATABASE_URL ?? "postgres://sync:sync@localhost:5432/sync";

/** A migrated pool with empty tables. Call `end()` when done. */
export async function testPool(): Promise<Pool> {
  const pool = createPool(TEST_DATABASE_URL);
  await migrate(pool);
  await pool.query("truncate sync_jobs, updates");
  return pool;
}
