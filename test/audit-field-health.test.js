import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditFieldHealth, AuditComposites } from '../src/lib/audit-field-health.js';

/* ----------------------------- fixtures ----------------------------- */

// Field IDs cover each finding category and the system-field skip path.
const F_USED_ACTIVE = 1001;        // referenced by an active trigger -> healthy
const F_UNUSED = 1002;              // referenced by nothing -> unused
const F_INACTIVE_ONLY = 1003;       // referenced only by an inactive trigger -> inactive_only
const F_EMPTY_OPTIONS = 1004;       // tagger with empty options
const F_NOT_IN_ACTIVE_FORM = 1005;  // present only in an inactive form
const F_BUILTIN_NO_KEY = 9001;      // system: no `key`, must be skipped
const F_BUILTIN_BY_TYPE = 9002;     // system: type="subject"

function buildCorpus(overrides = {}) {
  return {
    ticket_fields: [
      {
        id: F_USED_ACTIVE,
        key: 'severity',
        title: 'Severity',
        type: 'text',
      },
      {
        id: F_UNUSED,
        key: 'legacy_flag',
        title: 'Legacy Flag',
        type: 'text',
      },
      {
        id: F_INACTIVE_ONLY,
        key: 'old_routing',
        title: 'Old Routing',
        type: 'text',
      },
      {
        id: F_EMPTY_OPTIONS,
        key: 'product_line',
        title: 'Product Line',
        type: 'tagger',
        custom_field_options: [],
      },
      {
        id: F_NOT_IN_ACTIVE_FORM,
        key: 'orphan_field',
        title: 'Orphan Field',
        type: 'text',
      },
      // System fields, both should be skipped entirely.
      {
        id: F_BUILTIN_NO_KEY,
        title: 'Subject',
        type: 'subject',
      },
      {
        id: F_BUILTIN_BY_TYPE,
        key: '',
        title: 'Status',
        type: 'status',
      },
    ],
    ticket_forms: [
      {
        id: 5001,
        active: true,
        name: 'Default Form',
        ticket_field_ids: [F_USED_ACTIVE, F_INACTIVE_ONLY, F_EMPTY_OPTIONS],
      },
      {
        id: 5002,
        active: false,
        name: 'Retired Form',
        ticket_field_ids: [F_NOT_IN_ACTIVE_FORM],
      },
    ],
    triggers: [
      {
        id: 7001,
        title: 'Active routing',
        active: true,
        conditions: {
          all: [
            { field: `custom_fields_${F_USED_ACTIVE}`, operator: 'is', value: 'high' },
          ],
          any: [],
        },
        actions: [],
      },
      {
        id: 7002,
        title: 'Disabled legacy routing',
        active: false,
        conditions: {
          all: [
            { field: `custom_fields_${F_INACTIVE_ONLY}`, operator: 'is', value: 'old' },
          ],
          any: [],
        },
        actions: [
          { field: `custom_fields_${F_INACTIVE_ONLY}`, value: 'archived' },
        ],
      },
    ],
    automations: [],
    macros: [],
    views: [],
    ...overrides,
  };
}

/* --------------------------- tests --------------------------- */

test('auditFieldHealth: flags unused custom fields, skips system fields', () => {
  const out = auditFieldHealth(buildCorpus());
  const ids = out.unused_fields.map((f) => f.field_id);
  // F_UNUSED has no references; F_NOT_IN_ACTIVE_FORM is on an inactive form
  // (which counts as a usage reference -> NOT unused, just orphaned).
  // The system fields must not appear regardless.
  assert.deepEqual(ids, [F_UNUSED]);
  assert.deepEqual(out.unused_fields[0], {
    field_id: F_UNUSED,
    key: 'legacy_flag',
    title: 'Legacy Flag',
  });
  // Confirm system fields are nowhere in the response.
  const allIds = [
    ...out.unused_fields,
    ...out.inactive_only_fields,
    ...out.empty_option_lists,
    ...out.not_in_active_form,
  ].map((r) => r.field_id);
  assert.equal(allIds.includes(F_BUILTIN_NO_KEY), false);
  assert.equal(allIds.includes(F_BUILTIN_BY_TYPE), false);
});

test('auditFieldHealth: inactive_only_fields lists inactive references and dedupes by (kind, id)', () => {
  const out = auditFieldHealth(buildCorpus());
  assert.equal(out.inactive_only_fields.length, 1);
  const entry = out.inactive_only_fields[0];
  assert.equal(entry.field_id, F_INACTIVE_ONLY);
  assert.equal(entry.key, 'old_routing');
  // Trigger 7002 referenced the field in BOTH conditions and actions; the
  // de-dupe logic should yield a single { kind, id } pair.
  assert.deepEqual(entry.references_in_inactive_rules, [
    { kind: 'trigger', id: 7002 },
  ]);
});

test('auditFieldHealth: a field used by ANY active rule is not "inactive only"', () => {
  // Mutate corpus so F_INACTIVE_ONLY is also referenced by an *active* macro.
  const corpus = buildCorpus({
    macros: [
      {
        id: 8001,
        title: 'Active macro touching old_routing',
        active: true,
        actions: [
          { field: `custom_fields_${F_INACTIVE_ONLY}`, value: 'fresh' },
        ],
      },
    ],
  });
  const out = auditFieldHealth(corpus);
  assert.equal(out.inactive_only_fields.length, 0);
});

test('auditFieldHealth: empty_option_lists flags only tagger/multiselect with empty options', () => {
  const corpus = buildCorpus({
    ticket_fields: [
      ...buildCorpus().ticket_fields,
      // tagger WITH options -> not flagged
      {
        id: 1010,
        key: 'priority_band',
        title: 'Priority Band',
        type: 'tagger',
        custom_field_options: [{ id: 1, name: 'A', value: 'a' }],
      },
      // multiselect WITHOUT options -> flagged
      {
        id: 1011,
        key: 'channels',
        title: 'Channels',
        type: 'multiselect',
        custom_field_options: [],
      },
      // text type with no options array -> not flagged
      {
        id: 1012,
        key: 'note',
        title: 'Note',
        type: 'text',
      },
    ],
  });
  const out = auditFieldHealth(corpus);
  const ids = out.empty_option_lists.map((r) => r.field_id);
  assert.deepEqual(ids, [F_EMPTY_OPTIONS, 1011]);
  // Each entry includes `type` to disambiguate dropdown vs multiselect.
  assert.equal(out.empty_option_lists[0].type, 'tagger');
  assert.equal(out.empty_option_lists[1].type, 'multiselect');
});

test('auditFieldHealth: not_in_active_form lists fields missing from every active form', () => {
  const out = auditFieldHealth(buildCorpus());
  const ids = out.not_in_active_form.map((r) => r.field_id);
  // F_USED_ACTIVE, F_INACTIVE_ONLY, F_EMPTY_OPTIONS are in the active form.
  // F_UNUSED and F_NOT_IN_ACTIVE_FORM are not. System fields are skipped.
  assert.deepEqual(ids.sort((a, b) => a - b), [F_UNUSED, F_NOT_IN_ACTIVE_FORM]);
});

test('auditFieldHealth: tolerates missing kinds (no triggers/automations/macros/views/forms)', () => {
  // Only ticket_fields supplied, every non-system field should land in
  // unused_fields and (since there are no active forms) in not_in_active_form.
  // No empty_option_lists for the text-only fields, but the tagger with no
  // options should still be flagged.
  const out = auditFieldHealth({
    ticket_fields: [
      { id: 200, key: 'a', title: 'A', type: 'text' },
      { id: 201, key: 'b', title: 'B', type: 'tagger', custom_field_options: [] },
      { id: 202, title: 'Subject', type: 'subject' }, // skipped
    ],
  });
  assert.deepEqual(
    out.unused_fields.map((r) => r.field_id),
    [200, 201],
  );
  assert.deepEqual(
    out.empty_option_lists.map((r) => r.field_id),
    [201],
  );
  assert.deepEqual(
    out.not_in_active_form.map((r) => r.field_id),
    [200, 201],
  );
  // No host-rule corpus -> no inactive-only classifications possible.
  assert.deepEqual(out.inactive_only_fields, []);
});

test('auditFieldHealth: each section sorted by field_id ascending for determinism', () => {
  const out = auditFieldHealth({
    ticket_fields: [
      { id: 300, key: 'c', title: 'C', type: 'text' },
      { id: 100, key: 'a', title: 'A', type: 'text' },
      { id: 200, key: 'b', title: 'B', type: 'text' },
    ],
  });
  assert.deepEqual(
    out.unused_fields.map((r) => r.field_id),
    [100, 200, 300],
  );
  assert.deepEqual(
    out.not_in_active_form.map((r) => r.field_id),
    [100, 200, 300],
  );
});

test('auditFieldHealth: tolerates the list-envelope shape ({ items, count, ... })', () => {
  const out = auditFieldHealth({
    ticket_fields: {
      count: 1,
      items: [{ id: 400, key: 'k', title: 'K', type: 'text' }],
    },
    ticket_forms: { count: 0, items: [] },
    triggers: { count: 0, items: [] },
  });
  assert.deepEqual(
    out.unused_fields.map((r) => r.field_id),
    [400],
  );
});

test('auditFieldHealth: AuditComposites.fieldHealth is the same function', () => {
  assert.equal(AuditComposites.fieldHealth, auditFieldHealth);
});
