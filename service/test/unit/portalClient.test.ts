import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PortalClient } from "../../src/sync/portalClient.ts";
import { FakePortal, ok, unavailable, rateLimited, notFound, hang } from "../helpers/fakePortal.ts";

const portal = new FakePortal();
let client: PortalClient;
before(async () => {
  await portal.start();
  client = new PortalClient({ baseUrl: portal.url + "/", apiKey: "test-key", timeoutMs: 200 });
});
after(async () => {
  await portal.stop();
});

const body = { from: "2026-10-01", to: "2026-10-07", available: false, pricePerNight: 120 };

test("SYNC-05: sends PUT with the API key and JSON body, 200 is success", async () => {
  portal.respond([ok(7)]);
  const { outcome, durationMs } = await client.putAvailability("acc-1003", body);
  assert.deepEqual(outcome, { kind: "success", status: 200, daysUpdated: 7 });
  assert.ok(durationMs >= 0);
  assert.deepEqual(
    portal.requests.map(({ at: _at, ...r }) => r),
    [{ method: "PUT", path: "/api/v1/accommodations/acc-1003/availability", apiKey: "test-key", body }],
  );
});

test("SYNC-05: 429 is rate_limited with Retry-After, 60 s when the header is unusable", async () => {
  portal.respond([rateLimited(17), { status: 429, body: {} }]);
  assert.deepEqual((await client.putAvailability("acc-1003", body)).outcome, { kind: "rate_limited", status: 429, retryAfterSeconds: 17 });
  assert.deepEqual((await client.putAvailability("acc-1003", body)).outcome, { kind: "rate_limited", status: 429, retryAfterSeconds: 60 });
});

test("SYNC-05: 503 and other 5xx are unavailable, with the portal's code and message", async () => {
  portal.respond([unavailable(), { status: 502, body: "bad gateway" }]);
  const first = (await client.putAvailability("acc-1003", body)).outcome;
  assert.equal(first.kind, "unavailable");
  assert.equal(first.kind === "unavailable" && first.code, "UNAVAILABLE");
  const second = (await client.putAvailability("acc-1003", body)).outcome;
  assert.deepEqual(second, { kind: "unavailable", status: 502, code: "UNKNOWN", message: "bad gateway" });
});

test("SYNC-05: 400, 401 and 404 are client_error", async () => {
  portal.respond([
    notFound("acc-9"),
    { status: 401, body: { error: { code: "UNAUTHORIZED", message: "no" } } },
    { status: 400, body: { error: { code: "RANGE_TOO_LARGE", message: "32 days" } } },
  ]);
  const kinds = [];
  for (let i = 0; i < 3; i++) kinds.push((await client.putAvailability("acc-9", body)).outcome);
  assert.deepEqual(
    kinds.map((o) => o.kind),
    ["client_error", "client_error", "client_error"],
  );
  assert.deepEqual(
    kinds.map((o) => (o.kind === "client_error" ? o.code : null)),
    ["NOT_FOUND", "UNAUTHORIZED", "RANGE_TOO_LARGE"],
  );
});

test("SYNC-05: no answer within the timeout is timeout; a closed port is network_error", async () => {
  portal.respond([hang()]);
  const slow = await client.putAvailability("acc-1003", body);
  assert.deepEqual(slow.outcome, { kind: "timeout" });
  assert.ok(slow.durationMs >= 190 && slow.durationMs < 1000, `took ${slow.durationMs}ms`);
  const dead = new PortalClient({ baseUrl: "http://127.0.0.1:1", apiKey: "k", timeoutMs: 200 });
  assert.equal((await dead.putAvailability("acc-1003", body)).outcome.kind, "network_error");
});

test("SEC-02: a Retry-After above the ceiling is clamped to it", async () => {
  portal.respond([rateLimited(999_999_999), rateLimited(17), { status: 429, body: {} }]);
  const capped = new PortalClient({ baseUrl: portal.url, apiKey: "k", timeoutMs: 200, maxRetryAfterSeconds: 30 });
  assert.deepEqual((await capped.putAvailability("acc-1003", body)).outcome, { kind: "rate_limited", status: 429, retryAfterSeconds: 30 });
  assert.deepEqual(
    (await capped.putAvailability("acc-1003", body)).outcome,
    { kind: "rate_limited", status: 429, retryAfterSeconds: 17 },
    "below the ceiling it is kept",
  );
  assert.deepEqual(
    (await capped.putAvailability("acc-1003", body)).outcome,
    { kind: "rate_limited", status: 429, retryAfterSeconds: 30 },
    "the 60 s fallback is clamped too",
  );
});

test("SEC-06: a response body is read only up to the cap; the status still decides the outcome", async () => {
  portal.respond([{ status: 503, body: "abcdefghijklmnop" }]);
  const tiny = new PortalClient({ baseUrl: portal.url, apiKey: "k", timeoutMs: 2000, maxBodyBytes: 10 });
  const cut = (await tiny.putAvailability("acc-1003", body)).outcome;
  assert.deepEqual(cut, { kind: "unavailable", status: 503, code: "UNKNOWN", message: "abcdefghij" });

  // An endless body: the client must stop pulling at the cap and cancel the stream.
  let pulled = 0;
  let cancelled = false;
  const endless = (status: number) =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled++;
          controller.enqueue(new Uint8Array(1024).fill(120));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status, headers: { "content-type": "text/plain" } },
    );
  const streaming = new PortalClient({ baseUrl: "http://portal.test", apiKey: "k", timeoutMs: 2000, fetch: async () => endless(503) });
  const big = (await streaming.putAvailability("acc-1003", body)).outcome;
  assert.equal(big.kind, "unavailable");
  assert.ok(big.kind === "unavailable" && big.message.length <= 200);
  assert.ok(pulled >= 64 && pulled <= 80, `pulled ${pulled} KiB chunks for a 64 KiB cap`);
  assert.equal(cancelled, true, "the rest of the stream was cancelled");

  pulled = 0;
  const okStream = new PortalClient({ baseUrl: "http://portal.test", apiKey: "k", timeoutMs: 2000, fetch: async () => endless(200) });
  assert.equal((await okStream.putAvailability("acc-1003", body)).outcome.kind, "success", "a 200 with junk is still success");
  assert.ok(pulled <= 80);
});
