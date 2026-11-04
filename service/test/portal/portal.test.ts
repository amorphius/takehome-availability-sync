/**
 * SYNC-15 and SYNC-16 against the real Portal Sol (D-12). Needs PostgreSQL on DATABASE_URL and the
 * portal on PORTAL_URL (default http://localhost:4000). Rate-bound: SYNC-16 takes about two minutes.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { testPool } from "../helpers/db.ts";
import { SyncRepository } from "../../src/sync/repository.ts";
import { PortalClient } from "../../src/sync/portalClient.ts";
import { SlidingWindowLimiter, PORTAL_WINDOW_MS } from "../../src/sync/rateLimiter.ts";
import { Worker } from "../../src/sync/worker.ts";
import { silentLogger } from "../helpers/app.ts";
import { withWorker, waitUntilSettled } from "../helpers/worker.ts";
import { formatDate, addDays } from "../../src/domain/dates.ts";
import type { Pool } from "../../src/db/pool.ts";

const PORTAL_URL = process.env.PORTAL_URL ?? "http://localhost:4000";
const API_KEY = process.env.PORTAL_API_KEY ?? "sol-demo-key";
const LIMIT = 30;
const MARGIN_MS = 1000;

let pool: Pool;
let store: SyncRepository;
before(async () => {
  pool = await testPool();
  store = new SyncRepository(pool);
});
beforeEach(async () => {
  await pool.query("truncate sync_jobs, updates");
  const reset = await fetch(`${PORTAL_URL}/__admin/reset`, { method: "POST" });
  assert.equal(reset.status, 200, "portal reset");
});
after(async () => {
  await pool.end();
});

function worker(concurrency = 4) {
  return new Worker({
    store,
    portal: new PortalClient({ baseUrl: PORTAL_URL, apiKey: API_KEY, timeoutMs: 5000 }),
    limiter: new SlidingWindowLimiter(LIMIT, PORTAL_WINDOW_MS + MARGIN_MS),
    logger: silentLogger(),
    config: { concurrency, pollMs: 100, maxAttempts: 8, leaseSeconds: 60 },
  });
}

/** Day `offset` from today, as the portal counts days. */
const day = (offset: number) => formatDate(addDays(new Date(), offset));

/** The portal's random 503 applies to reads too; a verification read retries a few times. */
async function portalDays(id: string, from: string, to: string) {
  let response!: Response;
  for (let attempt = 0; attempt < 6; attempt++) {
    response = await fetch(`${PORTAL_URL}/api/v1/accommodations/${id}?from=${from}&to=${to}`, { headers: { "x-api-key": API_KEY } });
    if (response.status !== 503) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.equal(response.status, 200, `portal GET ${id}`);
  return ((await response.json()) as { days: { date: string; available: boolean; pricePerNight: number }[] }).days;
}

async function adminStatuses() {
  const log = (await (await fetch(`${PORTAL_URL}/__admin/requests`)).json()) as { requests: { status: number | null; method: string }[] };
  const counts = new Map<string, number>();
  for (const r of log.requests) counts.set(String(r.status), (counts.get(String(r.status)) ?? 0) + 1);
  return { counts, total: log.requests.length };
}

test("SYNC-15: the portal ends in the state of the latest update for every day, overlaps included", async () => {
  // Two overlapping updates for one accommodation, back to back, plus a 40-day update that needs two chunks.
  await store.acceptUpdate({ accommodationId: "acc-1005", from: day(1), to: day(10), available: false, pricePerNight: 50 });
  await store.acceptUpdate({ accommodationId: "acc-1005", from: day(5), to: day(15), available: true, pricePerNight: 75 });
  await store.acceptUpdate({ accommodationId: "acc-1006", from: day(1), to: day(40), available: false, pricePerNight: 199.5 });

  await withWorker(worker(), () => waitUntilSettled(pool, 120_000));

  const states = await pool.query<{ state: string; n: string }>("select state, count(*) as n from sync_jobs group by state");
  assert.deepEqual(Object.fromEntries(states.rows.map((r) => [r.state, Number(r.n)])), { done: 4 });

  const days = await portalDays("acc-1005", day(1), day(15));
  assert.equal(days.length, 15);
  for (const d of days.slice(0, 4))
    assert.deepEqual({ available: d.available, price: d.pricePerNight }, { available: false, price: 50 }, d.date);
  for (const d of days.slice(4))
    assert.deepEqual({ available: d.available, price: d.pricePerNight }, { available: true, price: 75 }, d.date);

  const long = await portalDays("acc-1006", day(1), day(40));
  assert.equal(long.length, 40);
  assert.ok(
    long.every((d) => d.available === false && d.pricePerNight === 199.5),
    "both chunks applied",
  );

  const { counts } = await adminStatuses();
  assert.equal(counts.get("429") ?? 0, 0);
});

test("SYNC-16: a backlog larger than one minute's budget drains without a single 429", async () => {
  // 36 single-chunk updates over 9 accommodations: more than LIMIT calls, plus the portal's own 503s and hangs.
  const ids = ["acc-1001", "acc-1002", "acc-1003", "acc-1004", "acc-1007", "acc-1008", "acc-1009", "acc-1010", "acc-1005"];
  let price = 10;
  for (let round = 0; round < 4; round++) {
    for (const id of ids) {
      await store.acceptUpdate({
        accommodationId: id,
        from: day(20 + round * 3),
        to: day(22 + round * 3),
        available: round % 2 === 0,
        pricePerNight: price++,
      });
    }
  }
  const started = Date.now();
  await withWorker(worker(), () => waitUntilSettled(pool, 280_000));
  const elapsed = Math.round((Date.now() - started) / 1000);

  const states = await pool.query<{ state: string; n: string }>("select state, count(*) as n from sync_jobs group by state");
  assert.deepEqual(Object.fromEntries(states.rows.map((r) => [r.state, Number(r.n)])), { done: 36 });

  const { counts, total } = await adminStatuses();
  assert.equal(counts.get("429") ?? 0, 0, `portal log: ${JSON.stringify([...counts])}`);
  assert.ok(total >= 36, "every job reached the portal at least once");
  assert.ok(elapsed >= 60, `36 calls cannot legally fit in one minute; took ${elapsed}s`);

  // The last update of each accommodation is what the portal shows.
  const last = await portalDays("acc-1001", day(29), day(31));
  assert.ok(
    last.every((d) => d.available === false),
    "round 3 (available=false) is the final state",
  );
});
