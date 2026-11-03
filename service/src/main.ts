import { loadConfig, ConfigError } from "./config.ts";
import { createLogger } from "./observability/logger.ts";
import { createPool } from "./db/pool.ts";
import { migrate } from "./db/migrate.ts";
import { SyncRepository } from "./sync/repository.ts";
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
const app = buildServer({ logger: log, repository });
await app.listen({ port: config.port, host: "0.0.0.0" });
log.info({ port: config.port, portalUrl: config.portalUrl }, "availability sync service listening");
