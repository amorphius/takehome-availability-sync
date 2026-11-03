import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { testPool } from "../helpers/db.ts";
import { testServer } from "../helpers/app.ts";
import { FakePortal, ok, unavailable, notFound } from "../helpers/fakePortal.ts";
import { testWorker, withWorker, waitUntilSettled } from "../helpers/worker.ts";
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

const update = { accommodationId: "acc-1003", from: "2026-10-01", to: "2026-10-07", available: true, pricePerNight: 120 };

async function status(id: string) {
  const { app } = testServer(pool);
  const response = await app.inject({ method: "GET", url: `/accommodations/${id}/sync-status` });
  await app.close();
  return { code: response.statusCode, body: response.json() };
}

test("API-03: an accommodation never seen is 404 NOT_FOUND", async () => {
  const { code, body } = await status("acc-9999");
  assert.equal(code, 404);
  assert.equal(body.error.code, "NOT_FOUND");
});

test("API-04: a freshly accepted update shows as pending with the documented shape", async () => {
  const { store } = testWorker(pool, { portalUrl: portal.url });
  const accepted = await store.acceptUpdate({ ...update, to: "2026-11-15" });
  const { code, body } = await status("acc-1003");
  assert.equal(code, 200);
  assert.equal(body.accommodationId, "acc-1003");
  assert.equal(body.status, "pending");
  assert.deepEqual(body.jobs, { pending: 2, inProgress: 0, done: 0, failed: 0, superseded: 0 });
  assert.equal(body.lastSyncedAt, null);
  assert.ok(typeof body.nextAttemptAt === "string");
  assert.equal(body.lastError, null);
  assert.equal(body.updates.length, 1);
  const [view] = body.updates;
  assert.equal(view.updateId, accepted.updateId);
  assert.deepEqual(
    { from: view.from, to: view.to, available: view.available, pricePerNight: view.pricePerNight, status: view.status, chunks: view.chunks },
    { from: "2026-10-01", to: "2026-11-15", available: true, pricePerNight: 120, status: "pending", chunks: { total: 2, done: 0 } },
  );
  assert.ok(typeof view.receivedAt === "string");
});

test("API-04: after delivery the accommodation is synced, with lastSyncedAt and a superseded older update", async () => {
  const { worker, store } = testWorker(pool, { portalUrl: portal.url });
  const older = await store.acceptUpdate({ ...update, from: "2026-10-02", to: "2026-10-03" });
  const newer = await store.acceptUpdate(update);
  await withWorker(worker, () => waitUntilSettled(pool));
  const { body } = await status("acc-1003");
  assert.equal(body.status, "synced");
  assert.deepEqual(body.jobs, { pending: 0, inProgress: 0, done: 1, failed: 0, superseded: 1 });
  assert.ok(typeof body.lastSyncedAt === "string");
  assert.equal(body.nextAttemptAt, null);
  assert.deepEqual(body.updates.map((u: { updateId: string; status: string }) => [u.updateId, u.status]), [
    [newer.updateId, "synced"],
    [older.updateId, "superseded"],
  ], "newest first");
});

test("API-04: a failed job makes the accommodation failed and exposes the last error", async () => {
  portal.respond(() => notFound("acc-1003"));
  const { worker, store } = testWorker(pool, { portalUrl: portal.url });
  await store.acceptUpdate(update);
  await store.acceptUpdate({ ...update, accommodationId: "acc-1004", from: "2026-12-01", to: "2026-12-02" });
  portal.respond((req) => (req.path.includes("acc-1003") ? notFound("acc-1003") : ok()));
  await withWorker(worker, () => waitUntilSettled(pool));
  const { body } = await status("acc-1003");
  assert.equal(body.status, "failed");
  assert.equal(body.jobs.failed, 1);
  assert.equal(body.lastError.code, "NOT_FOUND");
  assert.match(body.lastError.message, /acc-1003/);
  assert.ok(typeof body.lastError.at === "string");
  assert.equal(body.updates[0].status, "failed");
  assert.equal((await status("acc-1004")).body.status, "synced", "other accommodations are unaffected");
});

test("API-04: a retrying job keeps the accommodation pending and shows the error and next attempt", async () => {
  portal.respond(() => unavailable());
  const { worker, store } = testWorker(pool, { portalUrl: portal.url, config: { backoffBaseMs: 60_000, maxAttempts: 5 } });
  await store.acceptUpdate(update);
  const job = await store.claimNext();
  await worker.process(job!);
  const { body } = await status("acc-1003");
  assert.equal(body.status, "pending");
  assert.equal(body.lastError.code, "UNAVAILABLE");
  assert.ok(new Date(body.nextAttemptAt).getTime() > Date.now() + 60_000);
  assert.equal(body.updates[0].status, "pending");
});

test("API-06: /health is 200 while the database answers", async () => {
  const { app } = testServer(pool);
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
  await app.close();
});
