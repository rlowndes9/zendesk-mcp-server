/**
 * In-memory TTL cache keyed by `${instance}::${kind}::${queryHash}::${verbose}`.
 * Records `cached_at` and `fetched_at` separately so the envelope can show
 * both when a hit is served.
 *
 * `now` is injectable for deterministic tests.
 */
export class ResourceCache {
  constructor({ defaultTtlMs = 5 * 60 * 1000, now } = {}) {
    this._defaultTtlMs = defaultTtlMs;
    this._now = now || Date.now;
    this._store = new Map();
  }

  static makeKey(instance, kind, queryHash, verbose) {
    return `${instance}::${kind}::${queryHash}::${verbose ? 'v' : 't'}`;
  }

  /**
   * Returns cached entry if fresh; else calls fetcher, stores, and returns.
   *
   * @param {string} key
   * @param {number} ttlMs
   * @param {() => Promise<any>} fetcher
   * @returns {{ value, fetched_at, cached_at }}
   *   - On hit: `cached_at` = now (i.e. when this hit was served);
   *     `fetched_at` = original fetch time.
   *   - On miss: `cached_at` = null; `fetched_at` = now.
   */
  async getOrFetch(key, ttlMs, fetcher) {
    const ttl = ttlMs ?? this._defaultTtlMs;
    const now = this._now();
    const existing = this._store.get(key);
    if (existing && now - existing.fetchedAt < ttl) {
      return {
        value: existing.value,
        fetched_at: new Date(existing.fetchedAt).toISOString(),
        cached_at: new Date(now).toISOString(),
      };
    }
    const value = await fetcher();
    const fetchedAt = this._now();
    this._store.set(key, { value, fetchedAt });
    return {
      value,
      fetched_at: new Date(fetchedAt).toISOString(),
      cached_at: null,
    };
  }

  /**
   * Wipe entries.
   *   - invalidate(instance) → drop every key whose instance segment matches.
   *   - invalidate(instance, ['triggers']) → drop only matching kinds.
   */
  invalidate(instance, kinds) {
    if (!instance) {
      this._store.clear();
      return;
    }
    const kindSet = kinds && kinds.length ? new Set(kinds) : null;
    const prefix = `${instance}::`;
    for (const key of this._store.keys()) {
      if (!key.startsWith(prefix)) continue;
      if (!kindSet) {
        this._store.delete(key);
        continue;
      }
      const kind = key.slice(prefix.length).split('::')[0];
      if (kindSet.has(kind)) {
        this._store.delete(key);
      }
    }
  }

  /** Test helper. */
  size() {
    return this._store.size;
  }
}
