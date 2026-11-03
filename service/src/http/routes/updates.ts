import type { FastifyInstance } from "fastify";
import { parseUpdateRequest } from "../../domain/update.ts";
import type { SyncRepository } from "../../sync/repository.ts";

/** API-01: accept an update; it is durable before the 202 leaves. */
export function registerUpdatesRoute(app: FastifyInstance, repository: SyncRepository): void {
  app.post("/updates", async (request, reply) => {
    const update = parseUpdateRequest(request.body);
    const accepted = await repository.acceptUpdate(update);
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
