import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import pino from "pino";
import { Worker } from "../../src/sync/worker.ts";
import { PortalClient } from "../../src/sync/portalClient.ts";
import { SlidingWindowLimiter } from "../../src/sync/rateLimiter.ts";
import { FakePortal, ok, unavailable } from "../helpers/fakePortal.ts";
import type { Job, JobStore } from "../../src/sync/repository.ts";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of chunk.toString().split("\n")) if (line) lines.push(JSON.parse(line));
      callback();
    },
  });
  return { logger: pino({ level: "debug" }, stream), lines };
}

const noopStore: JobStore = {
  claimNext: async () => null,
  markDone: async () => {},
  reschedule: async () => {},
  markFailed: async () => {},
  reclaimStale: async () => 0,
};

const job: Job = {
  id: "job-1",
  seq: "1",
  updateId: "update-1",
  accommodationId: "acc-1003",
  from: "2026-10-01",
  to: "2026-10-07",
  available: true,
  pricePerNight: 120,
  state: "in_progress",
  attempts: 2,
  nextAttemptAt: new Date(),
  lockedAt: new Date(),
  lastErrorCode: null,
  lastErrorMessage: null,
  lastErrorAt: null,
  finishedAt: null,
};

test("OBS-01: worker log lines are JSON with the job, outcome and timing fields at the documented levels", async () => {
  const portal = new FakePortal();
  await portal.start();
  portal.respond([ok(), unavailable()]);
  const { logger, lines } = capture();
  const worker = new Worker({
    store: noopStore,
    portal: new PortalClient({ baseUrl: portal.url, apiKey: "k", timeoutMs: 1000 }),
    limiter: new SlidingWindowLimiter(10),
    logger,
    config: { concurrency: 1, pollMs: 10, maxAttempts: 8, leaseSeconds: 60 },
  });
  await worker.process(job);
  await worker.process(job);
  await portal.stop();

  const [done, retried] = lines;
  assert.equal(done?.msg, "job done");
  assert.equal(done?.level, 30, "info");
  assert.deepEqual(
    {
      jobId: done?.jobId,
      updateId: done?.updateId,
      accommodationId: done?.accommodationId,
      attempt: done?.attempt,
      outcome: done?.outcome,
      portalStatus: done?.portalStatus,
    },
    { jobId: "job-1", updateId: "update-1", accommodationId: "acc-1003", attempt: 2, outcome: "success", portalStatus: 200 },
  );
  assert.equal(typeof done?.durationMs, "number");
  assert.equal(typeof done?.time, "number");
  assert.equal(retried?.msg, "job rescheduled");
  assert.equal(retried?.level, 40, "warn");
  assert.equal(retried?.outcome, "unavailable");
  assert.equal(retried?.portalStatus, 503);
  assert.equal(retried?.errorCode, "UNAVAILABLE");
});
