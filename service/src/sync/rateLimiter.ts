export interface LimiterClock {
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** SEC-02: Node's timers take a signed 32-bit delay; above it setTimeout fires after 1 ms and a waiting loop spins. */
export const MAX_TIMER_MS = 2_147_483_647;
/** The portal's window; the configured margin is added on top (SYNC-12). */
export const PORTAL_WINDOW_MS = 60_000;

export const realClock: LimiterClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const timer = setTimeout(
        () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        Math.min(Math.max(0, ms), MAX_TIMER_MS),
      );
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

/**
 * SYNC-12: at most `limit` call starts in any rolling window; every acquired token counts whatever the
 * call's outcome. SYNC-11: `pauseUntil` blocks every caller, which is how a 429 stops the whole worker.
 */
export class SlidingWindowLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #clock: LimiterClock;
  #starts: number[] = [];
  #pausedUntil = 0;

  constructor(limit: number, windowMs = 60_000, clock: LimiterClock = realClock) {
    if (limit < 1) throw new Error("limit must be >= 1");
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#clock = clock;
  }

  get pausedUntil(): number {
    return this.#pausedUntil;
  }

  get paused(): boolean {
    return this.#clock.now() < this.#pausedUntil;
  }

  /** Number of starts inside the current window. */
  get inWindow(): number {
    this.#prune(this.#clock.now());
    return this.#starts.length;
  }

  pauseUntil(timestamp: number): void {
    this.#pausedUntil = Math.max(this.#pausedUntil, timestamp);
  }

  /** Resolves with a token once a call may start; rejects with the signal's reason when aborted. */
  async acquire(signal?: AbortSignal): Promise<number> {
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      const now = this.#clock.now();
      if (now < this.#pausedUntil) {
        await this.#clock.sleep(this.#pausedUntil - now, signal);
        continue;
      }
      this.#prune(now);
      if (this.#starts.length < this.#limit) {
        this.#starts.push(now);
        return now;
      }
      await this.#clock.sleep(this.#starts[0]! + this.#windowMs - now, signal);
    }
  }

  /** Gives a token back when no call was made with it. */
  release(token: number): void {
    const index = this.#starts.indexOf(token);
    if (index >= 0) this.#starts.splice(index, 1);
  }

  #prune(now: number): void {
    const cutoff = now - this.#windowMs;
    let drop = 0;
    while (drop < this.#starts.length && this.#starts[drop]! <= cutoff) drop++;
    if (drop > 0) this.#starts.splice(0, drop);
  }
}
