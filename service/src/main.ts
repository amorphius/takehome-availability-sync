import { createLogger } from "./observability/logger.ts";

const log = createLogger(process.env.LOG_LEVEL ?? "info");
log.info("availability sync service starting");
