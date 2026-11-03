import type { FastifyInstance } from "fastify";
import type { Registry } from "prom-client";

/** OBS-02: Prometheus text format. */
export function registerMetricsRoute(app: FastifyInstance, registry: Registry): void {
  app.get("/metrics", async (_request, reply) => {
    reply.header("content-type", registry.contentType);
    return registry.metrics();
  });
}
