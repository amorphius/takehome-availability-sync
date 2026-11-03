import type { FastifyInstance } from "fastify";
import { ApiError } from "../../domain/update.ts";
import type { SyncRepository } from "../../sync/repository.ts";

/** API-03 / API-04: the sync status of one accommodation, 404 when it was never seen. */
export function registerStatusRoute(app: FastifyInstance, repository: SyncRepository): void {
  app.get<{ Params: { id: string } }>("/accommodations/:id/sync-status", async (request) => {
    const status = await repository.syncStatus(request.params.id);
    if (!status) throw new ApiError(404, "NOT_FOUND", `No update has been received for accommodation ${request.params.id}`);
    return status;
  });
}
