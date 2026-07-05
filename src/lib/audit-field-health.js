/**
 * Audit composite, `audit_field_health`.
 *
 * Pure function over an instance corpus. Layered on top of `UsageAnalyzer`
 * and the ticket-field/form primitives. Surfaces four classes of
 * field-health findings consultants typically chase before recommending
 * field deletions:
 *
 *   {
 *     unused_fields:        [{ field_id, key, title }, ...],
 *     inactive_only_fields: [{ field_id, key, title,
 *                              references_in_inactive_rules: [{ kind, id }] }, ...],
 *     empty_option_lists:   [{ field_id, key, title, type }, ...],
 *     not_in_active_form:   [{ field_id, key, title }, ...],
 *   }
 *
 * No HTTP, no global state. The tool layer in `src/tools-v1/audit-field-health.js`
 * handles fetching the corpus, cache, error tolerance (`upstream_error` per kind
 * gets surfaced as a `notes` entry), and envelope wrapping.
 *
 * System-field skip rule
 * ----------------------
 * Zendesk's built-in fields (Subject, Description, Status, Priority, Type,
 * Assignee, Group, Requester, etc.) are not custom fields and so cannot be
 * "unused" or have empty option lists in any meaningful sense. We skip a
 * ticket field when:
 *   - it has no `key` (built-ins ship without a custom key), OR
 *   - its `type` is in SYSTEM_TYPES below.
 */

import { findFieldUsage } from './usage-analyzer.js';

const SYSTEM_TYPES = new Set([
  'subject',
  'description',
  'status',
  'priority',
  'type',
  'tickettype',
  'assignee',
  'group',
  'channel',
  'requester',
  'ccs',
]);

const OPTION_LIST_TYPES = new Set(['tagger', 'multiselect']);

function asArray(maybeItems) {
  if (!maybeItems) return null;
  if (Array.isArray(maybeItems)) return maybeItems;
  if (Array.isArray(maybeItems.items)) return maybeItems.items;
  return null;
}

function isSystemField(field) {
  if (!field) return true;
  if (!field.key) return true;
  if (field.type && SYSTEM_TYPES.has(field.type)) return true;
  return false;
}

function fieldSummary(field) {
  return {
    field_id: field.id,
    key: field.key ?? null,
    title: field.title ?? null,
  };
}

function sortByFieldId(rows) {
  return rows.slice().sort((a, b) => {
    const ai = Number(a.field_id);
    const bi = Number(b.field_id);
    if (Number.isFinite(ai) && Number.isFinite(bi) && ai !== bi) return ai - bi;
    return String(a.field_id) < String(b.field_id) ? -1 : 1;
  });
}

/**
 * Build a quick lookup of a rule's active flag by `(kind, id)` so we can
 * cheaply classify references returned by `findFieldUsage`.
 *
 * `kind` here is the singular form `findFieldUsage` returns
 * (`trigger`, `automation`, `macro`, `view`, `ticket_form`).
 */
function buildActiveLookup(corpus) {
  const lookup = new Map();
  const sets = [
    ['trigger', corpus.triggers],
    ['automation', corpus.automations],
    ['macro', corpus.macros],
    ['view', corpus.views],
    ['ticket_form', corpus.ticket_forms],
  ];
  for (const [kind, items] of sets) {
    const arr = asArray(items);
    if (!arr) continue;
    for (const it of arr) {
      if (!it || it.id === undefined || it.id === null) continue;
      lookup.set(`${kind}:${it.id}`, it.active !== false);
    }
  }
  return lookup;
}

/**
 * @param {object} corpus
 *   Optional kinds: ticket_fields, ticket_forms, triggers, automations,
 *   macros, views. Each may be an array or a `{ items: [...] }` envelope.
 *   Missing kinds are silently tolerated, the tool layer is responsible
 *   for deciding what "missing" means (plan gating vs upstream error).
 * @returns {{
 *   unused_fields: Array,
 *   inactive_only_fields: Array,
 *   empty_option_lists: Array,
 *   not_in_active_form: Array,
 * }}
 */
export function auditFieldHealth(corpus = {}) {
  const fields = asArray(corpus.ticket_fields) ?? [];
  const forms = asArray(corpus.ticket_forms) ?? [];

  // findFieldUsage expects ticket_form items under `forms`, not `ticket_forms`.
  // Build a normalized corpus once and reuse for every lookup.
  const usageCorpus = {
    triggers: asArray(corpus.triggers) ?? [],
    automations: asArray(corpus.automations) ?? [],
    macros: asArray(corpus.macros) ?? [],
    views: asArray(corpus.views) ?? [],
    forms,
  };

  const activeLookup = buildActiveLookup({
    triggers: usageCorpus.triggers,
    automations: usageCorpus.automations,
    macros: usageCorpus.macros,
    views: usageCorpus.views,
    ticket_forms: forms,
  });

  // Set of field IDs present in any active form's `ticket_field_ids`.
  const fieldsInActiveForm = new Set();
  for (const form of forms) {
    if (!form || form.active === false) continue;
    const ids = Array.isArray(form.ticket_field_ids) ? form.ticket_field_ids : [];
    for (const id of ids) {
      fieldsInActiveForm.add(Number(id));
    }
  }

  const unused_fields = [];
  const inactive_only_fields = [];
  const empty_option_lists = [];
  const not_in_active_form = [];

  for (const field of fields) {
    if (isSystemField(field)) continue;

    const refs = findFieldUsage(field.id, usageCorpus);

    if (refs.length === 0) {
      unused_fields.push(fieldSummary(field));
    } else {
      // Classify each *rule* ref by active-ness of the host rule. Ticket-form
      // references are not rules, they're shape, so they don't participate
      // in the inactive-only classification. (Form references are folded
      // into the not_in_active_form section instead.)
      const ruleRefs = refs.filter(
        (r) => r.resource_kind !== 'ticket_form',
      );
      let anyActive = false;
      const inactiveRefs = [];
      for (const ref of ruleRefs) {
        const isActive = activeLookup.get(`${ref.resource_kind}:${ref.resource_id}`);
        // If we don't have an entry for the host (corpus didn't include that
        // kind, or the rule was missing an `active` flag), treat as active , 
        // we only flag "inactive-only" when we are sure every reference is
        // inactive.
        if (isActive !== false) {
          anyActive = true;
        } else {
          inactiveRefs.push({ kind: ref.resource_kind, id: ref.resource_id });
        }
      }
      if (!anyActive && inactiveRefs.length > 0) {
        // De-dupe (kind, id) pairs across condition/action references for
        // the same rule.
        const seen = new Set();
        const deduped = [];
        for (const r of inactiveRefs) {
          const key = `${r.kind}:${r.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          deduped.push(r);
        }
        inactive_only_fields.push({
          ...fieldSummary(field),
          references_in_inactive_rules: deduped,
        });
      }
    }

    if (OPTION_LIST_TYPES.has(field.type)) {
      const opts = Array.isArray(field.custom_field_options)
        ? field.custom_field_options
        : [];
      if (opts.length === 0) {
        empty_option_lists.push({
          ...fieldSummary(field),
          type: field.type,
        });
      }
    }

    // not_in_active_form: only meaningful when forms were supplied. If no
    // active forms exist in the corpus at all, every custom field would
    // technically qualify, surface that honestly rather than hiding the
    // signal.
    if (!fieldsInActiveForm.has(Number(field.id))) {
      not_in_active_form.push(fieldSummary(field));
    }
  }

  return {
    unused_fields: sortByFieldId(unused_fields),
    inactive_only_fields: sortByFieldId(inactive_only_fields),
    empty_option_lists: sortByFieldId(empty_option_lists),
    not_in_active_form: sortByFieldId(not_in_active_form),
  };
}

export const AuditComposites = { fieldHealth: auditFieldHealth };
