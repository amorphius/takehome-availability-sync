import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { testPool } from "../helpers/db.ts";
import { FakePortal, ok, unavailable, rateLimited, notFound, hang } from "../helpers/fakePortal.ts";
import { testWorker, withWorker, waitUntilSettled, jobRows } from "../helpers/worker.ts";
import type { Pool } from "../../src/db/pool.ts";

let pool: Pool;
const portal = new FakePortal();
before(async () => {
  pool = await testPool();
  await portal.start();
});
beforeEach(async () => {
  await pool.query("truncate sync_jobs, updates");
  portal.respond(() => ok());
});
after(async () => {
  await portal.stop();
  await pool.end();
});

const update = { accommodationId: "acc-1003", from: "2026-10-01", to: "2026-10-07", available: false, pricePerNight: 120 };

test("SYNC-06: a 200 marks the job done with finished_at and the chunk was sent as-is", async () => {
  const { worker, store } = testWorker(pool, { portalUrl: portal.url });
  await store.acceptUpdate(update);
  await withWorker(worker, () => waitUntilSettled(pool));
  const [job] = await jobRows(pool);
  assert.equal(job?.state, "done");
  assert.equal(job?.attempts, 1);
  assert.ok(job?.finished_at instanceof Date);
  assert.equal(job?.locked_at, null);
  assert.deepEqual(
    portal.requests.map((r) => [r.path, r.body]),
    [["/api/v1/accommodations/acc-1003/availability", { from: "2026-10-01", to: "2026-10-07", available: false, pricePerNight: 120 }]],
  );
});

test("SYNC-07: a 503 and a hang each reschedule with backoff; the job then succeeds", async () => {
  portal.respond([unavailable(), hang(), ok()]);
  const { worker, store } = testWorker(pool, { portalUrl: portal.url, config: { concurrency: 1 } });
  await store.acceptUpdate(update);
  await withWorker(worker, () => waitUntilSettled(pool));
  const [job] = await jobRows(pool);
  assert.equal(job?.state, "done");
  assert.equal(job?.attempts, 3);
  assert.equal(job?.last_error_code, "TIMEOUT", "the last error is kept after success");
  assert.equal(portal.requests.length, 3);
  const gap1 = portal.requests[1]!.at - portal.requests[0]!.at;
  assert.ok(gap1 >= 20, `first retry waited ${gap1}ms, expected >= backoff(1) = 20ms`);
});

test("SYNC-07: the rescheduled job records the error and a future next_attempt_at", async () => {
  portal.respond([unavailable()]);
  const { worker, store } = testWorker(pool, { portalUrl: portal.url, config: { backoffBaseMs: 10_000 } });
  await store.acceptUpdate(update);
  const job = await store.claimNext();
  const before = Date.now();
  await worker.process(job!);
  const [row] = await jobRows(pool);
  assert.equal(row?.state, "pending");
  assert.equal(row?.attempts, 1);
  assert.equal(row?.last_error_code, "UNAVAILABLE");
  assert.ok(row!.next_attempt_at.getTime() >= before + 20_000, "backoff(1) with base 10 s is at least 20 s");
});

test("SYNC-09: a transient failure on the last allowed attempt marks the job failed", async () => {
  portal.respond(() => unavailable());
  const { worker, store } = testWorker(pool, { portalUrl: portal.url, config: { maxAttempts: 3 } });
  await store.acceptUpdate(update);
  await withWorker(worker, () => waitUntilSettled(pool));
  const [job] = await jobRows(pool);
  assert.equal(job?.state, "failed");
  assert.equal(job?.attempts, 3);
  assert.equal(job?.last_error_code, "UNAVAILABLE");
  assert.ok(job?.finished_at instanceof Date);
  assert.equal(portal.requests.length, 3);
});

test("SYNC-10: a 404 fails the job at once with the portal's code", async () => {
  portal.respond(() => notFound("acc-1003"));
  const { worker, store } = testWorker(pool, { portalUrl: portal.url });
  await store.acceptUpdate(update);
  await withWorker(worker, () => waitUntilSettled(pool));
  const [job] = await jobRows(pool);
  assert.equal(job?.state, "failed");
  assert.equal(job?.attempts, 1);
  assert.equal(job?.last_error_code, "NOT_FOUND");
  assert.equal(portal.requests.length, 1);
});

test("SYNC-11: a 429 pauses every slot until Retry-After and does not count as an attempt", async () => {
  // Two slots start two calls at once; the first gets a 429. The third job must then wait out the pause,
  // even though the second slot is free again.
  portal.respond((_request, index) => (index === 0 ? rateLimited(1) : ok()));
  const pauses: number[] = [];
  const { worker, store, limiter } = testWorker(pool, { portalUrl: portal.url, observer: { paused: (until) => pauses.push(until) } });
  await store.acceptUpdate(update);
  await store.acceptUpdate({ ...update, accommodationId: "acc-1004" });
  await store.acceptUpdate({ ...update, accommodationId: "acc-1005" });
  await withWorker(worker, async () => {
    await new Promise((r) => setTimeout(r, 300));
    const during = await jobRows(pool);
    assert.ok(limiter.paused, "limiter is paused");
    assert.equal(portal.requests.length, 2, "only the two calls already in flight; no slot starts another while paused");
    const limited = during.find((j) => j.last_error_code === "RATE_LIMITED");
    assert.equal(limited?.state, "pending");
    assert.equal(limited?.attempts, 0, "the 429 attempt is not counted");
    assert.deepEqual(during.map((j) => j.state).sort(), ["done", "pending", "pending"]);
    await waitUntilSettled(pool);
  });
  assert.deepEqual(
    (await jobRows(pool)).map((j) => j.state),
    ["done", "done", "done"],
  );
  assert.equal(pauses.length, 1);
  assert.equal(portal.requests.length, 4);
  const pauseStart = portal.requests[0]!.at;
  for (const late of portal.requests.slice(2)) {
    assert.ok(late.at - pauseStart >= 950, `a call left ${late.at - pauseStart}ms after the 429, before Retry-After`);
  }
});

test("SYNC-14: in-progress jobs past their lease go back to pending; fresh ones stay", async () => {
  const { store } = testWorker(pool, { portalUrl: portal.url });
  const stale = await store.acceptUpdate(update);
  const fresh = await store.acceptUpdate({ ...update, accommodationId: "acc-1004" });
  await pool.query(
    "update sync_jobs set state = 'in_progress', attempts = 1, locked_at = now() - interval '120 seconds' where update_id = $1",
    [stale.updateId],
  );
  await pool.query("update sync_jobs set state = 'in_progress', attempts = 1, locked_at = now() where update_id = $1", [fresh.updateId]);
  assert.equal(await store.reclaimStale(60), 1);
  const rows = await jobRows(pool);
  assert.deepEqual(
    rows.map((j) => [j.state, j.attempts]),
    [
      ["pending", 1],
      ["in_progress", 1],
    ],
  );
  assert.equal(rows[0]?.locked_at, null);
});
