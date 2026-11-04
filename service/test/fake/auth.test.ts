import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { testPool } from "../helpers/db.ts";
import { testServer } from "../helpers/app.ts";
import { createPool, type Pool } from "../../src/db/pool.ts";

let pool: Pool;
before(async () => {
  pool = await testPool();
});
after(async () => {
  await pool.end();
});

const body = { accommodationId: "acc-1003", from: "2026-10-01", to: "2026-10-07", available: true, pricePerNight: 120 };

test("SEC-01 SEC-10: with API_KEY set, data endpoints and /metrics need the key; /health does not", async () => {
  const { app } = testServer(pool, { apiKey: "s3cret" });
  const without = await app.inject({ method: "POST", url: "/updates", payload: body });
  assert.equal(without.statusCode, 401);
  assert.deepEqual(without.json(), { error: { code: "UNAUTHORIZED", message: "Missing or invalid X-Api-Key" } });
  const wrong = await app.inject({ method: "POST", url: "/updates", payload: body, headers: { "x-api-key": "s3cret-but-longer" } });
  assert.equal(wrong.statusCode, 401);
  assert.equal((await pool.query("select count(*)::int as n from updates")).rows[0].n, 0, "nothing was written");
  const right = await app.inject({ method: "POST", url: "/updates", payload: body, headers: { "x-api-key": "s3cret" } });
  assert.equal(right.statusCode, 202);

  assert.equal((await app.inject({ method: "GET", url: "/accommodations/acc-1003/sync-status" })).statusCode, 401);
  assert.equal(
    (await app.inject({ method: "GET", url: "/accommodations/acc-1003/sync-status", headers: { "x-api-key": "s3cret" } })).statusCode,
    200,
  );
  assert.equal((await app.inject({ method: "GET", url: "/metrics" })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/metrics?x=1", headers: { "x-api-key": "s3cret" } })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/nothing" })).statusCode, 401, "unknown routes are not revealed either");
  const health = await app.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), { status: "ok" });
  await app.close();
});

test("SEC-01: without API_KEY every endpoint is open", async () => {
  const { app } = testServer(pool);
  assert.equal((await app.inject({ method: "GET", url: "/accommodations/acc-1003/sync-status" })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/metrics" })).statusCode, 200);
  await app.close();
});

test("SEC-10: /health says only that the database is unreachable, nothing about it", async () => {
  const dead = createPool("postgres://nobody@127.0.0.1:1/nothing");
  const { app } = testServer(dead, { apiKey: "s3cret" });
  const health = await app.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 503);
  assert.deepEqual(health.json(), { status: "unavailable", reason: "database unreachable" });
  await app.close();
  await dead.end();
});
