import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "../../src/sync/worker.ts";
import type { Job, JobStore, JobError } from "../../src/sync/repository.ts";
import { PortalClient } from "../../src/sync/portalClient.ts";
import { SlidingWindowLimiter } from "../../src/sync/rateLimiter.ts";
import { FakePortal, ok } from "../helpers/fakePortal.ts";
import { silentLogger } from "../helpers/app.ts";

/** Just enough store for the worker: a queue of jobs, no ordering rules. */
class MemoryStore implements JobStore {
  queue: Job[] = [];
  done: string[] = [];
  async claimNext() {
    const job = this.queue.shift();
    return job ? { ...job, state: "in_progress" as const, attempts: job.attempts + 1 } : null;
  }
  async markDone(id: string) {
    this.done.push(id);
  }
  async reschedule(_id: string, _at: Date, _e: JobError) {}
  async markFailed(_id: string, _e: JobError) {}
  async reclaimStale() {
    return 0;
  }
}

function job(n: number): Job {
  return {
    id: `job-${n}`,
    seq: String(n),
    updateId: `u-${n}`,
    accommodationId: `acc-${n}`,
    from: "2026-10-01",
    to: "2026-10-02",
    available: true,
    pricePerNight: 1,
    state: "pending",
    attempts: 0,
    nextAttemptAt: new Date(),
    lockedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    lastErrorAt: null,
    finishedAt: null,
  };
}

test("SYNC-13: never more than `concurrency` portal calls in flight", async () => {
  const portal = new FakePortal();
  await portal.start();
  let inFlight = 0;
  let maxInFlight = 0;
  portal.respond(() => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    setTimeout(() => inFlight--, 40);
    return { ...ok(), delayMs: 40 };
  });
  const store = new MemoryStore();
  store.queue = Array.from({ length: 12 }, (_, i) => job(i));
  const worker = new Worker({
    store,
    portal: new PortalClient({ baseUrl: portal.url, apiKey: "k", timeoutMs: 1000 }),
    limiter: new SlidingWindowLimiter(1000),
    logger: silentLogger(),
    config: { concurrency: 3, pollMs: 10, maxAttempts: 8, leaseSeconds: 60 },
  });
  await worker.start();
  const deadline = Date.now() + 3000;
  while (store.done.length < 12 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  await worker.stop();
  await portal.stop();
  assert.equal(store.done.length, 12);
  assert.equal(maxInFlight, 3, `max in flight was ${maxInFlight}`);
});
