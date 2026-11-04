import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { testPool } from "../helpers/db.ts";
import { testServer } from "../helpers/app.ts";
import { BODY_LIMIT_BYTES, REQUEST_TIMEOUT_MS, CONNECTION_TIMEOUT_MS } from "../../src/http/server.ts";
import type { Pool } from "../../src/db/pool.ts";

let pool: Pool;
before(async () => {
  pool = await testPool();
});
after(async () => {
  await pool.end();
});

const body = { accommodationId: "acc-1003", from: "2026-10-01", to: "2026-11-15", available: false, pricePerNight: 99.5 };

test("API-01 DATA-02: POST /updates answers 202 and the update with its jobs is already committed", async () => {
  const { app, repository } = testServer(pool);
  const response = await app.inject({ method: "POST", url: "/updates", payload: body });
  assert.equal(response.statusCode, 202);
  const json = response.json();
  assert.match(json.updateId, /^[0-9a-f-]{36}$/);
  assert.equal(json.accommodationId, "acc-1003");
  assert.equal(json.chunks, 2);
  assert.equal(json.status, "pending");

  const update = await pool.query("select * from updates where id = $1", [json.updateId]);
  assert.equal(update.rowCount, 1);
  assert.deepEqual(
    { from: update.rows[0].from_date, to: update.rows[0].to_date, available: update.rows[0].available, price: update.rows[0].price_per_night },
    { from: "2026-10-01", to: "2026-11-15", available: false, price: 99.5 },
  );
  const jobs = await repository.jobsOfUpdate(json.updateId);
  assert.deepEqual(
    jobs.map((j) => ({ from: j.from, to: j.to, state: j.state, attempts: j.attempts, price: j.pricePerNight })),
    [
      { from: "2026-10-01", to: "2026-10-31", state: "pending", attempts: 0, price: 99.5 },
      { from: "2026-11-01", to: "2026-11-15", state: "pending", attempts: 0, price: 99.5 },
    ],
  );
  await app.close();
});

test("API-02: invalid bodies get the documented error shape over HTTP", async () => {
  const { app } = testServer(pool);
  const bad = await app.inject({ method: "POST", url: "/updates", payload: { ...body, to: "2026-02-30" } });
  assert.equal(bad.statusCode, 400);
  assert.deepEqual(bad.json().error.code, "INVALID_DATE");
  const notJson = await app.inject({ method: "POST", url: "/updates", payload: "{nope", headers: { "content-type": "application/json" } });
  assert.equal(notJson.statusCode, 400);
  assert.equal(notJson.json().error.code, "INVALID_BODY");
  const unknown = await app.inject({ method: "GET", url: "/nothing" });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json().error.code, "NOT_FOUND");
  await app.close();
});

test("SEC-07: a body above 16 KiB is 413 BODY_TOO_LARGE and the server has request and connection timeouts", async () => {
  const { app } = testServer(pool);
  const big = await app.inject({ method: "POST", url: "/updates", payload: { ...body, accommodationId: "x".repeat(20_000) } });
  assert.equal(big.statusCode, 413);
  assert.equal(big.json().error.code, "BODY_TOO_LARGE");
  assert.equal(app.initialConfig.bodyLimit, BODY_LIMIT_BYTES);
  await app.ready();
  const server = app.server as unknown as { requestTimeout: number; timeout: number };
  assert.equal(server.requestTimeout, REQUEST_TIMEOUT_MS);
  assert.equal(server.timeout, CONNECTION_TIMEOUT_MS);
  assert.equal((await pool.query("select count(*)::int as n from updates where accommodation_id like 'xxxx%'")).rows[0].n, 0);
  await app.close();
});
