import { Gauge, type Registry } from "prom-client";
import type { Pool } from "../db/pool.ts";
import type { Logger } from "./logger.ts";

export interface QueueGauges {
  /** Runs one refresh now. */
  refresh(): Promise<void>;
  /** Refreshes every `intervalMs` until `stop()`. */
  start(intervalMs?: number): void;
  stop(): void;
}

/** OBS-03: sync_jobs{state} and the age of the oldest job still owed to the portal, read from PostgreSQL. */
export function createQueueGauges(registry: Registry, pool: Pool, logger: Logger): QueueGauges {
  const jobs = new Gauge<"state">({ name: "sync_jobs", help: "Jobs by state", labelNames: ["state"], registers: [registry] });
  const oldest = new Gauge({
    name: "sync_oldest_pending_job_age_seconds",
    help: "Seconds since the oldest pending or in-progress job's update was accepted; 0 when the queue is empty",
    registers: [registry],
  });
  let timer: NodeJS.Timeout | undefined;

  async function refresh(): Promise<void> {
    try {
      const [counts, age] = await Promise.all([
        pool.query<{ state: string; n: string }>("select state, count(*) as n from sync_jobs group by state"),
        pool.query<{ age: number | null }>(
          `select extract(epoch from now() - min(u.received_at))::float8 as age
           from sync_jobs j join updates u on u.id = j.update_id
           where j.state in ('pending', 'in_progress')`,
        ),
      ]);
      for (const state of ["pending", "in_progress", "done", "failed", "superseded"]) jobs.labels(state).set(0);
      for (const row of counts.rows) jobs.labels(row.state).set(Number(row.n));
      oldest.set(age.rows[0]?.age ?? 0);
    } catch (error) {
      logger.warn({ err: error }, "queue gauges refresh failed");
    }
  }

  return {
    refresh,
    start(intervalMs = 5000) {
      timer = setInterval(() => void refresh(), intervalMs);
      timer.unref();
      void refresh();
    },
    stop() {
      clearInterval(timer);
    },
  };
}
