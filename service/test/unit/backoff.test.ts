import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffMs } from "../../src/domain/backoff.ts";

test("SYNC-08: doubles from 2 s and caps at 60 s", () => {
  const noJitter = { random: () => 0 };
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 20].map((n) => backoffMs(n, noJitter)), [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
});

test("SYNC-08: jitter adds at most 50 %", () => {
  assert.equal(backoffMs(2, { random: () => 1 }), 6000);
  assert.equal(backoffMs(2, { random: () => 0.5 }), 5000);
  for (let i = 0; i < 200; i++) {
    const value = backoffMs(6);
    assert.ok(value >= 60000 && value <= 90000, `got ${value}`);
  }
});
