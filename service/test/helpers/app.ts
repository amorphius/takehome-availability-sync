import pino from "pino";
import type { Pool } from "../../src/db/pool.ts";
import { SyncRepository } from "../../src/sync/repository.ts";
import { buildServer } from "../../src/http/server.ts";
import { createMetrics, type Metrics } from "../../src/observability/metrics.ts";

export function silentLogger() {
  return pino({ level: "silent" });
}

export function testServer(pool: Pool, metrics: Metrics = createMetrics()) {
  const repository = new SyncRepository(pool);
  const app = buildServer({ logger: silentLogger(), repository, metrics });
  return { app, repository, metrics };
}
