import { loadConfig, ConfigError } from "./config.ts";
import { createLogger } from "./observability/logger.ts";
import { createPool } from "./db/pool.ts";
import { migrate } from "./db/migrate.ts";
import { SyncRepository } from "./sync/repository.ts";
import { PortalClient } from "./sync/portalClient.ts";
import { SlidingWindowLimiter } from "./sync/rateLimiter.ts";
import { Worker } from "./sync/worker.ts";
import { buildServer } from "./http/server.ts";

let config;
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
const worker = new Worker({
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

const app = buildServer({ logger: log, repository });
await app.listen({ port: config.port, host: "0.0.0.0" });
await worker.start();
log.info({ port: config.port, portalUrl: config.portalUrl }, "availability sync service listening");
