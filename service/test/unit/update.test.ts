import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUpdateRequest, ApiError } from "../../src/domain/update.ts";

const valid = { accommodationId: "acc-1003", from: "2026-10-01", to: "2026-10-07", available: true, pricePerNight: 120 };

function rejects(body: unknown, code: string, pattern: RegExp) {
  assert.throws(() => parseUpdateRequest(body), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 400);
    assert.equal(e.code, code);
    assert.match(e.message, pattern);
    return true;
  });
}

test("API-02: a valid body is returned as-is", () => {
  assert.deepEqual(parseUpdateRequest(valid), valid);
  assert.deepEqual(parseUpdateRequest({ ...valid, pricePerNight: 0 }).pricePerNight, 0);
});

test("API-02: INVALID_BODY for shape, missing, unknown and wrongly typed fields", () => {
  rejects(null, "INVALID_BODY", /JSON object/);
  rejects([valid], "INVALID_BODY", /JSON object/);
  rejects({ ...valid, extra: 1 }, "INVALID_BODY", /Unknown field "extra"/);
  const { to: _to, ...missingTo } = valid;
  rejects(missingTo, "INVALID_BODY", /Missing field "to"/);
  rejects({ ...valid, accommodationId: "" }, "INVALID_BODY", /accommodationId/);
  rejects({ ...valid, accommodationId: 7 }, "INVALID_BODY", /accommodationId/);
  rejects({ ...valid, available: "yes" }, "INVALID_BODY", /available/);
  rejects({ ...valid, pricePerNight: "120" }, "INVALID_BODY", /pricePerNight/);
  rejects({ ...valid, pricePerNight: -1 }, "INVALID_BODY", /pricePerNight/);
  rejects({ ...valid, pricePerNight: Number.NaN }, "INVALID_BODY", /pricePerNight/);
});

test("API-02: INVALID_DATE for malformed, non-existent and reversed dates", () => {
  rejects({ ...valid, from: "01/10/2026" }, "INVALID_DATE", /"from"/);
  rejects({ ...valid, to: "2026-02-30" }, "INVALID_DATE", /"to"/);
  rejects({ ...valid, from: "2026-10-08" }, "INVALID_DATE", /same day as "from" or later/);
});

test("API-02: RANGE_TOO_LARGE above 366 days, allowed at 366", () => {
  assert.ok(parseUpdateRequest({ ...valid, from: "2026-01-01", to: "2027-01-01" }));
  rejects({ ...valid, from: "2026-01-01", to: "2027-01-02" }, "RANGE_TOO_LARGE", /367 days/);
});

test("SEC-04: accommodationId is bounded in length and character set", () => {
  assert.equal(parseUpdateRequest({ ...valid, accommodationId: "a".repeat(64) }).accommodationId.length, 64);
  assert.equal(parseUpdateRequest({ ...valid, accommodationId: "Acc_1003.v2-x" }).accommodationId, "Acc_1003.v2-x");
  rejects({ ...valid, accommodationId: "a".repeat(65) }, "INVALID_BODY", /at most 64/);
  rejects({ ...valid, accommodationId: "acc 1003" }, "INVALID_BODY", /accommodationId/);
  rejects({ ...valid, accommodationId: "acc/1003" }, "INVALID_BODY", /accommodationId/);
  rejects({ ...valid, accommodationId: "acc\n1003" }, "INVALID_BODY", /accommodationId/);
  rejects({ ...valid, accommodationId: " acc-1003" }, "INVALID_BODY", /accommodationId/);
});

test("SEC-05: pricePerNight fits the numeric(10,2) column", () => {
  assert.equal(parseUpdateRequest({ ...valid, pricePerNight: 99_999_999.99 }).pricePerNight, 99_999_999.99);
  assert.equal(parseUpdateRequest({ ...valid, pricePerNight: 0.5 }).pricePerNight, 0.5);
  rejects({ ...valid, pricePerNight: 100_000_000 }, "INVALID_BODY", /at most 99999999.99/);
  rejects({ ...valid, pricePerNight: 1e12 }, "INVALID_BODY", /pricePerNight/);
  rejects({ ...valid, pricePerNight: 10.005 }, "INVALID_BODY", /two decimals/);
});
