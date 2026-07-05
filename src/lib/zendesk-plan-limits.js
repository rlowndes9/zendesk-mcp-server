/**
 * Zendesk Suite per-plan rate limits, by endpoint category.
 *
 * Source: https://developer.zendesk.com/api-reference/introduction/rate-limits/
 *
 * Numbers below reflect the documented Suite plan limits as of authoring.
 * Zendesk does change them, re-check the page above when onboarding a new
 * plan tier or if you start seeing unexpected 429s on an instance whose
 * plan you've configured here.
 *
 * Categories:
 *   - default: most endpoints (tickets, users, organizations, triggers,
 *     macros, views, etc.) share the account-wide per-minute budget.
 *   - search: GET /api/v2/search.json is *much* stricter, especially on
 *     small plans. A naive audit fan-out that includes a search call will
 *     trip 429s here long before the overall budget.
 *   - incremental: incremental export endpoints (`/incremental/*`) have
 *     their own per-minute caps, plus a max-frequency rule that cursors
 *     can only advance every ~5 seconds.
 *
 * The MCP throttles itself to a fraction of these numbers (default 25%) so
 * the client's own staff and integrations have headroom. See
 * RATE_LIMIT_USAGE_FRACTION in zendesk-client-factory.js.
 */
export const PLAN_LIMITS = {
  team: {
    overall_per_min: 200,
    search_per_min: 10,
    incremental_per_min: 10,
  },
  growth: {
    overall_per_min: 400,
    search_per_min: 100,
    incremental_per_min: 10,
  },
  professional: {
    overall_per_min: 700,
    search_per_min: 100,
    incremental_per_min: 10,
  },
  enterprise: {
    overall_per_min: 700,
    search_per_min: 100,
    incremental_per_min: 10,
  },
  enterprise_plus: {
    overall_per_min: 2500,
    search_per_min: 100,
    incremental_per_min: 10,
  },
};

/**
 * The set of plan names accepted in instances.json. Case-insensitive,
 * spaces / hyphens normalised to underscores at validation time.
 */
export const PLAN_NAMES = Object.keys(PLAN_LIMITS);

/**
 * Normalise a user-provided plan string to one of PLAN_NAMES. Returns
 * null if it doesn't match. Accepts forms like "Enterprise Plus",
 * "enterprise-plus", "ENTERPRISE_PLUS".
 */
export function normalisePlanName(input) {
  if (typeof input !== 'string') return null;
  const slug = input.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return PLAN_NAMES.includes(slug) ? slug : null;
}

/**
 * Classify a Zendesk request path into a rate-limit category. Path is the
 * portion after `/api/v2`, e.g. `/triggers.json` or `/search.json`.
 *
 * Conservative: if a path doesn't match a known stricter category, falls
 * through to `default`, i.e. we don't *under*-throttle anything.
 */
export function categoriseEndpoint(path) {
  if (typeof path !== 'string') return 'default';
  // Strip leading slash for easier matching.
  const p = path.startsWith('/') ? path.slice(1) : path;
  if (p.startsWith('search') || p.startsWith('search.json')) return 'search';
  if (p.startsWith('incremental/')) return 'incremental';
  return 'default';
}
