import type { Pool } from "../../src/db/pool.ts";
import { SyncRepository } from "../../src/sync/repository.ts";
import { PortalClient } from "../../src/sync/portalClient.ts";
import { SlidingWindowLimiter } from "../../src/sync/rateLimiter.ts";
import { Worker, type WorkerConfig, type WorkerObserver } from "../../src/sync/worker.ts";
import { silentLogger } from "./app.ts";

export interface TestWorkerOptions {
  portalUrl: string;
  timeoutMs?: number;
  limit?: number;
  config?: Partial<WorkerConfig>;
  observer?: WorkerObserver;
}

export function testWorker(pool: Pool, options: TestWorkerOptions) {
  const store = new SyncRepository(pool);
  const portal = new PortalClient({ baseUrl: options.portalUrl, apiKey: "test-key", timeoutMs: options.timeoutMs ?? 200 });
  const limiter = new SlidingWindowLimiter(options.limit ?? 1000);
  const config: WorkerConfig = { concurrency: 2, pollMs: 20, maxAttempts: 8, leaseSeconds: 60, backoffBaseMs: 10, ...options.config };
  const worker = new Worker({ store, portal, limiter, logger: silentLogger(), config, ...(options.observer ? { observer: options.observer } : {}) });
  return { worker, store, portal, limiter };
}

/** Starts the worker, runs the body, and always stops the worker so a failing assertion cannot hang the run. */
export async function withWorker<T>(worker: Worker, body: () => Promise<T>): Promise<T> {
  await worker.start();
  try {
    return await body();
  } finally {
    await worker.stop();
  }
}

/** Polls until no job is pending or in progress, or the timeout passes. */
export async function waitUntilSettled(pool: Pool, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ n: string }>("select count(*) as n from sync_jobs where state in ('pending', 'in_progress')");
    if (rows[0]?.n === "0") return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("jobs did not settle in time");
}

export async function jobRows(pool: Pool) {
  const { rows } = await pool.query(
    "select state, attempts, last_error_code, finished_at, next_attempt_at, locked_at from sync_jobs order by seq",
  );
  return rows as { state: string; attempts: number; last_error_code: string | null; finished_at: Date | null; next_attempt_at: Date; locked_at: Date | null }[];
}
