import { loadConfig, ConfigError } from "./config.ts";
import { createLogger } from "./observability/logger.ts";

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
log.info({ port: config.port, portalUrl: config.portalUrl }, "availability sync service starting");
