export interface Config {
  port: number;
  /** SEC-01: loopback by default; a container sets 0.0.0.0. */
  host: string;
  /** SEC-01: when set, the data endpoints and /metrics require it as X-Api-Key. */
  apiKey: string | undefined;
  databaseUrl: string;
  portalUrl: string;
  portalApiKey: string;
  portalTimeoutMs: number;
  portalRateLimitPerMinute: number;
  portalMaxRetryAfterSeconds: number;
  workerConcurrency: number;
  workerPollMs: number;
  maxAttempts: number;
  leaseSeconds: number;
  logLevel: string;
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

function integer(env: Env, name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

function string(env: Env, name: string, fallback: string): string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw;
}

function optional(env: Env, name: string): string | undefined {
  const raw = env[name];
  return raw === undefined || raw.trim() === "" ? undefined : raw;
}

/** SEC-08: in production a secret has no default; forgetting it stops start-up instead of talking to real systems with demo values. */
function secret(env: Env, name: string, fallback: string | undefined, production: boolean): string | undefined {
  const value = optional(env, name);
  if (value !== undefined) return value;
  if (production) throw new ConfigError(`${name} is required when NODE_ENV=production`);
  return fallback;
}

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];

/** OPS-01: configuration from the environment; an invalid value names the variable. */
export function loadConfig(env: Env = process.env): Config {
  const production = env.NODE_ENV === "production";
  const logLevel = string(env, "LOG_LEVEL", "info");
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new ConfigError(`LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}, got "${logLevel}"`);
  }
  return {
    port: integer(env, "PORT", 3000, 0, 65535),
    host: string(env, "HOST", "127.0.0.1"),
    apiKey: secret(env, "API_KEY", undefined, production),
    databaseUrl: secret(env, "DATABASE_URL", "postgres://sync:sync@localhost:5432/sync", production)!,
    portalUrl: string(env, "PORTAL_URL", "http://localhost:4000").replace(/\/+$/, ""),
    portalApiKey: secret(env, "PORTAL_API_KEY", "sol-demo-key", production)!,
    portalTimeoutMs: integer(env, "PORTAL_TIMEOUT_MS", 5000, 1),
    portalRateLimitPerMinute: integer(env, "PORTAL_RATE_LIMIT_PER_MINUTE", 30, 1),
    portalMaxRetryAfterSeconds: integer(env, "PORTAL_MAX_RETRY_AFTER_SECONDS", 300, 1),
    workerConcurrency: integer(env, "WORKER_CONCURRENCY", 4, 1, 100),
    workerPollMs: integer(env, "WORKER_POLL_MS", 250, 1),
    maxAttempts: integer(env, "MAX_ATTEMPTS", 8, 1),
    leaseSeconds: integer(env, "LEASE_SECONDS", 60, 1),
    logLevel,
  };
}
