/**
 * UsageAnalyzer, pure functions that surface where a custom field, ticket
 * form, or group is referenced across an instance's config.
 *
 * No HTTP, no global state. All inputs come in via the `corpus` argument so
 * tests can drive these with hand-built fixtures.
 *
 * Reference shapes:
 *   - Triggers/automations/macros: conditions and actions are arrays of
 *     `{ field, value, operator? }` items.
 *       - Custom field reference: field is the literal string
 *         `custom_fields_<numeric_id>`.
 *       - Form reference: field === 'ticket_form_id', value === <form_id>.
 *       - Group reference: field === 'group_id' (condition) or
 *         field === 'group_id' / 'assignee_group' (action). value === <group_id>.
 *   - Ticket forms: `ticket_field_ids: [<field_id>, ...]`.
 *   - Views: `conditions.all` and `conditions.any` arrays, same `{ field, value }`
 *     shape; custom fields use the `custom_fields_<id>` prefix; groups use
 *     `group_id`; forms use `ticket_form_id`.
 *   - SLA policies: `filter.all` / `filter.any` arrays, `{ field, value }` items.
 *
 * Each match is `{ resource_kind, resource_id, resource_title, why_matched }`.
 * Returned arrays are sorted by `(resource_kind, resource_id)` for stable
 * output.
 */

const FIELD_PREFIX = 'custom_fields_';

function asString(v) {
  return v === null || v === undefined ? '' : String(v);
}

function getResourceTitle(resource) {
  return resource.title ?? resource.name ?? resource.display_name ?? null;
}

function pushIfNew(refs, ref) {
  // Dedupe identical (kind, id, why) combinations so the same condition row
  // can't surface twice if a corpus carries it doubly.
  const exists = refs.some(
    (r) =>
      r.resource_kind === ref.resource_kind &&
      asString(r.resource_id) === asString(ref.resource_id) &&
      r.why_matched === ref.why_matched,
  );
  if (!exists) refs.push(ref);
}

function sortReferences(refs) {
  return refs.slice().sort((a, b) => {
    if (a.resource_kind !== b.resource_kind) {
      return a.resource_kind < b.resource_kind ? -1 : 1;
    }
    const ai = asString(a.resource_id);
    const bi = asString(b.resource_id);
    if (ai !== bi) return ai < bi ? -1 : 1;
    return a.why_matched < b.why_matched ? -1 : a.why_matched > b.why_matched ? 1 : 0;
  });
}

/**
 * Walk a `{ all: [...], any: [...] }` shape and call `visit` for each row,
 * passing block name and 1-based index, plus the row.
 */
function walkConditionBlocks(conditions, visit) {
  if (!conditions || typeof conditions !== 'object') return;
  for (const block of ['all', 'any']) {
    const rows = Array.isArray(conditions[block]) ? conditions[block] : [];
    rows.forEach((row, idx) => visit(block, idx + 1, row));
  }
}

function walkActions(actions, visit) {
  if (!Array.isArray(actions)) return;
  actions.forEach((row, idx) => visit(idx + 1, row));
}

/* --------------------------- Field usage --------------------------- */

function fieldKeyFor(field_id) {
  return `${FIELD_PREFIX}${field_id}`;
}

function scanRuleForField(resource_kind, resource, fieldKey, refs) {
  const id = resource.id;
  const title = getResourceTitle(resource);

  walkConditionBlocks(resource.conditions, (block, idx, row) => {
    if (row && row.field === fieldKey) {
      pushIfNew(refs, {
        resource_kind,
        resource_id: id,
        resource_title: title,
        why_matched: `condition #${idx} of ${block}-block (${fieldKey} = ${JSON.stringify(row.value ?? null)})`,
      });
    }
  });

  walkActions(resource.actions, (idx, row) => {
    if (row && row.field === fieldKey) {
      pushIfNew(refs, {
        resource_kind,
        resource_id: id,
        resource_title: title,
        why_matched: `action #${idx} sets ${fieldKey} = ${JSON.stringify(row.value ?? null)}`,
      });
    }
  });
}

export function findFieldUsage(field_id, corpus = {}) {
  if (field_id === undefined || field_id === null || field_id === '') {
    throw new Error('findFieldUsage: field_id is required');
  }
  const numeric = String(field_id).replace(/^custom_fields_/, '');
  const fieldKey = fieldKeyFor(numeric);
  const refs = [];

  for (const t of corpus.triggers ?? []) {
    scanRuleForField('trigger', t, fieldKey, refs);
  }
  for (const a of corpus.automations ?? []) {
    scanRuleForField('automation', a, fieldKey, refs);
  }
  for (const m of corpus.macros ?? []) {
    // Macros only have actions, but treat conditions defensively.
    scanRuleForField('macro', m, fieldKey, refs);
  }
  for (const v of corpus.views ?? []) {
    scanRuleForField('view', v, fieldKey, refs);
  }

  // Ticket form definitions: `ticket_field_ids` is a numeric array.
  const numericId = Number(numeric);
  for (const f of corpus.forms ?? []) {
    const ids = Array.isArray(f.ticket_field_ids) ? f.ticket_field_ids : [];
    ids.forEach((fid, idx) => {
      if (Number(fid) === numericId) {
        pushIfNew(refs, {
          resource_kind: 'ticket_form',
          resource_id: f.id,
          resource_title: getResourceTitle(f),
          why_matched: `present in form.ticket_field_ids[${idx}]`,
        });
      }
    });
  }

  return sortReferences(refs);
}

/* ---------------------------- Form usage ---------------------------- */

function scanRuleForForm(resource_kind, resource, formId, refs) {
  const target = String(formId);
  const id = resource.id;
  const title = getResourceTitle(resource);

  walkConditionBlocks(resource.conditions, (block, idx, row) => {
    if (row && row.field === 'ticket_form_id' && asString(row.value) === target) {
      pushIfNew(refs, {
        resource_kind,
        resource_id: id,
        resource_title: title,
        why_matched: `condition #${idx} of ${block}-block (ticket_form_id = ${JSON.stringify(row.value)})`,
      });
    }
  });

  walkActions(resource.actions, (idx, row) => {
    if (row && row.field === 'ticket_form_id' && asString(row.value) === target) {
      pushIfNew(refs, {
        resource_kind,
        resource_id: id,
        resource_title: title,
        why_matched: `action #${idx} sets ticket_form_id = ${JSON.stringify(row.value)}`,
      });
    }
  });
}

export function findFormUsage(form_id, corpus = {}) {
  if (form_id === undefined || form_id === null || form_id === '') {
    throw new Error('findFormUsage: form_id is required');
  }
  const refs = [];

  for (const t of corpus.triggers ?? []) {
    scanRuleForForm('trigger', t, form_id, refs);
  }
  for (const a of corpus.automations ?? []) {
    scanRuleForForm('automation', a, form_id, refs);
  }
  for (const m of corpus.macros ?? []) {
    scanRuleForForm('macro', m, form_id, refs);
  }
  for (const v of corpus.views ?? []) {
    scanRuleForForm('view', v, form_id, refs);
  }

  return sortReferences(refs);
}

/* --------------------------- Group usage --------------------------- */

const GROUP_CONDITION_FIELDS = new Set(['group_id']);
const GROUP_ACTION_FIELDS = new Set(['group_id', 'assignee_group']);

function scanRuleForGroup(resource_kind, resource, groupId, refs) {
  const target = String(groupId);
  const id = resource.id;
  const title = getResourceTitle(resource);

  walkConditionBlocks(resource.conditions, (block, idx, row) => {
    if (
      row &&
      GROUP_CONDITION_FIELDS.has(row.field) &&
      asString(row.value) === target
    ) {
      pushIfNew(refs, {
        resource_kind,
        resource_id: id,
        resource_title: title,
        why_matched: `condition #${idx} of ${block}-block (${row.field} = ${JSON.stringify(row.value)})`,
      });
    }
  });

  walkActions(resource.actions, (idx, row) => {
    if (
      row &&
      GROUP_ACTION_FIELDS.has(row.field) &&
      asString(row.value) === target
    ) {
      pushIfNew(refs, {
        resource_kind,
        resource_id: id,
        resource_title: title,
        why_matched: `action #${idx} sets ${row.field} = ${JSON.stringify(row.value)}`,
      });
    }
  });
}

function scanSlaPolicyForGroup(policy, groupId, refs) {
  const target = String(groupId);
  const id = policy.id;
  const title = getResourceTitle(policy);
  const filter = policy.filter && typeof policy.filter === 'object' ? policy.filter : {};
  for (const block of ['all', 'any']) {
    const rows = Array.isArray(filter[block]) ? filter[block] : [];
    rows.forEach((row, idx) => {
      if (
        row &&
        row.field === 'group_id' &&
        asString(row.value) === target
      ) {
        pushIfNew(refs, {
          resource_kind: 'sla_policy',
          resource_id: id,
          resource_title: title,
          why_matched: `filter #${idx + 1} of ${block}-block (group_id = ${JSON.stringify(row.value)})`,
        });
      }
    });
  }
}

export function findGroupUsage(group_id, corpus = {}) {
  if (group_id === undefined || group_id === null || group_id === '') {
    throw new Error('findGroupUsage: group_id is required');
  }
  const refs = [];

  for (const t of corpus.triggers ?? []) {
    scanRuleForGroup('trigger', t, group_id, refs);
  }
  for (const a of corpus.automations ?? []) {
    scanRuleForGroup('automation', a, group_id, refs);
  }
  for (const v of corpus.views ?? []) {
    scanRuleForGroup('view', v, group_id, refs);
  }
  for (const p of corpus.sla_policies ?? []) {
    scanSlaPolicyForGroup(p, group_id, refs);
  }

  return sortReferences(refs);
}

export const UsageAnalyzer = {
  findFieldUsage,
  findFormUsage,
  findGroupUsage,
};
