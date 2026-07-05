import { RateLimitedHttpClient } from './rate-limited-http-client.js';
import { PLAN_LIMITS } from './zendesk-plan-limits.js';

/**
 * Produces and caches per-instance HTTP clients. One client per instance for
 * the process lifetime, Zendesk's rate limit is per-subdomain, so the
 * concurrency semaphore lives on the client and is naturally per-instance.
 */
export class ZendeskClientFactory {
  constructor({ configStore, httpClientFactory } = {}) {
    if (!configStore) {
      throw new Error('ZendeskClientFactory: configStore required');
    }
    this._configStore = configStore;
    this._cache = new Map();
    // Allow tests to inject a fake client builder.
    this._build = httpClientFactory || defaultHttpClientFactory;
  }

  /**
   * Returns the per-instance client. Throws if the instance is unknown
   * (the tool layer should resolve via InstanceSession first; we still guard
   * here for defense in depth).
   */
  /**
   * Drop the cached HTTP client for one instance (or all instances). The next
   * getClient() call rebuilds from the current configStore, picks up edits
   * to instances.json (rotated tokens, fixed creds) without a process restart.
   */
  invalidate(instanceName) {
    if (instanceName) this._cache.delete(instanceName);
    else this._cache.clear();
  }

  getClient(instanceName) {
    if (!instanceName) {
      const err = new Error(
        'ZendeskClientFactory: instance name required',
      );
      err.code = 'instance_unknown';
      throw err;
    }
    const cached = this._cache.get(instanceName);
    if (cached) return cached;
    const entry = this._configStore.getInstance(instanceName);
    if (!entry) {
      const available = this._configStore
        .listInstances()
        .map((i) => i.name)
        .join(', ');
      const err = new Error(
        `Unknown instance "${instanceName}". Available: ${available || '(none configured)'}`,
      );
      err.code = 'instance_unknown';
      throw err;
    }
    const client = this._build({ name: instanceName, entry });
    this._cache.set(instanceName, client);
    return client;
  }
}

/**
 * Fraction of an instance's plan rate limit we consume, leaves headroom for
 * the user's other tooling, the agent UI's own calls, and bursty fan-outs.
 */
const RATE_LIMIT_USAGE_FRACTION = 0.25;

function defaultHttpClientFactory({ entry }) {
  const baseUrl = `https://${entry.subdomain}.zendesk.com/api/v2`;
  const auth = { username: `${entry.email}/token`, password: entry.token };

  // Prefer plan-based per-category throttling. Plan was normalised to
  // a key in PLAN_LIMITS by InstanceConfigStore. If a plan and a legacy
  // rate_limit_per_min are both set, plan wins.
  if (entry.plan && PLAN_LIMITS[entry.plan]) {
    const limits = PLAN_LIMITS[entry.plan];
    const targetRatesByCategory = {
      default: limits.overall_per_min * RATE_LIMIT_USAGE_FRACTION,
      search: limits.search_per_min * RATE_LIMIT_USAGE_FRACTION,
      incremental: limits.incremental_per_min * RATE_LIMIT_USAGE_FRACTION,
    };
    return new RateLimitedHttpClient({
      baseUrl,
      auth,
      targetRatesByCategory,
    });
  }

  // Legacy single-bucket mode (rate_limit_per_min). All endpoint
  // categories share one budget, coarse, but better than nothing.
  const targetRatePerMin =
    Number.isFinite(entry.rate_limit_per_min) && entry.rate_limit_per_min > 0
      ? entry.rate_limit_per_min * RATE_LIMIT_USAGE_FRACTION
      : undefined;
  return new RateLimitedHttpClient({
    baseUrl,
    auth,
    targetRatePerMin,
  });
}
