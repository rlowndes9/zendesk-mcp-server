import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  auditTriggerHealth,
  AuditComposites,
} from '../src/lib/audit-trigger-health.js';

/* ----------------------------- fixtures ----------------------------- */

// We hand-build a corpus where each finding category has at least one entry.
//   - 7001/7002: a conflict pair (same all-block, contradictory status action)
//   - 7003: chains an inactive trigger (7099) -> deactivated_but_referenced
//   - 7099: inactive, chained from 7003
//   - 7004: orphaned references (group_id=999 missing, ticket_form_id=888 missing,
//           custom_fields_777 missing, category_id=666 missing)
//   - 7005: inactive with low position 10 -> deactivated_with_low_position
//   - 7006/7007: duplicate position 80
//   - 7008: empty rule (no actions and no conditions in either block)
//   - 7009: empty rule (actions only, no conditions)
function buildCorpus(overrides = {}) {
  const base = {
    triggers: [
      // Conflict pair on status field, sharing one all-block tuple.
      {
        id: 7001,
        title: 'Open via VIP',
        active: true,
        position: 100,
        category_id: 1,
        conditions: {
          all: [{ field: 'priority', operator: 'is', value: 'urgent' }],
          any: [],
        },
        actions: [{ field: 'status', value: 'open' }],
      },
      {
        id: 7002,
        title: 'Pending via VIP',
        active: true,
        position: 110,
        category_id: 1,
        conditions: {
          all: [{ field: 'priority', operator: 'is', value: 'urgent' }],
          any: [],
        },
        actions: [{ field: 'status', value: 'pending' }],
      },
      // Active trigger that chains an inactive trigger.
      {
        id: 7003,
        title: 'Chains old routing',
        active: true,
        position: 120,
        category_id: 1,
        conditions: {
          all: [{ field: 'priority', operator: 'is', value: 'low' }],
          any: [],
        },
        actions: [{ field: 'trigger_id', value: 7099 }],
      },
      // The inactive target.
      {
        id: 7099,
        title: 'Old routing (deactivated)',
        active: false,
        position: 200,
        category_id: 1,
        conditions: {
          all: [{ field: 'priority', operator: 'is', value: 'low' }],
          any: [],
        },
        actions: [{ field: 'group_id', value: 1 }],
      },
      // Orphaned references everywhere.
      {
        id: 7004,
        title: 'Orphan ref bag',
        active: true,
        position: 130,
        category_id: 666, // missing category
        conditions: {
          all: [
            { field: 'group_id', operator: 'is', value: 999 }, // missing group
            { field: 'ticket_form_id', operator: 'is', value: 888 }, // missing form
            { field: 'custom_fields_777', operator: 'is', value: 'x' }, // missing field
          ],
          any: [],
        },
        actions: [{ field: 'priority', value: 'normal' }],
      },
      // Inactive with low position.
      {
        id: 7005,
        title: 'Disabled but early',
        active: false,
        position: 10,
        category_id: 1,
        conditions: {
          all: [{ field: 'priority', operator: 'is', value: 'high' }],
          any: [],
        },
        actions: [{ field: 'priority', value: 'urgent' }],
      },
      // Duplicate-position pair.
      {
        id: 7006,
        title: 'Dup pos A',
        active: true,
        position: 80,
        category_id: 1,
        conditions: {
          all: [{ field: 'priority', operator: 'is', value: 'normal' }],
          any: [],
        },
        actions: [{ field: 'priority', value: 'normal' }],
      },
      {
        id: 7007,
        title: 'Dup pos B',
        active: true,
        position: 80,
        category_id: 1,
        conditions: {
          all: [{ field: 'priority', operator: 'is', value: 'normal' }],
          any: [],
        },
        actions: [{ field: 'priority', value: 'normal' }],
      },
      // Empty: no actions, no conditions.
      {
        id: 7008,
        title: 'Empty everything',
        active: true,
        position: 140,
        category_id: 1,
        conditions: { all: [], any: [] },
        actions: [],
      },
      // Empty: actions but no conditions.
      {
        id: 7009,
        title: 'No conditions',
        active: true,
        position: 150,
        category_id: 1,
        conditions: { all: [], any: [] },
        actions: [{ field: 'priority', value: 'normal' }],
      },
    ],
    trigger_categories: [{ id: 1, name: 'Default' }],
    groups: [{ id: 1, name: 'Tier 1' }],
    ticket_fields: [
      { id: 4001, key: 'severity', title: 'Severity', type: 'text' },
    ],
    ticket_forms: [
      { id: 5001, name: 'Default', active: true, ticket_field_ids: [4001] },
    ],
  };
  return { ...base, ...overrides };
}

/* --------------------------- tests --------------------------- */

test('auditTriggerHealth: returns the five required sections', () => {
  const out = auditTriggerHealth(buildCorpus());
  assert.deepEqual(
    Object.keys(out).sort(),
    [
      'conflicts',
      'deactivated_but_referenced',
      'empty_rules',
      'ordering_anomalies',
      'orphaned_references',
    ],
  );
});

test('auditTriggerHealth: surfaces a field_overwrite conflict via TriggerAnalyzer.findConflicts', () => {
  const out = auditTriggerHealth(buildCorpus());
  // 7001 vs 7002, same priority=urgent precondition, contradictory status
  // action. findConflicts canonicalises lower-position first (7001).
  const c = out.conflicts.find(
    (x) => x.trigger_a.id === 7001 && x.trigger_b.id === 7002,
  );
  assert.ok(c, 'expected conflict between 7001 and 7002');
  assert.equal(c.conflict_type, 'field_overwrite');
  assert.match(c.why_matched, /priority/);
  assert.match(c.why_matched, /status/);
});

test('auditTriggerHealth: deactivated_but_referenced flags inactive triggers chained by active ones', () => {
  const out = auditTriggerHealth(buildCorpus());
  assert.equal(out.deactivated_but_referenced.length, 1);
  const entry = out.deactivated_but_referenced[0];
  assert.equal(entry.id, 7099);
  assert.equal(entry.title, 'Old routing (deactivated)');
  assert.equal(entry.position, 200);
  assert.equal(entry.referenced_by.length, 1);
  assert.equal(entry.referenced_by[0].id, 7003);
  assert.match(entry.referenced_by[0].why_matched, /trigger_id=7099/);
});

test('auditTriggerHealth: deactivated_but_referenced is empty when no chained references exist', () => {
  const corpus = buildCorpus();
  // Strip the chaining trigger so 7099 isn't referenced anywhere.
  corpus.triggers = corpus.triggers.filter((t) => t.id !== 7003);
  const out = auditTriggerHealth(corpus);
  assert.deepEqual(out.deactivated_but_referenced, []);
});

test('auditTriggerHealth: orphaned_references covers groups, forms, custom fields, and categories', () => {
  const out = auditTriggerHealth(buildCorpus());
  const refs = out.orphaned_references.filter((r) => r.trigger_id === 7004);
  const kinds = refs.map((r) => `${r.missing_kind}:${r.missing_id}`).sort();
  assert.deepEqual(kinds, [
    'group:999',
    'ticket_field:777',
    'ticket_form:888',
    'trigger_category:666',
  ]);
  // Each entry should carry trigger metadata + breadcrumb.
  for (const r of refs) {
    assert.equal(r.trigger_title, 'Orphan ref bag');
    assert.equal(r.position, 130);
    assert.ok(typeof r.why_matched === 'string' && r.why_matched.length > 0);
  }
});

test('auditTriggerHealth: skipping a missing-kind corpus skips that orphan check (tolerance)', () => {
  // No groups corpus at all -> should NOT flag group_id=999 as missing.
  const corpus = buildCorpus();
  delete corpus.groups;
  const out = auditTriggerHealth(corpus);
  const orphanGroups = out.orphaned_references.filter(
    (r) => r.missing_kind === 'group',
  );
  assert.equal(orphanGroups.length, 0);
  // But other kinds are still checked.
  const orphanForms = out.orphaned_references.filter(
    (r) => r.missing_kind === 'ticket_form',
  );
  assert.equal(orphanForms.length, 1);
});

test('auditTriggerHealth: ordering_anomalies flags low-position inactive + duplicate positions', () => {
  const out = auditTriggerHealth(buildCorpus());
  const ids = out.ordering_anomalies.map((a) => `${a.id}:${a.anomaly}`).sort();
  // 7005 -> deactivated_with_low_position
  // 7006, 7007 -> duplicate_position (one entry each)
  assert.deepEqual(ids, [
    '7005:deactivated_with_low_position',
    '7006:duplicate_position',
    '7007:duplicate_position',
  ]);
  const lowPos = out.ordering_anomalies.find((a) => a.id === 7005);
  assert.match(lowPos.note, /position 10/);
  const dup = out.ordering_anomalies.find((a) => a.id === 7006);
  assert.match(dup.note, /position 80/);
});

test('auditTriggerHealth: empty_rules categorises the missing piece', () => {
  const out = auditTriggerHealth(buildCorpus());
  const byId = new Map(out.empty_rules.map((r) => [r.id, r]));
  assert.deepEqual([...byId.keys()].sort((a, b) => a - b), [7008, 7009]);
  assert.equal(byId.get(7008).missing, 'both');
  assert.equal(byId.get(7009).missing, 'conditions');
});

test('auditTriggerHealth: empty_rules flags actions-missing too', () => {
  const out = auditTriggerHealth({
    triggers: [
      {
        id: 1,
        title: 'No actions',
        active: true,
        position: 1,
        conditions: {
          all: [{ field: 'priority', operator: 'is', value: 'urgent' }],
          any: [],
        },
        actions: [],
      },
    ],
  });
  assert.deepEqual(out.empty_rules, [
    { id: 1, title: 'No actions', position: 1, missing: 'actions' },
  ]);
});

test('auditTriggerHealth: each section is sorted ascending by id for determinism', () => {
  const out = auditTriggerHealth(buildCorpus());
  const ascending = (rows, key) => {
    const ids = rows.map((r) => Number(r[key]));
    for (let i = 1; i < ids.length; i++) {
      assert.ok(
        ids[i - 1] <= ids[i],
        `rows not sorted by ${key}: got ${ids.join(',')}`,
      );
    }
  };
  ascending(out.deactivated_but_referenced, 'id');
  ascending(out.orphaned_references, 'trigger_id');
  ascending(out.ordering_anomalies, 'id');
  ascending(out.empty_rules, 'id');
});

test('auditTriggerHealth: tolerates the list-envelope shape ({ items, count, ... })', () => {
  const out = auditTriggerHealth({
    triggers: {
      count: 1,
      items: [
        {
          id: 42,
          title: 'No conditions',
          active: true,
          position: 5,
          conditions: { all: [], any: [] },
          actions: [{ field: 'priority', value: 'normal' }],
        },
      ],
    },
    groups: { count: 0, items: [] },
    ticket_fields: { count: 0, items: [] },
    ticket_forms: { count: 0, items: [] },
    trigger_categories: { count: 0, items: [] },
  });
  assert.equal(out.empty_rules.length, 1);
  assert.equal(out.empty_rules[0].id, 42);
});

test('auditTriggerHealth: AuditComposites.triggerHealth is the same function', () => {
  assert.equal(AuditComposites.triggerHealth, auditTriggerHealth);
});
