import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResourceCache } from '../src/lib/resource-cache.js';

test('ResourceCache: first call is a miss; second is a hit within TTL', async () => {
  let now = 1000;
  const cache = new ResourceCache({ defaultTtlMs: 5000, now: () => now });
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return { value: 'v' };
  };
  const key = ResourceCache.makeKey('acme', 'triggers', 'all', false);

  const first = await cache.getOrFetch(key, undefined, fetcher);
  assert.equal(first.cached_at, null);
  assert.equal(first.value.value, 'v');

  now += 1000;
  const second = await cache.getOrFetch(key, undefined, fetcher);
  assert.ok(second.cached_at, 'cached_at should be populated on hit');
  assert.notEqual(second.cached_at, null);
  assert.equal(second.fetched_at, first.fetched_at, 'fetched_at unchanged on hit');
  assert.equal(calls, 1, 'fetcher should run only once');
});

test('ResourceCache: TTL expiry triggers re-fetch', async () => {
  let now = 1000;
  const cache = new ResourceCache({ defaultTtlMs: 1000, now: () => now });
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return calls;
  };
  const key = ResourceCache.makeKey('a', 'k', 'q', false);

  await cache.getOrFetch(key, undefined, fetcher);
  now += 2000;
  await cache.getOrFetch(key, undefined, fetcher);
  assert.equal(calls, 2);
});

test('ResourceCache: keys separate by instance, kind, queryHash, verbose', async () => {
  const cache = new ResourceCache();
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return calls;
  };
  await cache.getOrFetch(
    ResourceCache.makeKey('a', 'triggers', 'all', false),
    undefined,
    fetcher,
  );
  await cache.getOrFetch(
    ResourceCache.makeKey('b', 'triggers', 'all', false),
    undefined,
    fetcher,
  );
  await cache.getOrFetch(
    ResourceCache.makeKey('a', 'macros', 'all', false),
    undefined,
    fetcher,
  );
  await cache.getOrFetch(
    ResourceCache.makeKey('a', 'triggers', 'all', true),
    undefined,
    fetcher,
  );
  await cache.getOrFetch(
    ResourceCache.makeKey('a', 'triggers', 'q2', false),
    undefined,
    fetcher,
  );
  assert.equal(calls, 5, 'all five keys should be distinct');
});

test('ResourceCache: invalidate(instance) wipes only that instance', async () => {
  const cache = new ResourceCache();
  const f = async () => 1;
  await cache.getOrFetch(
    ResourceCache.makeKey('a', 'triggers', 'all', false),
    undefined,
    f,
  );
  await cache.getOrFetch(
    ResourceCache.makeKey('b', 'triggers', 'all', false),
    undefined,
    f,
  );
  cache.invalidate('a');
  assert.equal(cache.size(), 1);
});

test('ResourceCache: invalidate(instance, kinds) wipes only matching kinds', async () => {
  const cache = new ResourceCache();
  const f = async () => 1;
  await cache.getOrFetch(
    ResourceCache.makeKey('a', 'triggers', 'all', false),
    undefined,
    f,
  );
  await cache.getOrFetch(
    ResourceCache.makeKey('a', 'macros', 'all', false),
    undefined,
    f,
  );
  await cache.getOrFetch(
    ResourceCache.makeKey('a', 'triggers', 'all', true),
    undefined,
    f,
  );
  cache.invalidate('a', ['triggers']);
  assert.equal(cache.size(), 1, 'only the macros entry should remain');
});

test('ResourceCache: invalidate() with no args wipes everything', async () => {
  const cache = new ResourceCache();
  const f = async () => 1;
  await cache.getOrFetch(
    ResourceCache.makeKey('a', 'triggers', 'all', false),
    undefined,
    f,
  );
  await cache.getOrFetch(
    ResourceCache.makeKey('b', 'macros', 'all', false),
    undefined,
    f,
  );
  cache.invalidate();
  assert.equal(cache.size(), 0);
});
