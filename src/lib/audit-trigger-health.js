/**
 * Audit composite, `audit_trigger_health`.
 *
 * Pure function over an instance's trigger corpus plus the supporting
 * resources (trigger categories, groups, ticket fields, ticket forms).
 * Layered on top of `TriggerAnalyzer.findConflicts` and the
 * usage-analyzer field-key conventions.
 *
 *   {
 *     conflicts:                 [...],   // pass-through of TriggerAnalyzer.findConflicts
 *     deactivated_but_referenced: [...],  // inactive triggers referenced by an active trigger's chain
 *     orphaned_references:       [...],   // triggers that point at a missing group/form/field/category
 *     ordering_anomalies:        [...],   // deactivated_with_low_position + duplicate_position
 *     empty_rules:               [...],   // triggers missing actions and/or conditions
 *   }
 *
 * No HTTP, no global state. The tool layer in
 * `src/tools-v1/audit-trigger-health.js` handles fetching the corpus,
 * cache, error tolerance (`upstream_error` per kind gets surfaced as a
 * `notes` entry), and envelope wrapping.
 */

import { findConflicts } from './trigger-analyzer.js';

const FIELD_PREFIX = 'custom_fields_';
const FIELD_KEY_RE = /^custom_fields_(\d+)$/;

const LOW_POSITION_THRESHOLD = 50;

function asArray(maybeItems) {
  if (!maybeItems) return [];
  if (Array.isArray(maybeItems)) return maybeItems;
  if (Array.isArray(maybeItems.items)) return maybeItems.items;
  return [];
}

function summary(trigger) {
  return {
    id: trigger.id,
    title: trigger.title ?? null,
    position: trigger.position ?? null,
  };
}

function sortById(rows, key = 'id') {
  return rows.slice().sort((a, b) => {
    const ai = Number(a[key]);
    const bi = Number(b[key]);
    if (Number.isFinite(ai) && Number.isFinite(bi) && ai !== bi) return ai - bi;
    return String(a[key]) < String(b[key]) ? -1 : 1;
  });
}

function buildIdSet(items) {
  const out = new Set();
  for (const item of items) {
    if (!item || item.id === undefined || item.id === null) continue;
    out.add(String(item.id));
  }
  return out;
}

/**
 * Walk a trigger's condition + action rows uniformly, calling `visit` with
 * each row plus a breadcrumb describing where it came from.
 */
function walkRows(trigger, visit) {
  const conditions = trigger.conditions && typeof trigger.conditions === 'object'
    ? trigger.conditions
    : {};
  for (const block of ['all', 'any']) {
    const rows = Array.isArray(conditions[block]) ? conditions[block] : [];
    rows.forEach((row, idx) => {
      if (!row || typeof row !== 'object') return;
      visit(row, `condition #${idx + 1} of ${block}-block`);
    });
  }
  const actions = Array.isArray(trigger.actions) ? trigger.actions : [];
  actions.forEach((row, idx) => {
    if (!row || typeof row !== 'object') return;
    visit(row, `action #${idx + 1}`);
  });
}

/* ------------------------ deactivated_but_referenced ------------------------ */
/**
 * Walk active triggers' actions for `{ field: "trigger_id", value: <id> }`
 * (Zendesk's chained-trigger pattern). For each match where the referenced
 * trigger is in our corpus AND has `active === false`, record it.
 */
function findDeactivatedButReferenced(triggers) {
  const byId = new Map();
  for (const t of triggers) {
    if (!t || t.id === undefined || t.id === null) continue;
    byId.set(String(t.id), t);
  }

  const inactiveRefs = new Map(); // referenced_id -> [{ id, title, why_matched }]
  for (const t of triggers) {
    if (!t || t.active === false) continue;
    const actions = Array.isArray(t.actions) ? t.actions : [];
    actions.forEach((row, idx) => {
      if (!row || typeof row !== 'object') return;
      if (row.field !== 'trigger_id') return;
      const refId = row.value == null ? '' : String(row.value);
      if (!refId) return;
      const target = byId.get(refId);
      if (!target) return;
      if (target.active !== false) return;
      if (!inactiveRefs.has(refId)) inactiveRefs.set(refId, []);
      inactiveRefs.get(refId).push({
        id: t.id,
        title: t.title ?? null,
        why_matched: `action #${idx + 1} chains trigger_id=${refId}`,
      });
    });
  }

  const out = [];
  for (const [refId, referenced_by] of inactiveRefs) {
    const target = byId.get(refId);
    out.push({
      id: target.id,
      title: target.title ?? null,
      position: target.position ?? null,
      referenced_by,
    });
  }
  return sortById(out, 'id');
}

/* ----------------------------- orphaned references ------------------------- */
function findOrphanedReferences(triggers, opts) {
  const { groupIds, formIds, fieldIds, categoryIds, haveGroups, haveForms, haveFields, haveCategories } = opts;
  const out = [];

  for (const t of triggers) {
    if (!t || typeof t !== 'object') continue;

    walkRows(t, (row, breadcrumb) => {
      const field = row.field;
      if (!field) return;

      // group_id
      if (haveGroups && field === 'group_id' && row.value != null && String(row.value) !== '') {
        if (!groupIds.has(String(row.value))) {
          out.push({
            trigger_id: t.id,
            trigger_title: t.title ?? null,
            position: t.position ?? null,
            missing_kind: 'group',
            missing_id: String(row.value),
            why_matched: `${breadcrumb} references group_id=${row.value}`,
          });
        }
      }

      // ticket_form_id
      if (haveForms && field === 'ticket_form_id' && row.value != null && String(row.value) !== '') {
        if (!formIds.has(String(row.value))) {
          out.push({
            trigger_id: t.id,
            trigger_title: t.title ?? null,
            position: t.position ?? null,
            missing_kind: 'ticket_form',
            missing_id: String(row.value),
            why_matched: `${breadcrumb} references ticket_form_id=${row.value}`,
          });
        }
      }

      // custom_fields_<id>
      if (haveFields && typeof field === 'string' && field.startsWith(FIELD_PREFIX)) {
        const m = FIELD_KEY_RE.exec(field);
        if (m) {
          const fid = m[1];
          if (!fieldIds.has(fid)) {
            out.push({
              trigger_id: t.id,
              trigger_title: t.title ?? null,
              position: t.position ?? null,
              missing_kind: 'ticket_field',
              missing_id: fid,
              why_matched: `${breadcrumb} references ${field}`,
            });
          }
        }
      }
    });

    // category_id is on the trigger itself, not in conditions/actions.
    if (haveCategories && t.category_id != null && String(t.category_id) !== '') {
      if (!categoryIds.has(String(t.category_id))) {
        out.push({
          trigger_id: t.id,
          trigger_title: t.title ?? null,
          position: t.position ?? null,
          missing_kind: 'trigger_category',
          missing_id: String(t.category_id),
          why_matched: `trigger.category_id=${t.category_id}`,
        });
      }
    }
  }

  return out.slice().sort((a, b) => {
    const ai = Number(a.trigger_id);
    const bi = Number(b.trigger_id);
    if (Number.isFinite(ai) && Number.isFinite(bi) && ai !== bi) return ai - bi;
    if (a.trigger_id !== b.trigger_id) {
      return String(a.trigger_id) < String(b.trigger_id) ? -1 : 1;
    }
    if (a.missing_kind !== b.missing_kind) {
      return a.missing_kind < b.missing_kind ? -1 : 1;
    }
    return String(a.missing_id) < String(b.missing_id) ? -1 : 1;
  });
}

/* -------------------------- ordering anomalies ----------------------------- */
function findOrderingAnomalies(triggers) {
  const out = [];

  // Bucket by position to detect duplicates (only for triggers with a numeric
  // position, null positions don't collide).
  const byPosition = new Map();
  for (const t of triggers) {
    if (!t || typeof t !== 'object') continue;
    if (t.position == null) continue;
    const key = String(t.position);
    if (!byPosition.has(key)) byPosition.set(key, []);
    byPosition.get(key).push(t);
  }
  for (const [pos, group] of byPosition) {
    if (group.length < 2) continue;
    for (const t of group) {
      out.push({
        id: t.id,
        title: t.title ?? null,
        position: t.position ?? null,
        anomaly: 'duplicate_position',
        note: `position ${pos} shared by ${group.length} triggers`,
      });
    }
  }

  for (const t of triggers) {
    if (!t || typeof t !== 'object') continue;
    if (t.active !== false) continue;
    if (typeof t.position !== 'number') continue;
    if (t.position >= LOW_POSITION_THRESHOLD) continue;
    out.push({
      id: t.id,
      title: t.title ?? null,
      position: t.position,
      anomaly: 'deactivated_with_low_position',
      note: `inactive trigger holds early slot (position ${t.position} < ${LOW_POSITION_THRESHOLD})`,
    });
  }

  return sortById(out, 'id');
}

/* ----------------------------- empty rules --------------------------------- */
function findEmptyRules(triggers) {
  const out = [];
  for (const t of triggers) {
    if (!t || typeof t !== 'object') continue;
    const actions = Array.isArray(t.actions) ? t.actions : [];
    const conds = t.conditions && typeof t.conditions === 'object' ? t.conditions : {};
    const allArr = Array.isArray(conds.all) ? conds.all : [];
    const anyArr = Array.isArray(conds.any) ? conds.any : [];

    const noActions = actions.length === 0;
    const noConditions = allArr.length === 0 && anyArr.length === 0;

    if (!noActions && !noConditions) continue;

    let missing;
    if (noActions && noConditions) missing = 'both';
    else if (noActions) missing = 'actions';
    else missing = 'conditions';

    out.push({
      id: t.id,
      title: t.title ?? null,
      position: t.position ?? null,
      missing,
    });
  }
  return sortById(out, 'id');
}

/**
 * @param {object} corpus
 *   - triggers: array (required to get any signal)
 *   - trigger_categories: array (optional, when omitted, category_id orphans
 *     are not flagged)
 *   - groups, ticket_fields, ticket_forms: arrays (same tolerance)
 *   Each may also be the `{ items: [...] }` envelope shape.
 * @returns {{
 *   conflicts: Array,
 *   deactivated_but_referenced: Array,
 *   orphaned_references: Array,
 *   ordering_anomalies: Array,
 *   empty_rules: Array,
 * }}
 */
export function auditTriggerHealth(corpus = {}) {
  const triggers = asArray(corpus.triggers);

  // Whether each supporting kind was supplied, when not supplied we skip
  // that orphan check entirely (per-kind upstream tolerance lives at the
  // tool layer, but the composite needs to know the difference between
  // "empty corpus" and "this kind wasn't provided").
  const haveGroups = corpus.groups !== undefined;
  const haveForms = corpus.ticket_forms !== undefined;
  const haveFields = corpus.ticket_fields !== undefined;
  const haveCategories = corpus.trigger_categories !== undefined;

  const groupIds = buildIdSet(asArray(corpus.groups));
  const formIds = buildIdSet(asArray(corpus.ticket_forms));
  const fieldIds = buildIdSet(asArray(corpus.ticket_fields));
  const categoryIds = buildIdSet(asArray(corpus.trigger_categories));

  return {
    conflicts: findConflicts(triggers),
    deactivated_but_referenced: findDeactivatedButReferenced(triggers),
    orphaned_references: findOrphanedReferences(triggers, {
      groupIds,
      formIds,
      fieldIds,
      categoryIds,
      haveGroups,
      haveForms,
      haveFields,
      haveCategories,
    }),
    ordering_anomalies: findOrderingAnomalies(triggers),
    empty_rules: findEmptyRules(triggers),
  };
}

export const AuditComposites = { triggerHealth: auditTriggerHealth };
