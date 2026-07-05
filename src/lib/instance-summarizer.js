/**
 * Pure summarizer for the `summarize_instance` composite tool.
 *
 * `summarize(corpus)` consumes whichever resource lists are available on the
 * caller's plan and returns a structured dashboard:
 *
 *   {
 *     counts: { triggers: { total, active, inactive }, ... },
 *     headlines: {
 *       oldest_trigger_updated_at,
 *       newest_trigger_updated_at,
 *       biggest_trigger_category: { category_id, name?, count },
 *       deactivated_but_positioned_triggers: { count, ids },
 *     },
 *   }
 *
 * Missing kinds are silently omitted. The tool layer attaches `instance` and
 * a `notes` array describing kinds that returned `upstream_error` from the
 * upstream Zendesk API.
 */

const ACTIVE_AWARE_KINDS = new Set([
  'triggers',
  'automations',
  'macros',
  'views',
  'ticket_fields',
  'ticket_forms',
  'custom_statuses',
  'webhooks',
  'targets',
  'organization_fields',
  'user_fields',
]);

// Kinds reported as plain { total } only (no active flag in the upstream schema).
const TOTAL_ONLY_KINDS = new Set([
  'groups',
  'custom_roles',
  'schedules',
  'sla_policies',
  'locales',
  'dynamic_content',
  'trigger_categories',
  'routing_attributes',
]);

function asArray(maybeItems) {
  if (!maybeItems) return null;
  if (Array.isArray(maybeItems)) return maybeItems;
  // Tolerate the list-call envelope shape too: { count, items, ... }
  if (Array.isArray(maybeItems.items)) return maybeItems.items;
  return null;
}

function activeSplit(items) {
  let active = 0;
  let inactive = 0;
  for (const it of items) {
    if (it && it.active === true) active += 1;
    else if (it && it.active === false) inactive += 1;
    // items without an `active` field don't contribute to either bucket
  }
  return { total: items.length, active, inactive };
}

function brandsCounts(items) {
  let active = 0;
  let inactive = 0;
  let defaultCount = 0;
  for (const it of items) {
    if (it?.active === true) active += 1;
    else if (it?.active === false) inactive += 1;
    if (it?.default === true) defaultCount += 1;
  }
  return { total: items.length, active, inactive, default: defaultCount };
}

function triggerHeadlines(triggers, triggerCategories) {
  const headlines = {};

  const updatedAts = triggers
    .map((t) => t?.updated_at)
    .filter((s) => typeof s === 'string' && s.length > 0)
    .sort();

  if (updatedAts.length > 0) {
    headlines.oldest_trigger_updated_at = updatedAts[0];
    headlines.newest_trigger_updated_at = updatedAts[updatedAts.length - 1];
  } else {
    headlines.oldest_trigger_updated_at = null;
    headlines.newest_trigger_updated_at = null;
  }

  // biggest_trigger_category
  const byCat = new Map();
  for (const t of triggers) {
    const cid = t?.category_id;
    if (cid === undefined || cid === null) continue;
    byCat.set(cid, (byCat.get(cid) || 0) + 1);
  }
  if (byCat.size > 0) {
    let bestId = null;
    let bestCount = -1;
    for (const [cid, count] of byCat) {
      if (count > bestCount) {
        bestId = cid;
        bestCount = count;
      }
    }
    const entry = { category_id: bestId, count: bestCount };
    if (Array.isArray(triggerCategories)) {
      const match = triggerCategories.find(
        (c) => c && (c.id === bestId || String(c.id) === String(bestId)),
      );
      if (match && match.name) entry.name = match.name;
    }
    headlines.biggest_trigger_category = entry;
  } else {
    headlines.biggest_trigger_category = null;
  }

  // deactivated_but_positioned_triggers, common cleanup target
  const dbp = triggers.filter(
    (t) => t && t.active === false && t.position !== null && t.position !== undefined,
  );
  headlines.deactivated_but_positioned_triggers = {
    count: dbp.length,
    ids: dbp.map((t) => t.id).filter((id) => id !== undefined && id !== null),
  };

  return headlines;
}

export function summarize(corpus = {}) {
  const counts = {};

  for (const kind of ACTIVE_AWARE_KINDS) {
    const items = asArray(corpus[kind]);
    if (items === null) continue;
    counts[kind] = activeSplit(items);
  }

  for (const kind of TOTAL_ONLY_KINDS) {
    const items = asArray(corpus[kind]);
    if (items === null) continue;
    counts[kind] = { total: items.length };
  }

  // brands has both `active` and `default`, special-case it.
  const brands = asArray(corpus.brands);
  if (brands !== null) {
    counts.brands = brandsCounts(brands);
  }

  const headlines = {};
  const triggers = asArray(corpus.triggers);
  if (triggers !== null) {
    Object.assign(headlines, triggerHeadlines(triggers, asArray(corpus.trigger_categories)));
  }

  return { counts, headlines };
}
