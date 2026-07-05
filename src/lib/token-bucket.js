/**
 * Token-bucket rate limiter.
 *
 * Used to proactively throttle outbound requests to a target rate, so we
 * stay well under a known plan-level Zendesk rate limit and don't trip 429s
 * (or burn through a small-plan client's budget on a single audit fan-out).
 *
 * Construction:
 *   new TokenBucket({ ratePerSec, capacity, now? })
 *
 * Behaviour:
 *   - `acquire()` consumes one token. If none are available, it sleeps until
 *     the next token refills, then consumes it.
 *   - Tokens refill at `ratePerSec` per second, capped at `capacity` (the
 *     burst tolerance).
 *   - Thread of execution is FIFO via the underlying setTimeout queue.
 *
 * Injection:
 *   - `now` defaults to Date.now (overridable for tests).
 *   - `sleep` defaults to setTimeout (overridable for tests).
 */
export class TokenBucket {
  constructor({ ratePerSec, capacity, now, sleep } = {}) {
    if (!Number.isFinite(ratePerSec) || ratePerSec <= 0) {
      throw new Error('TokenBucket: ratePerSec must be a positive number');
    }
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error('TokenBucket: capacity must be a positive number');
    }
    this._rate = ratePerSec;
    this._capacity = capacity;
    this._tokens = capacity;
    this._now = now || Date.now;
    this._sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this._lastRefill = this._now();
    // Serialize acquires so concurrent callers don't all see the same tokens.
    this._chain = Promise.resolve();
  }

  _refill() {
    const now = this._now();
    const elapsedSec = (now - this._lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    this._tokens = Math.min(
      this._capacity,
      this._tokens + elapsedSec * this._rate,
    );
    this._lastRefill = now;
  }

  /**
   * Consume one token, sleeping if necessary until one is available.
   * Concurrent calls are queued so each gets its own token.
   */
  acquire() {
    const next = this._chain.then(() => this._acquireOne());
    // Swallow the result on the chain so a thrown error doesn't poison subsequent acquires.
    this._chain = next.catch(() => {});
    return next;
  }

  async _acquireOne() {
    this._refill();
    if (this._tokens >= 1) {
      this._tokens -= 1;
      return;
    }
    const deficit = 1 - this._tokens;
    const waitMs = (deficit / this._rate) * 1000;
    await this._sleep(waitMs);
    this._refill();
    // After sleeping for exactly the deficit, we should have ≥1 token.
    // Use Math.max in case clock jitter or rounding put us slightly under.
    this._tokens = Math.max(0, this._tokens - 1);
  }

  /** Inspect current token count (for diagnostics / tests). */
  get tokens() {
    this._refill();
    return this._tokens;
  }
}
