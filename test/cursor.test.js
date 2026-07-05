import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, isFresh } from '../src/lib/cursor.js';

test('cursor: encode/decode round-trip', () => {
  const fields = {
    instance: 'acme',
    kind: 'triggers',
    queryHash: 'all',
    verbose: false,
    offset: 100,
    cached_at: '2026-04-28T00:00:00.000Z',
  };
  const token = encode(fields);
  assert.equal(typeof token, 'string');
  assert.equal(/[+/=]/.test(token), false, 'token should be base64url, not standard base64');
  const decoded = decode(token);
  assert.deepEqual(decoded, fields);
});

test('cursor: round-trips verbose:true', () => {
  const token = encode({
    instance: 'acme',
    kind: 'triggers',
    queryHash: 'all',
    verbose: true,
    offset: 0,
    cached_at: null,
  });
  const decoded = decode(token);
  assert.equal(decoded.verbose, true);
  assert.equal(decoded.cached_at, null);
});

test('cursor: decode rejects empty / non-string', () => {
  assert.throws(() => decode(''), /empty/);
  assert.throws(() => decode(null), /empty/);
});

test('cursor: decode rejects non-base64url', () => {
  assert.throws(() => decode('not!valid@base64'), /JSON|base64/);
});

test('cursor: decode rejects valid base64 of non-JSON', () => {
  // base64url('hello'), not JSON
  const bad = Buffer.from('hello').toString('base64').replace(/=+$/, '');
  assert.throws(() => decode(bad), /JSON/);
});

test('cursor: isFresh, matching cached_at returns true', () => {
  const cached_at = '2026-04-28T00:00:00.000Z';
  const decoded = decode(
    encode({ instance: 'a', kind: 'k', queryHash: 'q', verbose: false, offset: 0, cached_at }),
  );
  assert.equal(isFresh(decoded, cached_at), true);
});

test('cursor: isFresh, mismatched cached_at returns false (stale)', () => {
  const decoded = decode(
    encode({
      instance: 'a',
      kind: 'k',
      queryHash: 'q',
      verbose: false,
      offset: 50,
      cached_at: '2026-04-28T00:00:00.000Z',
    }),
  );
  assert.equal(isFresh(decoded, '2026-04-28T00:05:00.000Z'), false);
});

test('cursor: isFresh, null/null treated as fresh', () => {
  const decoded = decode(
    encode({ instance: 'a', kind: 'k', queryHash: 'q', verbose: false, offset: 0, cached_at: null }),
  );
  assert.equal(isFresh(decoded, null), true);
});

test('cursor: offset arithmetic survives a round-trip', () => {
  for (const offset of [0, 1, 99, 100, 1000, 24999]) {
    const token = encode({
      instance: 'acme',
      kind: 'triggers',
      queryHash: 'all',
      verbose: false,
      offset,
      cached_at: 'x',
    });
    assert.equal(decode(token).offset, offset);
  }
});
