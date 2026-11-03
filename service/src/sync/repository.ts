import { randomUUID } from "node:crypto";
import type { Pool } from "../db/pool.ts";
import type { UpdateRequest } from "../domain/update.ts";
import { splitRange } from "../domain/dates.ts";

export type JobState = "pending" | "in_progress" | "done" | "failed" | "superseded";

export interface Job {
  id: string;
  seq: string;
  updateId: string;
  accommodationId: string;
  from: string;
  to: string;
  available: boolean;
  pricePerNight: number;
  state: JobState;
  attempts: number;
  nextAttemptAt: Date;
  lockedAt: Date | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastErrorAt: Date | null;
  finishedAt: Date | null;
}

export interface Accepted {
  updateId: string;
  chunks: number;
  superseded: number;
}

interface JobRow {
  id: string;
  seq: string;
  update_id: string;
  accommodation_id: string;
  from_date: string;
  to_date: string;
  available: boolean;
  price_per_night: number;
  state: JobState;
  attempts: number;
  next_attempt_at: Date;
  locked_at: Date | null;
  last_error_code: string | null;
  last_error_message: string | null;
  last_error_at: Date | null;
  finished_at: Date | null;
}

export function toJob(row: JobRow): Job {
  return {
    id: row.id,
    seq: row.seq,
    updateId: row.update_id,
    accommodationId: row.accommodation_id,
    from: row.from_date,
    to: row.to_date,
    available: row.available,
    pricePerNight: row.price_per_night,
    state: row.state,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lockedAt: row.locked_at,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    lastErrorAt: row.last_error_at,
    finishedAt: row.finished_at,
  };
}

export interface JobError {
  code: string;
  message: string;
}

/** What the worker needs from storage; SyncRepository is the PostgreSQL implementation. */
export interface JobStore {
  claimNext(): Promise<Job | null>;
  markDone(jobId: string): Promise<void>;
  reschedule(jobId: string, nextAttemptAt: Date, error: JobError, countAttempt: boolean): Promise<void>;
  markFailed(jobId: string, error: JobError): Promise<void>;
  reclaimStale(leaseSeconds: number): Promise<number>;
}

export class SyncRepository implements JobStore {
  readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * DATA-02: the update and one pending job per 31-day chunk, in one transaction.
   * SYNC-04: pending jobs of the same accommodation that lie inside the new range are superseded first;
   * the new chunks will overwrite every day they would have set. In-progress jobs are left alone.
   */
  async acceptUpdate(request: UpdateRequest): Promise<Accepted> {
    const updateId = randomUUID();
    const chunks = splitRange(request.from, request.to);
    const client = await this.pool.connect();
    let superseded = 0;
    try {
      await client.query("begin");
      const covered = await client.query(
        `update sync_jobs set state = 'superseded', finished_at = now()
         where accommodation_id = $1 and state = 'pending' and from_date >= $2 and to_date <= $3`,
        [request.accommodationId, request.from, request.to],
      );
      superseded = covered.rowCount ?? 0;
      await client.query(
        `insert into updates (id, accommodation_id, from_date, to_date, available, price_per_night)
         values ($1, $2, $3, $4, $5, $6)`,
        [updateId, request.accommodationId, request.from, request.to, request.available, request.pricePerNight],
      );
      for (const chunk of chunks) {
        await client.query(
          `insert into sync_jobs (id, update_id, accommodation_id, from_date, to_date, available, price_per_night, state)
           values ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
          [randomUUID(), updateId, request.accommodationId, chunk.from, chunk.to, request.available, request.pricePerNight],
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return { updateId, chunks: chunks.length, superseded };
  }

  /**
   * SYNC-02: claim the oldest runnable pending job and mark it in progress in one statement.
   * SYNC-03: a job is runnable only when no older job of the same accommodation is pending or in progress.
   * `FOR UPDATE SKIP LOCKED` lets concurrent claimers (slots or processes) never pick the same row.
   */
  async claimNext(): Promise<Job | null> {
    const result = await this.pool.query<JobRow>(
      `update sync_jobs set state = 'in_progress', locked_at = now(), attempts = attempts + 1
       where id = (
         select j.id from sync_jobs j
         where j.state = 'pending' and j.next_attempt_at <= now()
           and not exists (
             select 1 from sync_jobs o
             where o.accommodation_id = j.accommodation_id and o.seq < j.seq
               and o.state in ('pending', 'in_progress'))
         order by j.seq
         for update skip locked
         limit 1)
       returning *`,
    );
    const row = result.rows[0];
    return row ? toJob(row) : null;
  }

  /** SYNC-06: a delivered job. */
  async markDone(jobId: string): Promise<void> {
    await this.pool.query(
      "update sync_jobs set state = 'done', finished_at = now(), locked_at = null where id = $1",
      [jobId],
    );
  }

  /** SYNC-07 / SYNC-11: back to pending for a later attempt. A 429 does not count as an attempt. */
  async reschedule(jobId: string, nextAttemptAt: Date, error: JobError, countAttempt: boolean): Promise<void> {
    await this.pool.query(
      `update sync_jobs
       set state = 'pending', locked_at = null, next_attempt_at = $2,
           attempts = case when $5 then attempts else attempts - 1 end,
           last_error_code = $3, last_error_message = $4, last_error_at = now()
       where id = $1`,
      [jobId, nextAttemptAt, error.code, error.message, countAttempt],
    );
  }

  /** SYNC-09 / SYNC-10: gave up; stays visible with its last error. */
  async markFailed(jobId: string, error: JobError): Promise<void> {
    await this.pool.query(
      `update sync_jobs
       set state = 'failed', locked_at = null, finished_at = now(),
           last_error_code = $2, last_error_message = $3, last_error_at = now()
       where id = $1`,
      [jobId, error.code, error.message],
    );
  }

  /** SYNC-14: jobs whose holder vanished (crash, kill) go back to pending; replay is safe, PUT is idempotent. */
  async reclaimStale(leaseSeconds: number): Promise<number> {
    const result = await this.pool.query(
      `update sync_jobs set state = 'pending', locked_at = null
       where state = 'in_progress' and locked_at < now() - make_interval(secs => $1)`,
      [leaseSeconds],
    );
    return result.rowCount ?? 0;
  }

  async jobsOfUpdate(updateId: string): Promise<Job[]> {
    const result = await this.pool.query<JobRow>("select * from sync_jobs where update_id = $1 order by seq", [updateId]);
    return result.rows.map(toJob);
  }
}
