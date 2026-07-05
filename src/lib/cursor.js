/**
 * Opaque pagination cursor for Slice A list pagination.
 *
 * A cursor is a base64url-encoded JSON object:
 *   { instance, kind, queryHash, verbose, offset, cached_at }
 *
 * `cached_at` is the snapshot time of the cache entry the cursor was minted
 * against (the original fetched_at, not a hit-time timestamp). On decode we
 * compare it against the current cache entry's snapshot; a mismatch means the
 * cache has been refreshed and any offset arithmetic against the previous
 * corpus is meaningless, callers should reset to offset 0 and surface
 * `cursor_invalidated: true` in the response.
 *
 * Pure module: no I/O, no globals.
 */

function b64urlEncode(str) {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const normal = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(normal, 'base64').toString('utf8');
}

export function encode({ instance, kind, queryHash, verbose, offset, cached_at }) {
  const payload = JSON.stringify({
    i: instance ?? null,
    k: kind,
    q: queryHash ?? '',
    v: verbose ? 1 : 0,
    o: Number(offset) || 0,
    c: cached_at ?? null,
  });
  return b64urlEncode(payload);
}

export function decode(token) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('cursor: empty token');
  }
  let json;
  try {
    json = b64urlDecode(token);
  } catch (_e) {
    throw new Error('cursor: not base64url');
  }
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (_e) {
    throw new Error('cursor: not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('cursor: not an object');
  }
  return {
    instance: parsed.i ?? null,
    kind: parsed.k,
    queryHash: parsed.q ?? '',
    verbose: parsed.v === 1 || parsed.v === true,
    offset: Number(parsed.o) || 0,
    cached_at: parsed.c ?? null,
  };
}

/**
 * Returns true iff the cursor is still pointing at the same cache snapshot.
 * Both timestamps may be null on a fresh miss, so we treat null=null as
 * a match.
 */
export function isFresh(decoded, currentCachedAt) {
  if (!decoded) return false;
  return (decoded.cached_at ?? null) === (currentCachedAt ?? null);
}
