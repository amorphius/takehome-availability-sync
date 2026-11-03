import pino from "pino";
import type { Pool } from "../../src/db/pool.ts";
import { SyncRepository } from "../../src/sync/repository.ts";
import { buildServer } from "../../src/http/server.ts";

export function silentLogger() {
  return pino({ level: "silent" });
}

export function testServer(pool: Pool) {
  const repository = new SyncRepository(pool);
  const app = buildServer({ logger: silentLogger(), repository });
  return { app, repository };
}
