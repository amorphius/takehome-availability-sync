import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { testPool } from "../helpers/db.ts";
import { testServer } from "../helpers/app.ts";
import { FakePortal, ok, unavailable, rateLimited } from "../helpers/fakePortal.ts";
import { testWorker, withWorker, waitUntilSettled } from "../helpers/worker.ts";
import { createMetrics } from "../../src/observability/metrics.ts";
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

/** Parses the Prometheus text format into a map of `name{labels}` → value. */
function parse(text: string): Map<string, number> {
  const values = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const space = line.lastIndexOf(" ");
    values.set(line.slice(0, space), Number(line.slice(space + 1)));
  }
  return values;
}

test("OBS-02 OBS-04 OBS-05: /metrics exposes process, portal, retry, failure and pause metrics", async () => {
  const metrics = createMetrics();
  const { app } = testServer(pool, metrics);
  const { worker } = testWorker(pool, { portalUrl: portal.url, observer: metrics.observer, config: { concurrency: 1 } });
  portal.respond([unavailable(), rateLimited(1), ok()]);
  const accepted = await app.inject({ method: "POST", url: "/updates", payload: update });
  assert.equal(accepted.statusCode, 202);
  await withWorker(worker, () => waitUntilSettled(pool, 8000));

  const response = await app.inject({ method: "GET", url: "/metrics" });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"] as string, /^text\/plain/);
  const m = parse(response.body);

  assert.equal(m.get("sync_updates_received_total"), 1);
  assert.equal(m.get('portal_requests_total{outcome="unavailable"}'), 1);
  assert.equal(m.get('portal_requests_total{outcome="rate_limited"}'), 1);
  assert.equal(m.get('portal_requests_total{outcome="success"}'), 1);
  assert.equal(m.get('portal_requests_total{outcome="timeout"}'), 0, "every outcome series exists from the start");
  assert.equal(m.get('portal_request_duration_seconds_count{outcome="success"}'), 1);
  assert.ok(m.has('portal_request_duration_seconds_bucket{le="0.5",outcome="success"}'));
  assert.equal(m.get('sync_job_retries_total{reason="unavailable"}'), 1);
  assert.equal(m.get("sync_rate_limit_pauses_total"), 1);
  assert.equal(m.get("sync_portal_paused"), 0, "back to 0 once the pause ended");
  assert.ok(m.has("process_cpu_seconds_total"), "default process metrics");
  assert.ok(m.has("nodejs_eventloop_lag_seconds"));
  await app.close();
});

test("OBS-05: a job that gives up is counted by its last error code", async () => {
  const metrics = createMetrics();
  const { app } = testServer(pool, metrics);
  const { worker } = testWorker(pool, { portalUrl: portal.url, observer: metrics.observer, config: { maxAttempts: 2 } });
  portal.respond(() => unavailable());
  await app.inject({ method: "POST", url: "/updates", payload: update });
  await withWorker(worker, () => waitUntilSettled(pool));
  const m = parse((await app.inject({ method: "GET", url: "/metrics" })).body);
  assert.equal(m.get('sync_jobs_failed_total{code="UNAVAILABLE"}'), 1);
  assert.equal(m.get('sync_job_retries_total{reason="unavailable"}'), 1);
  assert.equal(m.get("sync_portal_paused"), 0);
  await app.close();
});
