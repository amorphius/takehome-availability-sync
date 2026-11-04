import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeRequest {
  /** Date.now() when the request arrived. */
  at: number;
  method: string;
  path: string;
  apiKey: string | undefined;
  body: unknown;
}

export interface FakeResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** Never answer; the client must time out. */
  hang?: boolean;
  /** Milliseconds to wait before answering. */
  delayMs?: number;
}

export type Script = (request: FakeRequest, index: number) => FakeResponse;

export const ok = (daysUpdated = 7): FakeResponse => ({ status: 200, body: { daysUpdated } });
export const unavailable = (): FakeResponse => ({
  status: 503,
  body: { error: { code: "UNAVAILABLE", message: "Portal Sol is temporarily unavailable, please retry later" } },
});
export const rateLimited = (retryAfter: number): FakeResponse => ({
  status: 429,
  headers: { "retry-after": String(retryAfter) },
  body: { error: { code: "RATE_LIMITED", message: `Rate limit exceeded. Retry after ${retryAfter} seconds` } },
});
export const notFound = (id: string): FakeResponse => ({
  status: 404,
  body: { error: { code: "NOT_FOUND", message: `Accommodation ${id} not found` } },
});
export const hang = (): FakeResponse => ({ status: 0, hang: true });

/**
 * An in-process stand-in for Portal Sol (D-12). `script` decides each response; every request is recorded.
 * Only the PUT availability route exists; anything else is a 404 like the real portal.
 */
export class FakePortal {
  readonly requests: FakeRequest[] = [];
  #script: Script = () => ok();
  #server = createServer((req, res) => void this.#handle(req, res));
  #pending = new Set<ServerResponse>();
  #url = "";

  get url(): string {
    return this.#url;
  }

  /** Replace the script; the request index restarts at 0. */
  respond(script: Script | FakeResponse[]): void {
    if (Array.isArray(script)) {
      const queue = script;
      this.#script = (_request, index) => queue[Math.min(index, queue.length - 1)] ?? ok();
    } else {
      this.#script = script;
    }
    this.requests.length = 0;
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
    this.#url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
    return this.#url;
  }

  async stop(): Promise<void> {
    for (const res of this.#pending) res.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    const request: FakeRequest = {
      at: Date.now(),
      method: req.method ?? "",
      path: req.url ?? "",
      apiKey: req.headers["x-api-key"] as string | undefined,
      body,
    };
    const index = this.requests.length;
    this.requests.push(request);
    const response = this.#script(request, index);
    if (response.hang) {
      this.#pending.add(res);
      res.on("close", () => this.#pending.delete(res));
      return;
    }
    if (response.delayMs) await new Promise((r) => setTimeout(r, response.delayMs));
    const text = typeof response.body === "string";
    res.writeHead(response.status, { "content-type": text ? "text/plain" : "application/json", ...(response.headers ?? {}) });
    res.end(response.body === undefined ? "" : text ? response.body : JSON.stringify(response.body));
  }
}
