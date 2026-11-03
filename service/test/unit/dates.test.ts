import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDate, daysInclusive, splitRange } from "../../src/domain/dates.ts";

test("parseDate accepts real calendar days only", () => {
  assert.ok(parseDate("2026-02-28"));
  assert.ok(parseDate("2028-02-29"));
  assert.equal(parseDate("2026-02-30"), null);
  assert.equal(parseDate("2026-13-01"), null);
  assert.equal(parseDate("2026-1-01"), null);
  assert.equal(parseDate("2026-01-01T00:00:00Z"), null);
});

test("SYNC-01: a range of 31 days or fewer is one chunk", () => {
  assert.deepEqual(splitRange("2026-10-01", "2026-10-01"), [{ from: "2026-10-01", to: "2026-10-01" }]);
  assert.deepEqual(splitRange("2026-10-01", "2026-10-31"), [{ from: "2026-10-01", to: "2026-10-31" }]);
});

test("SYNC-01: 32 days split into 31 + 1, contiguous and covering the range", () => {
  assert.deepEqual(splitRange("2026-10-01", "2026-11-01"), [
    { from: "2026-10-01", to: "2026-10-31" },
    { from: "2026-11-01", to: "2026-11-01" },
  ]);
});

test("SYNC-01: longer ranges split evenly, crossing month ends and a leap day", () => {
  const chunks = splitRange("2028-01-15", "2028-04-14");
  assert.equal(daysInclusive("2028-01-15", "2028-04-14"), 91);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks[0], { from: "2028-01-15", to: "2028-02-14" });
  assert.deepEqual(chunks[1], { from: "2028-02-15", to: "2028-03-16" });
  assert.deepEqual(chunks[2], { from: "2028-03-17", to: "2028-04-14" });
  const covered = chunks.reduce((n, c) => n + daysInclusive(c.from, c.to), 0);
  assert.equal(covered, 91);
  for (let i = 1; i < chunks.length; i++) {
    assert.equal(daysInclusive(chunks[i - 1]!.to, chunks[i]!.from), 2, "chunks are adjacent");
  }
});
