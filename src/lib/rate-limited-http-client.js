import axios from 'axios';
import { TokenBucket } from './token-bucket.js';
import { categoriseEndpoint } from './zendesk-plan-limits.js';

/**
 * Axios wrapper with:
 *   - per-instance concurrency semaphore (default 5 in-flight)
 *   - optional proactive rate limit (token buckets per endpoint category) , 
 *     set via `targetRatePerMin` (legacy single-bucket) or
 *     `targetRatesByCategory` (per-category buckets, recommended)
 *   - 429 retry honoring Retry-After header (3 attempts total)
 *   - exponential backoff fallback when no Retry-After header (1s, 2s, 4s)
 *   - 30s request timeout
 *
 * Errors thrown carry a `code` field that the envelope helper maps to one of
 * `rate_limited` | `timeout` | `auth_failed` | `not_found` | `bad_request` |
 * `upstream_error`. The original axios error is attached as `cause`.
 *
 * I/O is injected: callers may pass a `transport` function that mimics
 * axios(config) → Promise<{ status, data, headers }>. Defaults to axios.
 * `now()` and `sleep(ms)` are also injectable for tests.
 */
export class RateLimitedHttpClient {
  constructor({
    baseUrl,
    auth, // { username, password }
    concurrency = 5,
    maxAttempts = 3,
    timeoutMs = 30000,
    targetRatePerMin, // legacy: optional single-bucket per-min budget
    targetRatesByCategory, // preferred: { default, search, incremental } per-min
    transport,
    sleep,
    now,
  } = {}) {
    if (!baseUrl) throw new Error('RateLimitedHttpClient: baseUrl required');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.auth = auth || null;
    this.maxAttempts = maxAttempts;
    this.timeoutMs = timeoutMs;
    this._transport = transport || axios;
    this._sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this._now = now || Date.now;

    // Simple semaphore: counter + FIFO queue of resolvers.
    this._available = concurrency;
    this._waiters = [];

    // Build per-category token buckets. Prefer the per-category map
    // (plan-based throttling); fall back to the single overall rate
    // (legacy `targetRatePerMin` config) which throttles all categories
    // uniformly.
    this._buckets = this._buildBuckets({
      targetRatePerMin,
      targetRatesByCategory,
    });
  }

  _buildBuckets({ targetRatePerMin, targetRatesByCategory }) {
    const buckets = {};
    const make = (perMin) => {
      if (!Number.isFinite(perMin) || perMin <= 0) return null;
      const ratePerSec = perMin / 60;
      const capacity = Math.max(5, Math.ceil(ratePerSec * 5));
      return new TokenBucket({
        ratePerSec,
        capacity,
        now: this._now,
        sleep: this._sleep,
      });
    };
    if (targetRatesByCategory && typeof targetRatesByCategory === 'object') {
      for (const [cat, perMin] of Object.entries(targetRatesByCategory)) {
        const b = make(perMin);
        if (b) buckets[cat] = b;
      }
      return buckets;
    }
    if (Number.isFinite(targetRatePerMin) && targetRatePerMin > 0) {
      const overall = make(targetRatePerMin);
      // Single-bucket mode: every category routes through the same bucket.
      buckets.default = overall;
      buckets.search = overall;
      buckets.incremental = overall;
    }
    return buckets;
  }

  async _acquire() {
    if (this._available > 0) {
      this._available -= 1;
      return;
    }
    await new Promise((resolve) => this._waiters.push(resolve));
    this._available -= 1;
  }

  _release() {
    this._available += 1;
    const next = this._waiters.shift();
    if (next) next();
  }

  /**
   * Make a request. Returns the parsed response body on success.
   *
   * @param {string} method  HTTP verb
   * @param {string} pathOrUrl  Relative path (joined to baseUrl) or absolute URL
   * @param {object} opts  { params, data, headers, timeoutMs }
   */
  async request(method, pathOrUrl, opts = {}) {
    const category = categoriseEndpoint(pathOrUrl);
    const bucket = this._buckets[category] || this._buckets.default;
    if (bucket) await bucket.acquire();
    await this._acquire();
    try {
      return await this._requestWithRetry(method, pathOrUrl, opts);
    } finally {
      this._release();
    }
  }

  async _requestWithRetry(method, pathOrUrl, opts) {
    const url = pathOrUrl.startsWith('http')
      ? pathOrUrl
      : `${this.baseUrl}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
    const config = {
      method,
      url,
      params: opts.params,
      data: opts.data,
      headers: opts.headers,
      timeout: opts.timeoutMs ?? this.timeoutMs,
    };
    if (this.auth) config.auth = this.auth;

    let lastError = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await this._transport(config);
        return response.data;
      } catch (err) {
        lastError = err;
        const classified = classifyAxiosError(err);

        // Timeouts: surface immediately, do not retry.
        if (classified === 'timeout') {
          throw makeError('timeout', 'Request timed out', err);
        }

        // 429: retry up to maxAttempts, honor Retry-After.
        if (classified === 'rate_limited' && attempt < this.maxAttempts) {
          const retryAfter = parseRetryAfter(err.response?.headers);
          const delay =
            retryAfter !== null
              ? retryAfter * 1000
              : exponentialBackoff(attempt);
          await this._sleep(delay);
          continue;
        }

        // Anything else: throw with classified code.
        if (classified === 'rate_limited') {
          throw makeError(
            'rate_limited',
            'Rate limited by upstream after retries',
            err,
            {
              http_status: 429,
              retry_after: parseRetryAfter(err.response?.headers),
            },
          );
        }
        throw makeError(classified, errorMessage(err), err, {
          http_status: err.response?.status,
        });
      }
    }
    // Loop exited via continue without throwing, only happens if we ran out
    // of attempts on 429 specifically.
    throw makeError(
      'rate_limited',
      'Rate limited by upstream after retries',
      lastError,
      {
        http_status: 429,
        retry_after: parseRetryAfter(lastError?.response?.headers),
      },
    );
  }
}

function classifyAxiosError(err) {
  // Axios timeout (ETIMEDOUT, ECONNABORTED, or err.code === 'ECONNABORTED')
  if (err && (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT')) {
    return 'timeout';
  }
  const status = err?.response?.status;
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 404) return 'not_found';
  if (status === 400 || status === 422) return 'bad_request';
  if (status && status >= 500) return 'upstream_error';
  return 'upstream_error';
}

function parseRetryAfter(headers) {
  if (!headers) return null;
  const v = headers['retry-after'] ?? headers['Retry-After'];
  if (v === undefined || v === null) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return n;
  // HTTP-date form, fall back to a small constant
  const t = Date.parse(v);
  if (!Number.isNaN(t)) {
    const delta = Math.max(0, t - Date.now()) / 1000;
    return delta;
  }
  return null;
}

function exponentialBackoff(attempt) {
  // attempt is 1-indexed; first retry = 1s, then 2s, 4s, ...
  return Math.pow(2, attempt - 1) * 1000;
}

function errorMessage(err) {
  if (err?.response) {
    return `Upstream ${err.response.status}: ${typeof err.response.data === 'string' ? err.response.data : JSON.stringify(err.response.data)}`;
  }
  return err?.message || 'Unknown upstream error';
}

function makeError(code, message, cause, extras = {}) {
  const e = new Error(message);
  e.code = code;
  e.cause = cause;
  Object.assign(e, extras);
  return e;
}
