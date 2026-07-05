import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket } from '../src/lib/token-bucket.js';

function makeFakeClock(start = 1_000_000) {
  let t = start;
  let waited = 0;
  return {
    now: () => t,
    sleep: async (ms) => {
      waited += ms;
      t += ms;
    },
    advance: (ms) => {
      t += ms;
    },
    waited: () => waited,
  };
}

test('TokenBucket: rejects bad construction', () => {
  assert.throws(() => new TokenBucket({ ratePerSec: 0, capacity: 5 }));
  assert.throws(() => new TokenBucket({ ratePerSec: -1, capacity: 5 }));
  assert.throws(() => new TokenBucket({ ratePerSec: 1, capacity: 0 }));
  assert.throws(() => new TokenBucket({ ratePerSec: 1 })); // missing capacity
});

test('TokenBucket: starts full at capacity', () => {
  const clock = makeFakeClock();
  const b = new TokenBucket({ ratePerSec: 10, capacity: 5, ...clock });
  assert.equal(b.tokens, 5);
});

test('TokenBucket: acquire consumes one token without waiting when available', async () => {
  const clock = makeFakeClock();
  const b = new TokenBucket({ ratePerSec: 10, capacity: 5, ...clock });
  await b.acquire();
  assert.equal(b.tokens, 4);
  assert.equal(clock.waited(), 0);
});

test('TokenBucket: acquire sleeps when bucket is empty', async () => {
  const clock = makeFakeClock();
  // 10 req/sec, capacity 2. Drain it, then next acquire must wait.
  const b = new TokenBucket({ ratePerSec: 10, capacity: 2, ...clock });
  await b.acquire(); // tokens 2 -> 1
  await b.acquire(); // tokens 1 -> 0
  assert.equal(clock.waited(), 0);
  await b.acquire(); // empty -> must sleep ~100ms (1 token / 10 per sec)
  assert.ok(clock.waited() >= 100, `waited >=100ms, got ${clock.waited()}`);
});

test('TokenBucket: refills proportional to elapsed time', async () => {
  const clock = makeFakeClock();
  const b = new TokenBucket({ ratePerSec: 1, capacity: 5, ...clock });
  await b.acquire();
  await b.acquire();
  await b.acquire(); // tokens: 5 -> 2
  assert.equal(b.tokens, 2);
  clock.advance(2000); // 2 seconds → +2 tokens
  assert.equal(b.tokens, 4);
});

test('TokenBucket: refill cap respects capacity', async () => {
  const clock = makeFakeClock();
  const b = new TokenBucket({ ratePerSec: 100, capacity: 3, ...clock });
  await b.acquire(); // tokens 3 -> 2
  clock.advance(60_000); // way more than capacity worth
  assert.equal(b.tokens, 3); // capped, not 102
});

test('TokenBucket: serializes concurrent acquires', async () => {
  const clock = makeFakeClock();
  // 10 req/sec, capacity 2. Fire 5 acquires simultaneously.
  const b = new TokenBucket({ ratePerSec: 10, capacity: 2, ...clock });
  const results = await Promise.all([
    b.acquire(),
    b.acquire(),
    b.acquire(),
    b.acquire(),
    b.acquire(),
  ]);
  assert.equal(results.length, 5);
  // First 2 free, then 3 more at 100ms apart each = ~300ms total wait.
  assert.ok(
    clock.waited() >= 300,
    `expected >=300ms total wait for 3 throttled acquires, got ${clock.waited()}`,
  );
});

test('TokenBucket: a thrown sleep does not poison the chain', async () => {
  const clock = makeFakeClock();
  let firstSleep = true;
  const b = new TokenBucket({
    ratePerSec: 10,
    capacity: 1,
    now: clock.now,
    sleep: async (ms) => {
      if (firstSleep) {
        firstSleep = false;
        throw new Error('boom');
      }
      clock.advance(ms);
    },
  });
  await b.acquire(); // consumes the only token, no sleep needed
  await assert.rejects(() => b.acquire(), /boom/);
  // Subsequent acquires should still work (chain not poisoned).
  // Advance the clock so the bucket has a token available without sleeping.
  clock.advance(1000);
  await b.acquire();
});
