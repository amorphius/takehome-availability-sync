import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import type { Logger } from "../observability/logger.ts";
import { ApiError } from "../domain/update.ts";
import type { SyncRepository, QueueLimits } from "../sync/repository.ts";
import { registerUpdatesRoute } from "./routes/updates.ts";
import { registerStatusRoute } from "./routes/status.ts";
import { registerHealthRoute } from "./routes/health.ts";
import { registerMetricsRoute } from "./routes/metrics.ts";
import type { Metrics } from "../observability/metrics.ts";
import { registerApiKeyAuth } from "./auth.ts";

export interface ServerDeps {
  logger: Logger;
  repository: SyncRepository;
  metrics: Metrics;
  /** SEC-01: undefined leaves every endpoint open (development). */
  apiKey?: string | undefined;
  /** SEC-03: undefined means no inbound caps (tests). */
  limits?: InboundLimits | undefined;
}

export interface InboundLimits extends QueueLimits {
  updatesRateLimitPerMinute: number;
}

/** SEC-07: the largest valid body is under 300 bytes; slow or idle clients do not hold a socket for long. */
export const BODY_LIMIT_BYTES = 16 * 1024;
export const REQUEST_TIMEOUT_MS = 10_000;
export const CONNECTION_TIMEOUT_MS = 30_000;

export function buildServer({ logger, repository, metrics, apiKey, limits }: ServerDeps): FastifyInstance {
  // pino's Logger type is stricter than FastifyBaseLogger only in optional fields; the instance is compatible.
  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    disableRequestLogging: true,
    bodyLimit: BODY_LIMIT_BYTES,
    requestTimeout: REQUEST_TIMEOUT_MS,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
  });

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
    if (fastifyError.statusCode === 413) {
      return reply.code(413).send({ error: { code: "BODY_TOO_LARGE", message: `Request body must be at most ${BODY_LIMIT_BYTES} bytes` } });
    }
    if (fastifyError.statusCode === 400 || fastifyError.code === "FST_ERR_CTP_INVALID_JSON_BODY") {
      return reply.code(400).send({ error: { code: "INVALID_BODY", message: "Request body must be valid JSON" } });
    }
    request.log.error({ err: error }, "unexpected error");
    return reply.code(500).send({ error: { code: "INTERNAL", message: "Internal error" } });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: { code: "NOT_FOUND", message: "Resource not found" } }),
  );

  if (apiKey !== undefined) registerApiKeyAuth(app, apiKey);
  registerUpdatesRoute(app, repository, metrics, limits);
  registerStatusRoute(app, repository);
  registerHealthRoute(app, repository.pool);
  registerMetricsRoute(app, metrics.registry);
  return app;
}
