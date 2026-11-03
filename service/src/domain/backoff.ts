export interface BackoffOptions {
  baseMs?: number;
  capMs?: number;
  random?: () => number;
}

/** SYNC-08: min(cap, base · 2^attempts) plus up to 50 % jitter. `attempts` is the number already made. */
export function backoffMs(attempts: number, { baseMs = 1000, capMs = 60_000, random = Math.random }: BackoffOptions = {}): number {
  const exponential = Math.min(capMs, baseMs * 2 ** Math.max(0, attempts));
  return Math.round(exponential * (1 + 0.5 * random()));
}
