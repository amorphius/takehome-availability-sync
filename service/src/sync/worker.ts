import type { Logger } from "../observability/logger.ts";
import { backoffMs } from "../domain/backoff.ts";
import type { Job, JobStore } from "./repository.ts";
import type { PortalClient, PortalResult, OutcomeKind } from "./portalClient.ts";
import { realClock, type SlidingWindowLimiter } from "./rateLimiter.ts";

export interface WorkerConfig {
  concurrency: number;
  pollMs: number;
  maxAttempts: number;
  leaseSeconds: number;
  /** Base of the backoff; tests shrink it. */
  backoffBaseMs?: number;
}

/** Hooks the metrics layer attaches to (OBS-04, OBS-05); all optional. */
export interface WorkerObserver {
  portalResult?(result: PortalResult): void;
  retry?(reason: OutcomeKind): void;
  failed?(code: string): void;
  paused?(untilMs: number): void;
  resumed?(): void;
}

export interface WorkerDeps {
  store: JobStore;
  portal: PortalClient;
  limiter: SlidingWindowLimiter;
  logger: Logger;
  config: WorkerConfig;
  observer?: WorkerObserver;
}

/**
 * Runs `concurrency` slots. Each slot takes a limiter token, claims one job, sends it and records the
 * outcome (SYNC-06, SYNC-07, SYNC-09, SYNC-10, SYNC-11). The token is taken before the claim so a job never
 * sits in progress while waiting for the window (D-06); it is given back when there was nothing to do.
 */
export class Worker {
  readonly #deps: WorkerDeps;
  readonly #controller = new AbortController();
  #slots: Promise<void>[] = [];
  #reclaimTimer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(deps: WorkerDeps) {
    this.#deps = deps;
  }

  get running(): boolean {
    return this.#running;
  }

  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    await this.#reclaim();
    this.#reclaimTimer = setInterval(() => void this.#reclaim(), 60_000);
    this.#reclaimTimer.unref();
    this.#slots = Array.from({ length: this.#deps.config.concurrency }, (_, i) => this.#runSlot(i));
    this.#deps.logger.info({ concurrency: this.#deps.config.concurrency }, "worker started");
  }

  /** OPS-02: stop claiming, let in-flight calls finish (bounded by the portal timeout), then return. */
  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    clearInterval(this.#reclaimTimer);
    this.#controller.abort(new Error("worker stopped"));
    await Promise.allSettled(this.#slots);
    this.#deps.logger.info("worker stopped");
  }

  /** Sends one job and records the outcome. Public so tests can drive a single job. */
  async process(job: Job): Promise<PortalResult> {
    const { store, portal, limiter, logger, config, observer } = this.#deps;
    const log = logger.child({ jobId: job.id, updateId: job.updateId, accommodationId: job.accommodationId, attempt: job.attempts });
    const result = await portal.putAvailability(job.accommodationId, {
      from: job.from,
      to: job.to,
      available: job.available,
      pricePerNight: job.pricePerNight,
    });
    observer?.portalResult?.(result);
    const { outcome, durationMs } = result;
    const portalStatus = "status" in outcome ? outcome.status : null;
    switch (outcome.kind) {
      case "success":
        await store.markDone(job.id);
        log.info({ outcome: outcome.kind, portalStatus, durationMs, daysUpdated: outcome.daysUpdated }, "job done");
        break;
      case "rate_limited": {
        const until = Date.now() + outcome.retryAfterSeconds * 1000;
        limiter.pauseUntil(until);
        observer?.paused?.(until);
        await store.reschedule(job.id, new Date(until), { code: "RATE_LIMITED", message: `Retry after ${outcome.retryAfterSeconds} s` }, false);
        log.warn({ outcome: outcome.kind, portalStatus, durationMs, retryAfterSeconds: outcome.retryAfterSeconds }, "rate limited; all slots paused");
        break;
      }
      case "client_error":
        await store.markFailed(job.id, { code: outcome.code, message: outcome.message });
        observer?.failed?.(outcome.code);
        log.error({ outcome: outcome.kind, portalStatus, durationMs, errorCode: outcome.code }, "job failed: portal rejected the request");
        break;
      case "unavailable":
      case "timeout":
      case "network_error": {
        const error =
          outcome.kind === "unavailable"
            ? { code: outcome.code, message: outcome.message }
            : outcome.kind === "timeout"
              ? { code: "TIMEOUT", message: "No response from the portal within the timeout" }
              : { code: "NETWORK_ERROR", message: outcome.message };
        if (job.attempts >= config.maxAttempts) {
          await store.markFailed(job.id, error);
          observer?.failed?.(error.code);
          log.error({ outcome: outcome.kind, portalStatus, durationMs, errorCode: error.code, attempts: job.attempts }, "job failed: attempts exhausted");
        } else {
          const delay = backoffMs(job.attempts, { baseMs: config.backoffBaseMs ?? 1000 });
          await store.reschedule(job.id, new Date(Date.now() + delay), error, true);
          observer?.retry?.(outcome.kind);
          log.warn({ outcome: outcome.kind, portalStatus, durationMs, errorCode: error.code, retryInMs: delay }, "job rescheduled");
        }
        break;
      }
    }
    return result;
  }

  async #runSlot(index: number): Promise<void> {
    const { store, limiter, logger, config } = this.#deps;
    const signal = this.#controller.signal;
    while (this.#running) {
      let token: number;
      try {
        const wasPaused = limiter.paused;
        token = await limiter.acquire(signal);
        if (wasPaused) this.#deps.observer?.resumed?.();
      } catch {
        break; // aborted
      }
      try {
        const job = await store.claimNext();
        if (!job) {
          limiter.release(token);
          await realClock.sleep(config.pollMs, signal).catch(() => undefined);
          continue;
        }
        await this.process(job);
      } catch (error) {
        if (signal.aborted) break;
        logger.error({ err: error, slot: index }, "worker slot error; backing off one poll interval");
        await realClock.sleep(config.pollMs, signal).catch(() => undefined);
      }
    }
  }

  async #reclaim(): Promise<void> {
    try {
      const count = await this.#deps.store.reclaimStale(this.#deps.config.leaseSeconds);
      if (count > 0) this.#deps.logger.warn({ count }, "reclaimed stale in-progress jobs");
    } catch (error) {
      this.#deps.logger.error({ err: error }, "reclaiming stale jobs failed");
    }
  }
}
