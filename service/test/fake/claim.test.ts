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

const base = { from: "2026-10-01", to: "2026-10-07", available: true, pricePerNight: 100 };

test("SYNC-02: the oldest runnable job is claimed and marked in progress in one statement", async () => {
  const a = await repository.acceptUpdate({ ...base, accommodationId: "acc-1001" });
  const b = await repository.acceptUpdate({ ...base, accommodationId: "acc-1002" });

  const first = await repository.claimNext();
  assert.ok(first);
  assert.equal(first.updateId, a.updateId);
  assert.equal(first.state, "in_progress");
  assert.equal(first.attempts, 1);
  assert.ok(first.lockedAt instanceof Date);

  const second = await repository.claimNext();
  assert.equal(second?.updateId, b.updateId);
  assert.equal(await repository.claimNext(), null, "nothing left to claim");
});

test("SYNC-02: a job whose next_attempt_at is in the future is not claimed", async () => {
  const a = await repository.acceptUpdate({ ...base, accommodationId: "acc-1001" });
  await pool.query("update sync_jobs set next_attempt_at = now() + interval '1 hour' where update_id = $1", [a.updateId]);
  assert.equal(await repository.claimNext(), null);
  await pool.query("update sync_jobs set next_attempt_at = now() where update_id = $1", [a.updateId]);
  assert.equal((await repository.claimNext())?.updateId, a.updateId);
});

test("SYNC-02: concurrent claimers never get the same job", async () => {
  for (const id of ["acc-1001", "acc-1002", "acc-1003", "acc-1004"]) {
    await repository.acceptUpdate({ ...base, accommodationId: id });
  }
  const claimed = await Promise.all([1, 2, 3, 4, 5, 6].map(() => repository.claimNext()));
  const ids = claimed.filter((j) => j !== null).map((j) => j.id);
  assert.equal(ids.length, 4);
  assert.equal(new Set(ids).size, 4);
});

test("SYNC-03: jobs of one accommodation run strictly in arrival order, one at a time", async () => {
  const first = await repository.acceptUpdate({ ...base, accommodationId: "acc-1001", from: "2026-10-01", to: "2026-11-15" }); // 2 chunks
  const second = await repository.acceptUpdate({ ...base, accommodationId: "acc-1001", from: "2026-12-01", to: "2026-12-05" });

  const chunk1 = await repository.claimNext();
  assert.equal(chunk1?.updateId, first.updateId);
  assert.equal(chunk1?.from, "2026-10-01");
  assert.equal(await repository.claimNext(), null, "newer jobs wait while chunk 1 is in progress");

  await repository.markDone(chunk1!.id);
  const chunk2 = await repository.claimNext();
  assert.equal(chunk2?.updateId, first.updateId);
  assert.equal(chunk2?.from, "2026-11-01");
  assert.equal(await repository.claimNext(), null);

  await repository.markDone(chunk2!.id);
  assert.equal((await repository.claimNext())?.updateId, second.updateId);
});

test("SYNC-03: an older job waiting out a backoff still blocks newer jobs of its accommodation", async () => {
  const older = await repository.acceptUpdate({ ...base, accommodationId: "acc-1001" });
  const newer = await repository.acceptUpdate({ ...base, accommodationId: "acc-1001", from: "2026-12-01", to: "2026-12-02" });
  await pool.query("update sync_jobs set next_attempt_at = now() + interval '1 hour' where update_id = $1", [older.updateId]);
  assert.equal(await repository.claimNext(), null, `job of ${newer.updateId} must not overtake`);
});
