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

export class SyncRepository {
  readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /** DATA-02: the update and one pending job per 31-day chunk, in one transaction. */
  async acceptUpdate(request: UpdateRequest): Promise<Accepted> {
    const updateId = randomUUID();
    const chunks = splitRange(request.from, request.to);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
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
    return { updateId, chunks: chunks.length };
  }

  async jobsOfUpdate(updateId: string): Promise<Job[]> {
    const result = await this.pool.query<JobRow>("select * from sync_jobs where update_id = $1 order by seq", [updateId]);
    return result.rows.map(toJob);
  }
}
