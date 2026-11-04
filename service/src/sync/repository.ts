import { randomUUID } from "node:crypto";
import type { Pool } from "../db/pool.ts";
import type { UpdateRequest } from "../domain/update.ts";
import { splitRange } from "../domain/dates.ts";
import { ApiError } from "../domain/update.ts";
import { deriveUpdateStatus, deriveAccommodationStatus, type UpdateStatus, type AccommodationStatus } from "../domain/status.ts";

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

export interface UpdateStatusView {
  updateId: string;
  from: string;
  to: string;
  available: boolean;
  pricePerNight: number;
  receivedAt: Date;
  status: UpdateStatus;
  chunks: { total: number; done: number };
}

export interface SyncStatusView {
  accommodationId: string;
  status: AccommodationStatus;
  jobs: Record<"pending" | "inProgress" | "done" | "failed" | "superseded", number>;
  lastSyncedAt: Date | null;
  nextAttemptAt: Date | null;
  /** SEC-09: the code only; the portal's message is third-party text and stays in the database and the logs. */
  lastError: { code: string; at: Date } | null;
  updates: UpdateStatusView[];
}

export const STATUS_UPDATES_SHOWN = 20;

/** SEC-03: queue caps checked inside the accept transaction, after superseding. */
export interface QueueLimits {
  maxPendingJobsPerAccommodation: number;
  maxPendingJobs: number;
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
  async acceptUpdate(request: UpdateRequest, limits?: QueueLimits): Promise<Accepted> {
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
      if (limits) {
        // A soft cap: two accepts racing at the limit may both pass; the point is to stop a flood, not to count exactly.
        const open = await client.query<{ mine: number; total: number }>(
          `select count(*) filter (where accommodation_id = $1)::int as mine, count(*)::int as total
           from sync_jobs where state in ('pending', 'in_progress')`,
          [request.accommodationId],
        );
        const { mine, total } = open.rows[0]!;
        if (mine + chunks.length > limits.maxPendingJobsPerAccommodation) {
          throw new ApiError(429, "QUEUE_FULL", `Accommodation ${request.accommodationId} already has ${mine} jobs waiting; at most ${limits.maxPendingJobsPerAccommodation} are allowed`);
        }
        if (total + chunks.length > limits.maxPendingJobs) {
          throw new ApiError(503, "QUEUE_FULL", `${total} jobs are waiting; the service accepts no more until the queue drains`);
        }
      }
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

  /** API-03 / API-04: null when the accommodation was never seen; otherwise the status view. */
  async syncStatus(accommodationId: string): Promise<SyncStatusView | null> {
    const updates = await this.pool.query<{
      id: string; from_date: string; to_date: string; available: boolean; price_per_night: number; received_at: Date;
    }>(
      `select id, from_date, to_date, available, price_per_night, received_at
       from updates where accommodation_id = $1 order by received_at desc, id limit $2`,
      [accommodationId, STATUS_UPDATES_SHOWN],
    );
    if (updates.rowCount === 0) return null;

    const [jobsOfShown, aggregate, lastError] = await Promise.all([
      this.pool.query<{ update_id: string; state: JobState }>(
        "select update_id, state from sync_jobs where update_id = any($1::uuid[])",
        [updates.rows.map((u) => u.id)],
      ),
      this.pool.query<{ state: JobState; n: string; last_synced_at: Date | null; next_attempt_at: Date | null }>(
        `select state, count(*) as n,
                max(finished_at) filter (where state = 'done') as last_synced_at,
                min(next_attempt_at) filter (where state = 'pending') as next_attempt_at
         from sync_jobs where accommodation_id = $1 group by state`,
        [accommodationId],
      ),
      this.pool.query<{ last_error_code: string; last_error_at: Date }>(
        `select last_error_code, last_error_at from sync_jobs
         where accommodation_id = $1 and last_error_at is not null order by last_error_at desc limit 1`,
        [accommodationId],
      ),
    ]);

    const statesByUpdate = new Map<string, JobState[]>();
    for (const row of jobsOfShown.rows) {
      const list = statesByUpdate.get(row.update_id) ?? [];
      list.push(row.state);
      statesByUpdate.set(row.update_id, list);
    }
    const updateViews: UpdateStatusView[] = updates.rows.map((u) => {
      const states = statesByUpdate.get(u.id) ?? [];
      return {
        updateId: u.id,
        from: u.from_date,
        to: u.to_date,
        available: u.available,
        pricePerNight: u.price_per_night,
        receivedAt: u.received_at,
        status: deriveUpdateStatus(states),
        chunks: { total: states.length, done: states.filter((s) => s === "done").length },
      };
    });

    const jobs = { pending: 0, inProgress: 0, done: 0, failed: 0, superseded: 0 };
    let lastSyncedAt: Date | null = null;
    let nextAttemptAt: Date | null = null;
    for (const row of aggregate.rows) {
      const key = row.state === "in_progress" ? "inProgress" : row.state;
      jobs[key] = Number(row.n);
      if (row.last_synced_at && (!lastSyncedAt || row.last_synced_at > lastSyncedAt)) lastSyncedAt = row.last_synced_at;
      if (row.next_attempt_at && (!nextAttemptAt || row.next_attempt_at < nextAttemptAt)) nextAttemptAt = row.next_attempt_at;
    }
    // The 20 shown updates may not be all of them; the overall status comes from every job of the accommodation.
    const overall: UpdateStatus[] = [];
    if (jobs.failed > 0) overall.push("failed");
    if (jobs.pending > 0) overall.push("pending");
    if (jobs.inProgress > 0) overall.push("syncing");
    const error = lastError.rows[0];
    return {
      accommodationId,
      status: deriveAccommodationStatus(overall),
      jobs,
      lastSyncedAt,
      nextAttemptAt,
      lastError: error ? { code: error.last_error_code, at: error.last_error_at } : null,
      updates: updateViews,
    };
  }

  async jobsOfUpdate(updateId: string): Promise<Job[]> {
    const result = await this.pool.query<JobRow>("select * from sync_jobs where update_id = $1 order by seq", [updateId]);
    return result.rows.map(toJob);
  }
}
