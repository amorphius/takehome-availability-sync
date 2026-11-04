import pino from "pino";
import type { Pool } from "../../src/db/pool.ts";
import { SyncRepository } from "../../src/sync/repository.ts";
import { buildServer, type InboundLimits } from "../../src/http/server.ts";
import { createMetrics, type Metrics } from "../../src/observability/metrics.ts";

export function silentLogger() {
  return pino({ level: "silent" });
}

export interface TestServerOptions {
  metrics?: Metrics;
  apiKey?: string;
  limits?: InboundLimits;
}

export function testServer(pool: Pool, options: TestServerOptions = {}) {
  const metrics = options.metrics ?? createMetrics();
  const repository = new SyncRepository(pool);
  const app = buildServer({ logger: silentLogger(), repository, metrics, apiKey: options.apiKey, limits: options.limits });
  return { app, repository, metrics };
}
