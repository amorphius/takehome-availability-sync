import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import type { Logger } from "../observability/logger.ts";
import { ApiError } from "../domain/update.ts";
import type { SyncRepository } from "../sync/repository.ts";
import { registerUpdatesRoute } from "./routes/updates.ts";

export interface ServerDeps {
  logger: Logger;
  repository: SyncRepository;
}

export function buildServer({ logger, repository }: ServerDeps): FastifyInstance {
  // pino's Logger type is stricter than FastifyBaseLogger only in optional fields; the instance is compatible.
  const app = Fastify({ loggerInstance: logger as unknown as FastifyBaseLogger, disableRequestLogging: true });

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

  registerUpdatesRoute(app, repository);
  return app;
}
