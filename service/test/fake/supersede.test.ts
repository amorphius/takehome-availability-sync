import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { testPool } from "../helpers/db.ts";
import { SyncRepository } from "../../src/sync/repository.ts";
import type { Pool } from "../../src/db/pool.ts";

let pool: Pool;
let repository: SyncRepository;
before(async () => {
  pool = await testPool();
  repository = new SyncRepository(pool);
});
beforeEach(async () => {
  await pool.query("truncate sync_jobs, updates");
});
after(async () => {
  await pool.end();
});

const base = { accommodationId: "acc-1001", available: true, pricePerNight: 100 };

async function states(updateId: string) {
  return (await repository.jobsOfUpdate(updateId)).map((j) => j.state);
}

test("SYNC-04: a pending job fully inside the new update's range is superseded", async () => {
  const old = await repository.acceptUpdate({ ...base, from: "2026-10-05", to: "2026-10-10" });
  const wide = await repository.acceptUpdate({ ...base, from: "2026-10-01", to: "2026-10-31" });
  assert.equal(wide.superseded, 1);
  assert.deepEqual(await states(old.updateId), ["superseded"]);
  assert.deepEqual(await states(wide.updateId), ["pending"]);
  const same = await repository.acceptUpdate({ ...base, from: "2026-10-01", to: "2026-10-31", available: false });
  assert.equal(same.superseded, 1, "an identical range counts as covered");
  assert.deepEqual(await states(wide.updateId), ["superseded"]);
});

test("SYNC-04: only the covered chunks of a multi-chunk update are superseded", async () => {
  const long = await repository.acceptUpdate({ ...base, from: "2026-10-01", to: "2026-12-15" }); // chunks: Oct 1-31, Nov 1-Dec 1, Dec 2-15
  const middle = await repository.acceptUpdate({ ...base, from: "2026-11-01", to: "2026-12-01" });
  assert.equal(middle.superseded, 1);
  assert.deepEqual(await states(long.updateId), ["pending", "superseded", "pending"]);
});

test("SYNC-04: partial overlaps, in-progress jobs and other accommodations are untouched", async () => {
  const partial = await repository.acceptUpdate({ ...base, from: "2026-10-05", to: "2026-10-12" });
  const other = await repository.acceptUpdate({ ...base, accommodationId: "acc-1002", from: "2026-10-05", to: "2026-10-06" });
  const running = await repository.acceptUpdate({ ...base, accommodationId: "acc-1003", from: "2026-10-05", to: "2026-10-06" });
  await pool.query("update sync_jobs set state = 'in_progress', locked_at = now() where update_id = $1", [running.updateId]);

  const wide = await repository.acceptUpdate({ ...base, from: "2026-10-01", to: "2026-10-10" });
  assert.equal(wide.superseded, 0);
  assert.deepEqual(await states(partial.updateId), ["pending"]);
  assert.deepEqual(await states(other.updateId), ["pending"]);

  const wide3 = await repository.acceptUpdate({ ...base, accommodationId: "acc-1003", from: "2026-10-01", to: "2026-10-10" });
  assert.equal(wide3.superseded, 0);
  assert.deepEqual(await states(running.updateId), ["in_progress"]);
});
