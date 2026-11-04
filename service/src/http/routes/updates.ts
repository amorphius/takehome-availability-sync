import type { FastifyInstance, onRequestHookHandler } from "fastify";
import { parseUpdateRequest } from "../../domain/update.ts";
import type { SyncRepository } from "../../sync/repository.ts";
import type { Metrics } from "../../observability/metrics.ts";
import type { InboundLimits } from "../server.ts";
import { ClientRateLimiter } from "../clientRateLimit.ts";

/** SEC-03: one client address may not post faster than the configured rate; the answer says when to come back. */
function clientRateLimit(limit: number): onRequestHookHandler {
  const limiter = new ClientRateLimiter(limit);
  return (request, reply, done) => {
    const verdict = limiter.check(request.ip);
    if (verdict.allowed) return done();
    request.log.warn({ ip: request.ip, retryAfterSeconds: verdict.retryAfterSeconds }, "client rate limited");
    void reply
      .header("retry-after", String(verdict.retryAfterSeconds))
      .code(429)
      .send({ error: { code: "RATE_LIMITED", message: `Too many updates; retry after ${verdict.retryAfterSeconds} s` } });
  };
}

/** API-01: accept an update; it is durable before the 202 leaves. */
export function registerUpdatesRoute(app: FastifyInstance, repository: SyncRepository, metrics: Metrics, limits?: InboundLimits): void {
  const options = limits ? { onRequest: clientRateLimit(limits.updatesRateLimitPerMinute) } : {};
  app.post("/updates", options, async (request, reply) => {
    const update = parseUpdateRequest(request.body);
    const accepted = await repository.acceptUpdate(update, limits);
    metrics.updatesReceived.inc();
    request.log.info(
      { updateId: accepted.updateId, accommodationId: update.accommodationId, chunks: accepted.chunks },
      "update accepted",
    );
    return reply.code(202).send({
      updateId: accepted.updateId,
      accommodationId: update.accommodationId,
      chunks: accepted.chunks,
      status: "pending",
    });
  });
}
