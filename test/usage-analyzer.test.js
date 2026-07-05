import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findFieldUsage,
  findFormUsage,
  findGroupUsage,
  UsageAnalyzer,
} from '../src/lib/usage-analyzer.js';

/* ----------------------------- fixtures ----------------------------- */

const FIELD_ID = 360001;
const OTHER_FIELD_ID = 360999;
const FORM_ID = 70001;
const OTHER_FORM_ID = 70002;
const GROUP_ID = 80001;
const OTHER_GROUP_ID = 80002;

function fixtureTriggers() {
  return [
    {
      id: 1,
      title: 'Set urgent on VIP',
      conditions: {
        all: [
          { field: 'custom_fields_360001', operator: 'is', value: 'urgent' },
          { field: 'group_id', operator: 'is', value: String(GROUP_ID) },
        ],
        any: [
          { field: 'ticket_form_id', operator: 'is', value: String(FORM_ID) },
        ],
      },
      actions: [
        { field: 'group_id', value: String(OTHER_GROUP_ID) },
        { field: 'custom_fields_360001', value: 'high' },
      ],
    },
    {
      id: 2,
      title: 'Assign group via assignee_group',
      conditions: { all: [], any: [] },
      actions: [
        { field: 'assignee_group', value: String(GROUP_ID) },
        { field: 'priority', value: 'low' },
      ],
    },
    {
      id: 3,
      title: 'Untouched',
      conditions: { all: [], any: [] },
      actions: [{ field: 'priority', value: 'normal' }],
    },
  ];
}

function fixtureAutomations() {
  return [
    {
      id: 11,
      title: 'Pending stale auto',
      conditions: {
        all: [
          { field: 'custom_fields_360001', operator: 'is', value: 'urgent' },
        ],
        any: [],
      },
      actions: [{ field: 'group_id', value: String(GROUP_ID) }],
    },
  ];
}

function fixtureMacros() {
  return [
    {
      id: 21,
      title: 'Set urgent macro',
      actions: [
        { field: 'custom_fields_360001', value: 'urgent' },
        { field: 'comment_value', value: 'Hello' },
      ],
    },
    {
      id: 22,
      title: 'No-field macro',
      actions: [{ field: 'priority', value: 'high' }],
    },
  ];
}

function fixtureViews() {
  return [
    {
      id: 31,
      title: 'VIP view',
      conditions: {
        all: [
          { field: 'custom_fields_360001', operator: 'is', value: 'urgent' },
          { field: 'group_id', operator: 'is', value: String(GROUP_ID) },
        ],
        any: [
          { field: 'ticket_form_id', operator: 'is', value: String(FORM_ID) },
        ],
      },
    },
  ];
}

function fixtureForms() {
  return [
    {
      id: FORM_ID,
      name: 'Sales Form',
      ticket_field_ids: [40, 41, FIELD_ID, 42],
    },
    {
      id: OTHER_FORM_ID,
      name: 'Support Form',
      ticket_field_ids: [40, 41, 42],
    },
  ];
}

function fixtureSlaPolicies() {
  return [
    {
      id: 51,
      title: 'VIP SLA',
      filter: {
        all: [{ field: 'group_id', operator: 'is', value: String(GROUP_ID) }],
        any: [],
      },
    },
    {
      id: 52,
      title: 'Other SLA',
      filter: {
        all: [{ field: 'priority', operator: 'is', value: 'high' }],
        any: [],
      },
    },
  ];
}

function fullCorpus() {
  return {
    triggers: fixtureTriggers(),
    automations: fixtureAutomations(),
    macros: fixtureMacros(),
    views: fixtureViews(),
    forms: fixtureForms(),
    sla_policies: fixtureSlaPolicies(),
  };
}

/* ----------------------------- tests ----------------------------- */

test('UsageAnalyzer exports a stable object surface', () => {
  assert.equal(typeof UsageAnalyzer.findFieldUsage, 'function');
  assert.equal(typeof UsageAnalyzer.findFormUsage, 'function');
  assert.equal(typeof UsageAnalyzer.findGroupUsage, 'function');
});

test('findFieldUsage: requires a field_id', () => {
  assert.throws(() => findFieldUsage(undefined, fullCorpus()), /required/);
  assert.throws(() => findFieldUsage('', fullCorpus()), /required/);
});

test('findFieldUsage: surfaces trigger condition + action references', () => {
  const refs = findFieldUsage(FIELD_ID, fullCorpus());
  const trigger1 = refs.filter(
    (r) => r.resource_kind === 'trigger' && r.resource_id === 1,
  );
  // Trigger 1 references the field in one condition AND one action.
  assert.equal(trigger1.length, 2);
  const conditionMatch = trigger1.find((r) =>
    r.why_matched.startsWith('condition #1 of all-block'),
  );
  assert.ok(conditionMatch, 'expected condition match breadcrumb');
  assert.match(conditionMatch.why_matched, /custom_fields_360001/);
  const actionMatch = trigger1.find((r) => r.why_matched.startsWith('action #2'));
  assert.ok(actionMatch, 'expected action #2 breadcrumb');
  assert.match(actionMatch.why_matched, /sets custom_fields_360001/);
});

test('findFieldUsage: covers automation, macro, view, and form definition', () => {
  const refs = findFieldUsage(FIELD_ID, fullCorpus());
  const kinds = new Set(refs.map((r) => r.resource_kind));
  assert.ok(kinds.has('trigger'));
  assert.ok(kinds.has('automation'));
  assert.ok(kinds.has('macro'));
  assert.ok(kinds.has('view'));
  assert.ok(kinds.has('ticket_form'));

  const form = refs.find((r) => r.resource_kind === 'ticket_form');
  assert.equal(form.resource_id, FORM_ID);
  assert.equal(form.why_matched, 'present in form.ticket_field_ids[2]');
});

test('findFieldUsage: returns empty array when field is unreferenced', () => {
  const refs = findFieldUsage(OTHER_FIELD_ID, fullCorpus());
  assert.deepEqual(refs, []);
});

test('findFieldUsage: accepts both numeric id and prefixed key', () => {
  const a = findFieldUsage(FIELD_ID, fullCorpus());
  const b = findFieldUsage(`custom_fields_${FIELD_ID}`, fullCorpus());
  assert.deepEqual(a, b);
});

test('findFieldUsage: results sorted by (resource_kind, resource_id)', () => {
  const refs = findFieldUsage(FIELD_ID, fullCorpus());
  for (let i = 1; i < refs.length; i += 1) {
    const prev = refs[i - 1];
    const cur = refs[i];
    if (prev.resource_kind === cur.resource_kind) {
      assert.ok(
        String(prev.resource_id) <= String(cur.resource_id),
        `resource_id order broken at index ${i}: ${prev.resource_id} > ${cur.resource_id}`,
      );
    } else {
      assert.ok(
        prev.resource_kind < cur.resource_kind,
        `resource_kind order broken at index ${i}`,
      );
    }
  }
});

test('findFormUsage: matches trigger conditions and view conditions', () => {
  const refs = findFormUsage(FORM_ID, fullCorpus());
  const trig = refs.find(
    (r) => r.resource_kind === 'trigger' && r.resource_id === 1,
  );
  const view = refs.find(
    (r) => r.resource_kind === 'view' && r.resource_id === 31,
  );
  assert.ok(trig, 'trigger reference must surface');
  assert.match(trig.why_matched, /any-block/);
  assert.match(trig.why_matched, /ticket_form_id/);
  assert.ok(view, 'view reference must surface');
  assert.match(view.why_matched, /ticket_form_id/);
});

test('findFormUsage: empty when form unreferenced', () => {
  const refs = findFormUsage(OTHER_FORM_ID, fullCorpus());
  assert.deepEqual(refs, []);
});

test('findFormUsage: requires a form_id', () => {
  assert.throws(() => findFormUsage(undefined, fullCorpus()), /required/);
});

test('findGroupUsage: trigger condition + action (group_id) + action (assignee_group)', () => {
  const refs = findGroupUsage(GROUP_ID, fullCorpus());
  const triggerRefs = refs.filter((r) => r.resource_kind === 'trigger');
  // Trigger 1 hits in condition #1 of all-block. Trigger 2 hits via assignee_group action.
  const t1 = triggerRefs.find((r) => r.resource_id === 1);
  const t2 = triggerRefs.find((r) => r.resource_id === 2);
  assert.ok(t1);
  assert.match(t1.why_matched, /condition #2 of all-block/);
  assert.match(t1.why_matched, /group_id/);
  assert.ok(t2);
  assert.match(t2.why_matched, /assignee_group/);
});

test('findGroupUsage: surfaces automation action, view condition, SLA policy filter', () => {
  const refs = findGroupUsage(GROUP_ID, fullCorpus());
  const auto = refs.find((r) => r.resource_kind === 'automation');
  const view = refs.find((r) => r.resource_kind === 'view');
  const sla = refs.find((r) => r.resource_kind === 'sla_policy');
  assert.ok(auto);
  assert.match(auto.why_matched, /action #1/);
  assert.match(auto.why_matched, /group_id/);
  assert.ok(view);
  assert.match(view.why_matched, /condition #2 of all-block/);
  assert.ok(sla);
  assert.match(sla.why_matched, /filter #1 of all-block/);
  assert.match(sla.why_matched, /group_id/);
});

test('findGroupUsage: empty when group unreferenced', () => {
  // OTHER_GROUP_ID only appears in trigger 1's first action; ensure we still
  // find that, then confirm a totally unused id returns nothing.
  const refsOther = findGroupUsage(OTHER_GROUP_ID, fullCorpus());
  assert.equal(refsOther.length, 1);
  assert.equal(refsOther[0].resource_kind, 'trigger');
  assert.equal(refsOther[0].resource_id, 1);

  const refsUnused = findGroupUsage(99999999, fullCorpus());
  assert.deepEqual(refsUnused, []);
});

test('findGroupUsage: requires a group_id', () => {
  assert.throws(() => findGroupUsage(undefined, fullCorpus()), /required/);
});

test('findGroupUsage: gracefully handles missing corpus arrays', () => {
  const refs = findGroupUsage(GROUP_ID, {});
  assert.deepEqual(refs, []);
});

test('findFieldUsage: dedupes identical why_matched rows', () => {
  // If a corpus item happened to be duplicated, dedupe should still keep a
  // single reference.
  const dup = fixtureMacros()[0];
  const refs = findFieldUsage(FIELD_ID, { macros: [dup, dup] });
  // The macro has one matching action, even with the macro repeated we
  // expect a single reference per (kind, id, why).
  const macroRefs = refs.filter((r) => r.resource_kind === 'macro');
  assert.equal(macroRefs.length, 1);
});
