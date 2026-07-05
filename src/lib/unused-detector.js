/**
 * UnusedDetector, flags unused macros and views using Zendesk's
 * usage_24h / usage_7d / usage_30d fields exposed on the standard
 * list/get endpoints when verbose payloads are requested.
 *
 * Triggers and automations always return `"indeterminate"` with a
 * reason, Zendesk does not reliably expose firing/usage stats for
 * those primitives on standard plans, and using `updated_at` as a
 * usage proxy gives false confidence ("safe to delete" when it is
 * not). This is intentional and is documented in PRD.md user
 * stories 24 and 25.
 *
 * Pure module: `detect(kind, items, opts?)` takes the items array
 * (already fetched, verbose payloads) and returns a verdict array.
 * The tool wiring layer in `src/tools-v1/unused.js` handles fetching
 * and envelope wrapping.
 */

const USAGE_FIELDS = ['usage_24h', 'usage_7d', 'usage_30d'];

const INDETERMINATE_REASONS = {
  triggers: 'trigger firing data not available via API on standard plans',
  automations:
    'automation firing data not available via API on standard plans',
};

const SUPPORTED_KINDS = new Set([
  'macros',
  'views',
  'triggers',
  'automations',
]);

function pickTitle(item) {
  // Macros/views/triggers/automations all use `title`, but be defensive.
  return item?.title ?? item?.name ?? null;
}

function detectStatsBased(item) {
  const id = item?.id ?? null;
  const title = pickTitle(item);
  const usage_30d = item?.usage_30d;
  const usage_7d = item?.usage_7d;
  const usage_24h = item?.usage_24h;

  // If none of the usage fields are present on the payload, we cannot
  // be confident, surface that as indeterminate rather than guessing.
  const haveAny = USAGE_FIELDS.some(
    (f) => Object.prototype.hasOwnProperty.call(item || {}, f),
  );
  if (!haveAny) {
    return {
      id,
      title,
      status: 'indeterminate',
      reason:
        'usage_24h/usage_7d/usage_30d not present on payload (request verbose: true)',
    };
  }

  const isZero = (v) => v === 0 || v === null || v === undefined;
  const allZero = isZero(usage_24h) && isZero(usage_7d) && isZero(usage_30d);
  const thirtyZero = usage_30d === 0;

  const out = {
    id,
    title,
    status: thirtyZero || allZero ? 'unused' : 'used',
  };
  if (typeof usage_30d === 'number') out.usage_30d = usage_30d;

  // last_used_at is best-effort, Zendesk does not consistently expose
  // this, so only include it when we actually have a value.
  if (item?.last_used_at) out.last_used_at = item.last_used_at;

  return out;
}

function detectIndeterminate(item, kind) {
  return {
    id: item?.id ?? null,
    title: pickTitle(item),
    status: 'indeterminate',
    reason: INDETERMINATE_REASONS[kind],
  };
}

/**
 * @param {"macros"|"views"|"triggers"|"automations"} kind
 * @param {Array<object>} items
 * @param {object} [opts], reserved for future tuning; unused today.
 * @returns {Array<{id, title, status: "unused"|"used"|"indeterminate",
 *                  last_used_at?: string, usage_30d?: number, reason?: string}>}
 */
export function detect(kind, items, _opts = {}) {
  if (!SUPPORTED_KINDS.has(kind)) {
    throw new Error(`UnusedDetector: unsupported kind "${kind}"`);
  }
  if (!Array.isArray(items)) return [];

  if (kind === 'triggers' || kind === 'automations') {
    return items.map((item) => detectIndeterminate(item, kind));
  }
  // macros, views
  return items.map(detectStatsBased);
}

export const UnusedDetector = { detect };
