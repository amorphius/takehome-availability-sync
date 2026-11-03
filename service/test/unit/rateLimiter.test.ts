import { test } from "node:test";
import assert from "node:assert/strict";
import { SlidingWindowLimiter, type LimiterClock } from "../../src/sync/rateLimiter.ts";

/** A clock whose sleep advances time instantly and records how long it was asked to wait. */
function fakeClock(start = 1_000_000) {
  let now = start;
  const sleeps: number[] = [];
  const clock: LimiterClock = {
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  };
  return { clock, sleeps, advance: (ms: number) => (now += ms), get now() { return now; } };
}

test("SYNC-12: admits `limit` starts at once, then waits for the oldest to leave the window", async () => {
  const t = fakeClock();
  const limiter = new SlidingWindowLimiter(3, 60_000, t.clock);
  await limiter.acquire();
  t.advance(10_000);
  await limiter.acquire();
  await limiter.acquire();
  assert.deepEqual(t.sleeps, []);
  assert.equal(limiter.inWindow, 3);

  await limiter.acquire();
  assert.deepEqual(t.sleeps, [50_000], "waited exactly until the first start aged out");
  assert.equal(limiter.inWindow, 3);
});

test("SYNC-12: every attempt counts; a released token does not", async () => {
  const t = fakeClock();
  const limiter = new SlidingWindowLimiter(2, 60_000, t.clock);
  const token = await limiter.acquire();
  await limiter.acquire();
  limiter.release(token);
  assert.equal(limiter.inWindow, 1);
  await limiter.acquire();
  assert.deepEqual(t.sleeps, [], "the released slot was reused without waiting");
});

test("SYNC-11: a pause blocks every caller until it ends, on top of the window", async () => {
  const t = fakeClock();
  const limiter = new SlidingWindowLimiter(10, 60_000, t.clock);
  limiter.pauseUntil(t.now + 42_000);
  assert.equal(limiter.paused, true);
  await limiter.acquire();
  assert.deepEqual(t.sleeps, [42_000]);
  assert.equal(limiter.paused, false);
  limiter.pauseUntil(t.now + 5_000);
  limiter.pauseUntil(t.now + 1_000);
  assert.equal(limiter.pausedUntil, t.now + 5_000, "a shorter pause never cuts a longer one");
});

test("SYNC-12: an aborted wait rejects instead of acquiring", async () => {
  const t = fakeClock();
  const controller = new AbortController();
  const limiter = new SlidingWindowLimiter(1, 60_000, {
    now: t.clock.now,
    sleep: async () => {
      controller.abort(new Error("stop"));
      throw controller.signal.reason;
    },
  });
  await limiter.acquire();
  await assert.rejects(limiter.acquire(controller.signal), /stop/);
  assert.equal(limiter.inWindow, 1);
});
