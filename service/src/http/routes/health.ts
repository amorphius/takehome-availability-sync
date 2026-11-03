import type { FastifyInstance } from "fastify";
import type { Pool } from "../../db/pool.ts";

/** API-06: 200 when the database answers, 503 otherwise. */
export function registerHealthRoute(app: FastifyInstance, pool: Pool): void {
  app.get("/health", async (request, reply) => {
    try {
      await pool.query("select 1");
      return { status: "ok" };
    } catch (error) {
      request.log.warn({ err: error }, "health check: database unreachable");
      return reply.code(503).send({ status: "unavailable", reason: "database unreachable" });
    }
  });
}
