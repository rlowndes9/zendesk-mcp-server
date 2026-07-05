import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimitedHttpClient } from '../src/lib/rate-limited-http-client.js';

function makeAxiosError({ status, headers = {}, code }) {
  const err = new Error(`HTTP ${status || code || 'err'}`);
  if (status) err.response = { status, headers, data: { error: 'oops' } };
  if (code) err.code = code;
  return err;
}

test('RateLimitedHttpClient: semaphore bounds parallelism', async () => {
  let inFlight = 0;
  let peak = 0;
  const transport = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight -= 1;
    return { data: { ok: true } };
  };
  const client = new RateLimitedHttpClient({
    baseUrl: 'http://x',
    concurrency: 3,
    transport,
  });
  await Promise.all(
    Array.from({ length: 12 }, () => client.request('GET', '/p', {})),
  );
  assert.equal(peak, 3, `peak in-flight should be 3, got ${peak}`);
});

test('RateLimitedHttpClient: 429 retry honors Retry-After header', async () => {
  let calls = 0;
  const sleeps = [];
  const transport = async () => {
    calls += 1;
    if (calls < 3) {
      throw makeAxiosError({ status: 429, headers: { 'retry-after': '7' } });
    }
    return { data: { ok: true } };
  };
  const client = new RateLimitedHttpClient({
    baseUrl: 'http://x',
    concurrency: 1,
    transport,
    sleep: async (ms) => sleeps.push(ms),
  });
  const result = await client.request('GET', '/p', {});
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [7000, 7000]);
});

test('RateLimitedHttpClient: exponential backoff when Retry-After missing', async () => {
  let calls = 0;
  const sleeps = [];
  const transport = async () => {
    calls += 1;
    if (calls < 3) {
      throw makeAxiosError({ status: 429, headers: {} });
    }
    return { data: { ok: true } };
  };
  const client = new RateLimitedHttpClient({
    baseUrl: 'http://x',
    concurrency: 1,
    transport,
    sleep: async (ms) => sleeps.push(ms),
  });
  await client.request('GET', '/p', {});
  assert.deepEqual(sleeps, [1000, 2000]);
});

test('RateLimitedHttpClient: surfaces rate_limited after max attempts', async () => {
  const transport = async () => {
    throw makeAxiosError({ status: 429, headers: { 'retry-after': '1' } });
  };
  const client = new RateLimitedHttpClient({
    baseUrl: 'http://x',
    concurrency: 1,
    transport,
    sleep: async () => {},
  });
  await assert.rejects(
    () => client.request('GET', '/p', {}),
    (err) => {
      assert.equal(err.code, 'rate_limited');
      assert.equal(err.http_status, 429);
      return true;
    },
  );
});

test('RateLimitedHttpClient: timeout produces timeout error code', async () => {
  const transport = async () => {
    throw makeAxiosError({ code: 'ECONNABORTED' });
  };
  const client = new RateLimitedHttpClient({
    baseUrl: 'http://x',
    concurrency: 1,
    transport,
    sleep: async () => {},
  });
  await assert.rejects(
    () => client.request('GET', '/p', {}),
    (err) => err.code === 'timeout',
  );
});

test('RateLimitedHttpClient: 401 → auth_failed (not retried)', async () => {
  let calls = 0;
  const transport = async () => {
    calls += 1;
    throw makeAxiosError({ status: 401 });
  };
  const client = new RateLimitedHttpClient({
    baseUrl: 'http://x',
    concurrency: 1,
    transport,
    sleep: async () => {},
  });
  await assert.rejects(
    () => client.request('GET', '/p', {}),
    (err) => err.code === 'auth_failed',
  );
  assert.equal(calls, 1, 'auth errors must not retry');
});

test('RateLimitedHttpClient: 404 → not_found', async () => {
  const transport = async () => {
    throw makeAxiosError({ status: 404 });
  };
  const client = new RateLimitedHttpClient({
    baseUrl: 'http://x',
    concurrency: 1,
    transport,
  });
  await assert.rejects(
    () => client.request('GET', '/p', {}),
    (err) => err.code === 'not_found',
  );
});
