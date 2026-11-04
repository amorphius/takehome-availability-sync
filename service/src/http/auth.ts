import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../domain/update.ts";

/** SEC-10: the only path that never needs the key; a probe must work before anyone has a key. */
const OPEN_PATHS = new Set(["/health"]);

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * SEC-01: when a key is configured, every route except /health requires `X-Api-Key` equal to it.
 * Digests are compared so the comparison takes the same time whatever the length or content of the header.
 */
export function registerApiKeyAuth(app: FastifyInstance, apiKey: string): void {
  const expected = digest(apiKey);
  app.addHook("onRequest", async (request) => {
    const path = request.url.split("?", 1)[0] ?? request.url;
    if (OPEN_PATHS.has(path)) return;
    const header = request.headers["x-api-key"];
    const presented = typeof header === "string" ? header : "";
    if (!timingSafeEqual(digest(presented), expected)) {
      throw new ApiError(401, "UNAUTHORIZED", "Missing or invalid X-Api-Key");
    }
  });
}
