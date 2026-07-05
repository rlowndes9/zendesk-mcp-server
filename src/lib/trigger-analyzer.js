/**
 * TriggerAnalyzer, pure functions over a fetched corpus of triggers.
 *
 * No HTTP, no global state, no side effects. The MCP tools layer
 * (src/tools-v1/trigger-analysis.js) wraps these with the cached
 * list_triggers(verbose: true) result.
 *
 * Zendesk trigger object shape:
 *   {
 *     id, title, active, position,
 *     conditions: { all: [{field, operator, value}], any: [...] },
 *     actions:    [{field, value}]
 *   }
 *
 * Tag-related actions:
 *   { field: "current_tags", value: "vip pending" }, adds tags (space-separated)
 *   { field: "set_tags",     value: "vip" }       , replaces all tags (rare)
 *   { field: "remove_tags",  value: "stale" }     , removes tags
 *
 * Tag-related conditions:
 *   { field: "current_tags", operator: "includes"|"not_includes", value: "vip" }
 *
 * All matches are sorted by trigger.position ascending (lower = fires first).
 * Deactivated triggers (active: false) are still scanned by default and tagged
 * with `[inactive]` in their `why_matched` breadcrumb so cleanup audits can
 * surface dead rules referencing fields/tags.
 */

const TAG_SET_FIELDS = new Set(['current_tags', 'set_tags']);
const TAG_REMOVE_FIELDS = new Set(['remove_tags']);
const TAG_CONDITION_FIELDS = new Set(['current_tags']);

function splitTagValue(value) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((v) => splitTagValue(v));
  }
  return String(value)
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function inactiveSuffix(trigger) {
  return trigger && trigger.active === false ? ' [inactive]' : '';
}

function makeMatch(trigger, why_matched) {
  return {
    id: trigger.id,
    title: trigger.title,
    position: trigger.position,
    why_matched,
  };
}

function sortByPosition(matches) {
  return matches.sort((a, b) => {
    const ap = a.position == null ? Number.POSITIVE_INFINITY : a.position;
    const bp = b.position == null ? Number.POSITIVE_INFINITY : b.position;
    return ap - bp;
  });
}

function actionFieldLabel(field) {
  if (TAG_SET_FIELDS.has(field)) return field === 'set_tags' ? 'replace-sets' : 'sets';
  if (TAG_REMOVE_FIELDS.has(field)) return 'removes';
  return field;
}

/**
 * Find triggers that touch a given tag.
 *
 * @param {Array} triggers - corpus from list_triggers(verbose: true)
 * @param {string} tag - exact tag to look for
 * @param {"sets"|"removes"|"condition"|"any"} mode
 * @returns {Array<{id, title, position, why_matched}>}
 */
export function findByTag(triggers, tag, mode = 'any') {
  if (!Array.isArray(triggers)) {
    throw new TypeError('findByTag: triggers must be an array');
  }
  if (typeof tag !== 'string' || tag.length === 0) {
    throw new TypeError('findByTag: tag must be a non-empty string');
  }
  const validModes = new Set(['sets', 'removes', 'condition', 'any']);
  if (!validModes.has(mode)) {
    throw new TypeError(
      `findByTag: mode must be one of ${[...validModes].join(', ')} (got "${mode}")`,
    );
  }

  const matches = [];
  const wantSets = mode === 'sets' || mode === 'any';
  const wantRemoves = mode === 'removes' || mode === 'any';
  const wantCondition = mode === 'condition' || mode === 'any';

  for (const trig of triggers) {
    if (!trig || typeof trig !== 'object') continue;
    const suffix = inactiveSuffix(trig);

    // Actions, tag-set / tag-remove.
    const actions = Array.isArray(trig.actions) ? trig.actions : [];
    actions.forEach((action, idx) => {
      if (!action || typeof action !== 'object') return;
      const tags = splitTagValue(action.value);
      if (!tags.includes(tag)) return;
      const isSet = TAG_SET_FIELDS.has(action.field);
      const isRemove = TAG_REMOVE_FIELDS.has(action.field);
      if (isSet && wantSets) {
        const verb = actionFieldLabel(action.field);
        matches.push(
          makeMatch(
            trig,
            `${verb} tag '${tag}' in action #${idx + 1}${suffix}`,
          ),
        );
      } else if (isRemove && wantRemoves) {
        matches.push(
          makeMatch(
            trig,
            `removes tag '${tag}' in action #${idx + 1}${suffix}`,
          ),
        );
      }
    });

    // Conditions, current_tags includes / not_includes.
    if (wantCondition && trig.conditions && typeof trig.conditions === 'object') {
      for (const block of ['all', 'any']) {
        const conds = Array.isArray(trig.conditions[block])
          ? trig.conditions[block]
          : [];
        conds.forEach((cond, idx) => {
          if (!cond || typeof cond !== 'object') return;
          if (!TAG_CONDITION_FIELDS.has(cond.field)) return;
          const tags = splitTagValue(cond.value);
          if (!tags.includes(tag)) return;
          const op = cond.operator || 'includes';
          matches.push(
            makeMatch(
              trig,
              `condition checks tag '${tag}' (${op}) in condition #${idx + 1} of ${block}-block${suffix}`,
            ),
          );
        });
      }
    }
  }

  return sortByPosition(matches);
}

/**
 * Find triggers that reference a given field anywhere, conditions or actions.
 * Optionally narrowed by an exact value match.
 *
 * Value comparison is loose: numeric-vs-string equivalence is handled
 * (e.g. searching for value=42 will match value:"42" and vice versa).
 *
 * @param {Array} triggers - corpus from list_triggers(verbose: true)
 * @param {string} field - field name (e.g. "form_id", "status", "group_id")
 * @param {string|number} [value] - optional value filter
 * @returns {Array<{id, title, position, why_matched}>}
 */
export function findByField(triggers, field, value) {
  if (!Array.isArray(triggers)) {
    throw new TypeError('findByField: triggers must be an array');
  }
  if (typeof field !== 'string' || field.length === 0) {
    throw new TypeError('findByField: field must be a non-empty string');
  }

  const hasValueFilter = value !== undefined && value !== null;
  const valueStr = hasValueFilter ? String(value) : null;

  const valueMatches = (candidate) => {
    if (!hasValueFilter) return true;
    if (candidate == null) return false;
    if (Array.isArray(candidate)) {
      return candidate.some((v) => valueMatches(v));
    }
    return String(candidate) === valueStr;
  };

  const renderValue = (v) => {
    if (Array.isArray(v)) return JSON.stringify(v);
    if (v == null) return '(empty)';
    return String(v);
  };

  const matches = [];

  for (const trig of triggers) {
    if (!trig || typeof trig !== 'object') continue;
    const suffix = inactiveSuffix(trig);

    // Conditions block.
    if (trig.conditions && typeof trig.conditions === 'object') {
      for (const block of ['all', 'any']) {
        const conds = Array.isArray(trig.conditions[block])
          ? trig.conditions[block]
          : [];
        conds.forEach((cond, idx) => {
          if (!cond || typeof cond !== 'object') return;
          if (cond.field !== field) return;
          if (!valueMatches(cond.value)) return;
          const valuePart = hasValueFilter
            ? `=${renderValue(cond.value)}`
            : '';
          matches.push(
            makeMatch(
              trig,
              `references ${field}${valuePart} in condition #${idx + 1} of ${block}-block${suffix}`,
            ),
          );
        });
      }
    }

    // Actions list.
    const actions = Array.isArray(trig.actions) ? trig.actions : [];
    actions.forEach((action, idx) => {
      if (!action || typeof action !== 'object') return;
      if (action.field !== field) return;
      if (!valueMatches(action.value)) return;
      const valuePart = hasValueFilter
        ? `=${renderValue(action.value)}`
        : '';
      matches.push(
        makeMatch(
          trig,
          `references ${field}${valuePart} in action #${idx + 1}${suffix}`,
        ),
      );
    });
  }

  return sortByPosition(matches);
}

/**
 * Find pairs of triggers that conflict.
 *
 * A conflict requires BOTH:
 *   1. Their `all`-block condition signatures overlap. Each `all`-block
 *      condition is a `(field, operator, value)` tuple. Two triggers overlap
 *      if their `all`-block sets intersect, i.e. the same exact tuple appears
 *      in both. This conservative definition is intentional: it avoids
 *      false-positive noise from semantic operator equivalence (`is` vs `=`)
 *      while still catching the common consultancy case of two rules built
 *      against the same gating clause. We do NOT flag one-sided overlaps
 *      where one trigger's all-block is a strict superset of the other's
 *      with no shared tuple, those are usually intentional refinements.
 *      (User-call: strict superset relations are NOT flagged.)
 *   2. They both write to the same target field with different values, OR
 *      one sets a tag and the other removes the same tag.
 *
 * Two sub-classes of conflict:
 *   - `field_overwrite`: both triggers have an action on the same `field`
 *     with different values (e.g. trigger A sets status=open, B sets
 *     status=pending; same all-block precondition).
 *   - `tag_set_remove_pair`: trigger A sets tag X via `current_tags` /
 *     `set_tags`, trigger B removes tag X via `remove_tags`.
 *
 * Results are canonically ordered: the lower-positioned trigger is
 * `trigger_a`. The full result list sorts ascending by `trigger_a.position`
 * (firing order), with `id` ascending as the tiebreaker.
 *
 * Inactive triggers are typically excluded by the caller (the tool sets
 * `include_inactive: false` by default). When fed inactive triggers, this
 * function still scans them, filtering is the caller's job.
 *
 * @param {Array} triggers - corpus from list_triggers(verbose: true)
 * @param {number|string} [target_id] - if provided, only return conflicts
 *                                      involving that trigger
 * @returns {Array<{
 *   trigger_a: {id, title, position},
 *   trigger_b: {id, title, position},
 *   conflict_type: "field_overwrite"|"tag_set_remove_pair",
 *   why_matched: string,
 * }>}
 */
export function findConflicts(triggers, target_id) {
  if (!Array.isArray(triggers)) {
    throw new TypeError('findConflicts: triggers must be an array');
  }

  const hasTarget = target_id !== undefined && target_id !== null;
  const targetStr = hasTarget ? String(target_id) : null;

  // Normalize each trigger once.
  const norm = [];
  for (const t of triggers) {
    if (!t || typeof t !== 'object') continue;
    const allConds = Array.isArray(t.conditions?.all) ? t.conditions.all : [];
    const sigSet = new Set();
    const sigByKey = new Map();
    for (const c of allConds) {
      if (!c || typeof c !== 'object') continue;
      const field = c.field == null ? '' : String(c.field);
      const op = c.operator == null ? '' : String(c.operator);
      const val = c.value == null ? '' : String(c.value);
      if (!field) continue;
      const key = `${field}\u0000${op}\u0000${val}`;
      sigSet.add(key);
      sigByKey.set(key, { field, operator: op, value: val });
    }
    const actions = Array.isArray(t.actions) ? t.actions : [];
    norm.push({ trig: t, sigSet, sigByKey, actions });
  }

  const results = [];

  for (let i = 0; i < norm.length; i++) {
    for (let j = i + 1; j < norm.length; j++) {
      const A = norm[i];
      const B = norm[j];
      if (
        hasTarget &&
        String(A.trig.id) !== targetStr &&
        String(B.trig.id) !== targetStr
      ) {
        continue;
      }

      // Compute condition signature overlap (intersection of sigSet).
      let sharedKey = null;
      for (const k of A.sigSet) {
        if (B.sigSet.has(k)) {
          sharedKey = k;
          break;
        }
      }
      if (!sharedKey) continue;
      const sharedCond = A.sigByKey.get(sharedKey);
      const condFragment = `(${sharedCond.field} ${sharedCond.operator || '='} '${sharedCond.value}')`;

      // Detect conflicts by walking actions.
      const conflicts = collectActionConflicts(A, B, sharedCond, condFragment);
      for (const c of conflicts) {
        results.push(canonicalizePair(A.trig, B.trig, c));
      }
    }
  }

  results.sort((x, y) => {
    const xa = x.trigger_a.position == null ? Number.POSITIVE_INFINITY : x.trigger_a.position;
    const ya = y.trigger_a.position == null ? Number.POSITIVE_INFINITY : y.trigger_a.position;
    if (xa !== ya) return xa - ya;
    const xb = x.trigger_b.position == null ? Number.POSITIVE_INFINITY : x.trigger_b.position;
    const yb = y.trigger_b.position == null ? Number.POSITIVE_INFINITY : y.trigger_b.position;
    if (xb !== yb) return xb - yb;
    if (x.trigger_a.id !== y.trigger_a.id) {
      return x.trigger_a.id < y.trigger_a.id ? -1 : 1;
    }
    if (x.trigger_b.id !== y.trigger_b.id) {
      return x.trigger_b.id < y.trigger_b.id ? -1 : 1;
    }
    return 0;
  });

  return results;
}

/**
 * Walk both triggers' action lists and emit conflict descriptors keyed off
 * shared signature `condFragment`. Returns an array of intermediate records
 * that `canonicalizePair` will turn into the final {trigger_a, trigger_b, ...}.
 */
function collectActionConflicts(A, B, sharedCond, condFragment) {
  const out = [];

  // ---- field_overwrite: same non-tag field, different values --------------
  // Collect actions per field per trigger (preserve indices for breadcrumb).
  const groupByField = (actions) => {
    const m = new Map();
    actions.forEach((act, idx) => {
      if (!act || typeof act !== 'object') return;
      const field = act.field;
      if (!field) return;
      if (TAG_SET_FIELDS.has(field) || TAG_REMOVE_FIELDS.has(field)) return;
      if (!m.has(field)) m.set(field, []);
      m.get(field).push({ idx, value: act.value });
    });
    return m;
  };
  const aByField = groupByField(A.actions);
  const bByField = groupByField(B.actions);
  for (const [field, aEntries] of aByField) {
    const bEntries = bByField.get(field);
    if (!bEntries) continue;
    for (const ae of aEntries) {
      for (const be of bEntries) {
        if (sameValue(ae.value, be.value)) continue;
        out.push({
          conflict_type: 'field_overwrite',
          // Description is filled in canonical pair so A/B labels match
          // the canonical (lower-position) ordering.
          describe: (lower, higher, lowerLabel, higherLabel) => {
            // Determine which entry came from which trigger by comparing
            // actual trigger IDs.
            const aIsLower = lower.id === A.trig.id;
            const lowEntry = aIsLower ? ae : be;
            const highEntry = aIsLower ? be : ae;
            return (
              `both have all-block condition ${condFragment}; ` +
              `${lowerLabel} sets ${field}=${renderVal(lowEntry.value)} in action #${lowEntry.idx + 1}, ` +
              `${higherLabel} sets ${field}=${renderVal(highEntry.value)} in action #${highEntry.idx + 1}`
            );
          },
        });
      }
    }
  }

  // ---- tag_set_remove_pair: A sets tag X, B removes tag X (or vice versa) -
  const collectTags = (actions) => {
    const sets = new Map(); // tag -> [{idx, fieldUsed}]
    const removes = new Map();
    actions.forEach((act, idx) => {
      if (!act || typeof act !== 'object') return;
      if (!act.field) return;
      if (TAG_SET_FIELDS.has(act.field)) {
        for (const tag of splitTagValue(act.value)) {
          if (!sets.has(tag)) sets.set(tag, []);
          sets.get(tag).push({ idx, fieldUsed: act.field });
        }
      } else if (TAG_REMOVE_FIELDS.has(act.field)) {
        for (const tag of splitTagValue(act.value)) {
          if (!removes.has(tag)) removes.set(tag, []);
          removes.get(tag).push({ idx, fieldUsed: act.field });
        }
      }
    });
    return { sets, removes };
  };
  const aTags = collectTags(A.actions);
  const bTags = collectTags(B.actions);

  // A sets, B removes
  for (const [tag, aEntries] of aTags.sets) {
    const bEntries = bTags.removes.get(tag);
    if (!bEntries) continue;
    for (const ae of aEntries) {
      for (const be of bEntries) {
        out.push({
          conflict_type: 'tag_set_remove_pair',
          describe: (lower, higher, lowerLabel, higherLabel) => {
            const aIsLower = lower.id === A.trig.id;
            const lowAction = aIsLower ? `sets tag '${tag}'` : `removes tag '${tag}'`;
            const highAction = aIsLower ? `removes tag '${tag}'` : `sets tag '${tag}'`;
            const lowIdx = (aIsLower ? ae.idx : be.idx) + 1;
            const highIdx = (aIsLower ? be.idx : ae.idx) + 1;
            return (
              `both have all-block condition ${condFragment}; ` +
              `${lowerLabel} ${lowAction} in action #${lowIdx}, ` +
              `${higherLabel} ${highAction} in action #${highIdx}`
            );
          },
        });
      }
    }
  }
  // B sets, A removes
  for (const [tag, bEntries] of bTags.sets) {
    const aEntries = aTags.removes.get(tag);
    if (!aEntries) continue;
    for (const be of bEntries) {
      for (const ae of aEntries) {
        out.push({
          conflict_type: 'tag_set_remove_pair',
          describe: (lower, higher, lowerLabel, higherLabel) => {
            const aIsLower = lower.id === A.trig.id;
            // A removes, B sets, so:
            //   if A is lower: lower removes, higher sets
            //   else (B is lower): lower sets, higher removes
            const lowAction = aIsLower ? `removes tag '${tag}'` : `sets tag '${tag}'`;
            const highAction = aIsLower ? `sets tag '${tag}'` : `removes tag '${tag}'`;
            const lowIdx = (aIsLower ? ae.idx : be.idx) + 1;
            const highIdx = (aIsLower ? be.idx : ae.idx) + 1;
            return (
              `both have all-block condition ${condFragment}; ` +
              `${lowerLabel} ${lowAction} in action #${lowIdx}, ` +
              `${higherLabel} ${highAction} in action #${highIdx}`
            );
          },
        });
      }
    }
  }

  return out;
}

function sameValue(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

function renderVal(v) {
  if (v == null) return '(empty)';
  if (Array.isArray(v)) return JSON.stringify(v);
  return `'${String(v)}'`;
}

function inactiveTag(t) {
  return t && t.active === false ? ' [inactive]' : '';
}

function canonicalizePair(triggerA, triggerB, conflict) {
  const aPos = triggerA.position == null ? Number.POSITIVE_INFINITY : triggerA.position;
  const bPos = triggerB.position == null ? Number.POSITIVE_INFINITY : triggerB.position;
  let lower;
  let higher;
  if (aPos < bPos || (aPos === bPos && triggerA.id <= triggerB.id)) {
    lower = triggerA;
    higher = triggerB;
  } else {
    lower = triggerB;
    higher = triggerA;
  }
  const lowerLabel = `A${inactiveTag(lower)}`;
  const higherLabel = `B${inactiveTag(higher)}`;
  return {
    trigger_a: { id: lower.id, title: lower.title, position: lower.position },
    trigger_b: { id: higher.id, title: higher.title, position: higher.position },
    conflict_type: conflict.conflict_type,
    why_matched: conflict.describe(lower, higher, lowerLabel, higherLabel),
  };
}

export const TriggerAnalyzer = { findByTag, findByField, findConflicts };
