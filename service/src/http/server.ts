import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import type { Logger } from "../observability/logger.ts";
import { ApiError } from "../domain/update.ts";
import type { SyncRepository } from "../sync/repository.ts";
import { registerUpdatesRoute } from "./routes/updates.ts";
import { registerStatusRoute } from "./routes/status.ts";
import { registerHealthRoute } from "./routes/health.ts";
import { registerMetricsRoute } from "./routes/metrics.ts";
import type { Metrics } from "../observability/metrics.ts";

export interface ServerDeps {
  logger: Logger;
  repository: SyncRepository;
  metrics: Metrics;
}

export function buildServer({ logger, repository, metrics }: ServerDeps): FastifyInstance {
  // pino's Logger type is stricter than FastifyBaseLogger only in optional fields; the instance is compatible.
  const app = Fastify({ loggerInstance: logger as unknown as FastifyBaseLogger, disableRequestLogging: true });

  // OBS-01: one line per request with reqId, method, url, statusCode and durationMs. The scrape and probe
  // endpoints log at debug so they do not drown the lines that matter.
  app.addHook("onResponse", (request, reply, done) => {
    const level = request.url === "/metrics" || request.url === "/health" ? "debug" : "info";
    request.log[level](
      { method: request.method, url: request.url, statusCode: reply.statusCode, durationMs: Math.round(reply.elapsedTime) },
      "request completed",
    );
    done();
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    }
    const fastifyError = error as { statusCode?: number; code?: string };
    if (fastifyError.statusCode === 400 || fastifyError.code === "FST_ERR_CTP_INVALID_JSON_BODY") {
      return reply.code(400).send({ error: { code: "INVALID_BODY", message: "Request body must be valid JSON" } });
    }
    request.log.error({ err: error }, "unexpected error");
    return reply.code(500).send({ error: { code: "INTERNAL", message: "Internal error" } });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: { code: "NOT_FOUND", message: "Resource not found" } }),
  );

  registerUpdatesRoute(app, repository, metrics);
  registerStatusRoute(app, repository);
  registerHealthRoute(app, repository.pool);
  registerMetricsRoute(app, metrics.registry);
  return app;
}
