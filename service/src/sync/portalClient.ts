import type { DateRange } from "../domain/dates.ts";

export interface AvailabilityBody extends DateRange {
  available: boolean;
  pricePerNight: number;
}

export type PortalOutcome =
  | { kind: "success"; status: number; daysUpdated: number }
  | { kind: "rate_limited"; status: 429; retryAfterSeconds: number }
  | { kind: "unavailable"; status: number; code: string; message: string }
  | { kind: "client_error"; status: number; code: string; message: string }
  | { kind: "timeout" }
  | { kind: "network_error"; message: string };

export type OutcomeKind = PortalOutcome["kind"];

export interface PortalResult {
  outcome: PortalOutcome;
  durationMs: number;
}

export interface PortalClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  /** SEC-02: a Retry-After above this is clamped to it. */
  maxRetryAfterSeconds?: number;
  fetch?: typeof fetch;
}

/** Fallback when a 429 carries no usable Retry-After: one full window. */
const DEFAULT_RETRY_AFTER_SECONDS = 60;
/** SEC-02: default ceiling for a Retry-After; the portal never asked for more than 42 s in the probe. */
export const DEFAULT_MAX_RETRY_AFTER_SECONDS = 300;

function errorBody(text: string): { code: string; message: string } {
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
    const code = typeof parsed.error?.code === "string" ? parsed.error.code : "UNKNOWN";
    const message = typeof parsed.error?.message === "string" ? parsed.error.message : text.slice(0, 200);
    return { code, message };
  } catch {
    return { code: "UNKNOWN", message: text.slice(0, 200) };
  }
}

/** SYNC-05: one PUT per chunk, bounded by a timeout, classified into an outcome the worker acts on. */
export class PortalClient {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #maxRetryAfterSeconds: number;
  readonly #fetch: typeof fetch;

  constructor(options: PortalClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs;
    this.#maxRetryAfterSeconds = options.maxRetryAfterSeconds ?? DEFAULT_MAX_RETRY_AFTER_SECONDS;
    this.#fetch = options.fetch ?? fetch;
  }

  async putAvailability(accommodationId: string, body: AvailabilityBody): Promise<PortalResult> {
    const started = performance.now();
    const done = (outcome: PortalOutcome): PortalResult => ({ outcome, durationMs: Math.round(performance.now() - started) });
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/api/v1/accommodations/${encodeURIComponent(accommodationId)}/availability`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-api-key": this.#apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === "TimeoutError" || name === "AbortError") return done({ kind: "timeout" });
      const cause = (error as { cause?: { message?: string } }).cause;
      return done({ kind: "network_error", message: cause?.message ?? (error as Error).message });
    }
    const text = await response.text();
    if (response.ok) {
      let daysUpdated = 0;
      try {
        daysUpdated = Number((JSON.parse(text) as { daysUpdated?: number }).daysUpdated ?? 0);
      } catch {
        /* a 200 without the documented body still means applied */
      }
      return done({ kind: "success", status: response.status, daysUpdated });
    }
    if (response.status === 429) {
      const header = Number(response.headers.get("retry-after"));
      // SEC-02: the header is the portal's word, not an order; never wait longer than the configured ceiling.
      const asked = Number.isInteger(header) && header > 0 ? header : DEFAULT_RETRY_AFTER_SECONDS;
      const retryAfterSeconds = Math.min(asked, this.#maxRetryAfterSeconds);
      return done({ kind: "rate_limited", status: 429, retryAfterSeconds });
    }
    const { code, message } = errorBody(text);
    if (response.status >= 500) return done({ kind: "unavailable", status: response.status, code, message });
    return done({ kind: "client_error", status: response.status, code, message });
  }
}
