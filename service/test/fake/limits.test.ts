import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { testPool } from "../helpers/db.ts";
import { testServer } from "../helpers/app.ts";
import type { Pool } from "../../src/db/pool.ts";

let pool: Pool;
before(async () => {
  pool = await testPool();
});
beforeEach(async () => {
  await pool.query("truncate sync_jobs, updates");
});
after(async () => {
  await pool.end();
});

const oneChunk = (accommodationId: string, day = "2026-10-01") => ({
  accommodationId,
  from: day,
  to: day,
  available: true,
  pricePerNight: 10,
});

async function jobCount(): Promise<number> {
  return (await pool.query("select count(*)::int as n from sync_jobs")).rows[0].n;
}

test("SEC-03: an accommodation may not pile up more than the cap of waiting jobs; others are unaffected", async () => {
  const { app } = testServer(pool, { limits: { updatesRateLimitPerMinute: 1000, maxPendingJobsPerAccommodation: 2, maxPendingJobs: 100 } });
  assert.equal((await app.inject({ method: "POST", url: "/updates", payload: oneChunk("acc-1", "2026-10-01") })).statusCode, 202);
  assert.equal((await app.inject({ method: "POST", url: "/updates", payload: oneChunk("acc-1", "2026-10-02") })).statusCode, 202);
  const third = await app.inject({ method: "POST", url: "/updates", payload: oneChunk("acc-1", "2026-10-03") });
  assert.equal(third.statusCode, 429);
  assert.equal(third.json().error.code, "QUEUE_FULL");
  assert.equal(await jobCount(), 2, "nothing was written for the refused update");
  assert.equal((await app.inject({ method: "POST", url: "/updates", payload: oneChunk("acc-2") })).statusCode, 202);
  // Re-editing a day already waiting supersedes it and so stays within the cap.
  assert.equal((await app.inject({ method: "POST", url: "/updates", payload: oneChunk("acc-1", "2026-10-02") })).statusCode, 202);
  await app.close();
});

test("SEC-03: beyond the global cap the service answers 503 QUEUE_FULL", async () => {
  const { app } = testServer(pool, { limits: { updatesRateLimitPerMinute: 1000, maxPendingJobsPerAccommodation: 100, maxPendingJobs: 3 } });
  for (const id of ["acc-1", "acc-2", "acc-3"]) {
    assert.equal((await app.inject({ method: "POST", url: "/updates", payload: oneChunk(id) })).statusCode, 202);
  }
  const full = await app.inject({ method: "POST", url: "/updates", payload: oneChunk("acc-4") });
  assert.equal(full.statusCode, 503);
  assert.equal(full.json().error.code, "QUEUE_FULL");
  assert.equal(await jobCount(), 3);
  await app.close();
});

test("SEC-03: a client address is held to the per-minute rate and told when to retry; reads are not limited", async () => {
  const { app } = testServer(pool, { limits: { updatesRateLimitPerMinute: 2, maxPendingJobsPerAccommodation: 100, maxPendingJobs: 100 } });
  assert.equal((await app.inject({ method: "POST", url: "/updates", payload: oneChunk("acc-1") })).statusCode, 202);
  assert.equal((await app.inject({ method: "POST", url: "/updates", payload: oneChunk("acc-2") })).statusCode, 202);
  const limited = await app.inject({ method: "POST", url: "/updates", payload: oneChunk("acc-3") });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, "RATE_LIMITED");
  assert.match(limited.headers["retry-after"] as string, /^[1-9][0-9]*$/);
  assert.equal(await jobCount(), 2);
  const other = await app.inject({ method: "POST", url: "/updates", payload: oneChunk("acc-3"), remoteAddress: "10.0.0.9" });
  assert.equal(other.statusCode, 202, "another client has its own budget");
  for (let i = 0; i < 5; i++) {
    assert.equal((await app.inject({ method: "GET", url: "/accommodations/acc-1/sync-status" })).statusCode, 200);
  }
  await app.close();
});
