import { loadConfig, ConfigError, type Config } from "./config.ts";
import { createLogger } from "./observability/logger.ts";
import { createPool } from "./db/pool.ts";
import { migrate } from "./db/migrate.ts";
import { SyncRepository } from "./sync/repository.ts";
import { PortalClient } from "./sync/portalClient.ts";
import { SlidingWindowLimiter } from "./sync/rateLimiter.ts";
import { Worker } from "./sync/worker.ts";
import { buildServer } from "./http/server.ts";
import { createMetrics } from "./observability/metrics.ts";
import { createQueueGauges } from "./observability/queueGauges.ts";

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`configuration error: ${error.message}`);
    process.exit(1);
  }
  throw error;
}

const log = createLogger(config.logLevel);
const pool = createPool(config.databaseUrl);
const applied = await migrate(pool);
log.info({ applied }, "database migrated");

const repository = new SyncRepository(pool);
const metrics = createMetrics();
const queueGauges = createQueueGauges(metrics.registry, pool, log);
const worker = new Worker({
  observer: metrics.observer,
  store: repository,
  portal: new PortalClient({ baseUrl: config.portalUrl, apiKey: config.portalApiKey, timeoutMs: config.portalTimeoutMs }),
  limiter: new SlidingWindowLimiter(config.portalRateLimitPerMinute),
  logger: log.child({ component: "worker" }),
  config: {
    concurrency: config.workerConcurrency,
    pollMs: config.workerPollMs,
    maxAttempts: config.maxAttempts,
    leaseSeconds: config.leaseSeconds,
  },
});

const app = buildServer({ logger: log, repository, metrics });
await app.listen({ port: config.port, host: "0.0.0.0" });
await worker.start();
queueGauges.start(5000);
log.info({ port: config.port, portalUrl: config.portalUrl }, "availability sync service listening");

// OPS-02: stop taking requests and claiming jobs, let in-flight portal calls finish (bounded by the portal
// timeout), release the database, exit 0. A hard deadline guards against anything that refuses to end.
let stopping = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, "shutting down");
  const deadline = setTimeout(() => {
    log.error("shutdown deadline passed; exiting anyway");
    process.exit(1);
  }, config.portalTimeoutMs + 5000);
  deadline.unref();
  try {
    queueGauges.stop();
    await app.close();
    await worker.stop();
    await pool.end();
    log.info("shutdown complete");
    process.exit(0);
  } catch (error) {
    log.error({ err: error }, "shutdown failed");
    process.exit(1);
  }
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
