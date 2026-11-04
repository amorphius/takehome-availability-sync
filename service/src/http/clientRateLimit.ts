/**
 * SEC-03: at most `limit` accepted requests per client key in a rolling window. Rejects instead of waiting,
 * because an HTTP client should be told, not held. Keys that fall silent are swept so memory stays bounded.
 */
export class ClientRateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #starts = new Map<string, number[]>();
  #checks = 0;

  constructor(limit: number, windowMs = 60_000, now: () => number = Date.now) {
    if (limit < 1) throw new Error("limit must be >= 1");
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  check(key: string): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const now = this.#now();
    if (++this.#checks % 1000 === 0) this.#sweep(now);
    const list = this.#prune(this.#starts.get(key) ?? [], now);
    if (list.length >= this.#limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((list[0]! + this.#windowMs - now) / 1000));
      this.#starts.set(key, list);
      return { allowed: false, retryAfterSeconds };
    }
    list.push(now);
    this.#starts.set(key, list);
    return { allowed: true };
  }

  get trackedClients(): number {
    return this.#starts.size;
  }

  #prune(list: number[], now: number): number[] {
    const cutoff = now - this.#windowMs;
    let drop = 0;
    while (drop < list.length && list[drop]! <= cutoff) drop++;
    if (drop > 0) list.splice(0, drop);
    return list;
  }

  #sweep(now: number): void {
    for (const [key, list] of this.#starts) {
      if (this.#prune(list, now).length === 0) this.#starts.delete(key);
    }
  }
}
