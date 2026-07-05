import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findByTag,
  findByField,
  TriggerAnalyzer,
} from '../src/lib/trigger-analyzer.js';

// TriggerAnalyzer is the heart of the analysis layer. Its tests
// lock in the domain logic that determines whether the consultancy advice
// the agent gives is right or wrong. Hand-built fixtures favor clarity over
// realism, each one isolates one rule of the matcher.

const fixtures = [
  // 1. Sets a single tag via current_tags action.
  {
    id: 1001,
    title: 'Mark VIP',
    active: true,
    position: 1,
    conditions: { all: [], any: [] },
    actions: [
      { field: 'current_tags', value: 'vip' },
      { field: 'priority', value: 'high' },
    ],
  },
  // 2. Sets multiple space-separated tags via current_tags.
  {
    id: 1002,
    title: 'Mark VIP and pending',
    active: true,
    position: 2,
    conditions: { all: [], any: [] },
    actions: [{ field: 'current_tags', value: 'vip pending_review urgent' }],
  },
  // 3. Removes a tag.
  {
    id: 1003,
    title: 'Clear pending',
    active: true,
    position: 3,
    conditions: { all: [], any: [] },
    actions: [{ field: 'remove_tags', value: 'pending_review' }],
  },
  // 4. Tag in condition (all-block).
  {
    id: 1004,
    title: 'When VIP, escalate',
    active: true,
    position: 4,
    conditions: {
      all: [
        { field: 'status', operator: 'is', value: 'open' },
        { field: 'current_tags', operator: 'includes', value: 'vip' },
      ],
      any: [],
    },
    actions: [{ field: 'priority', value: 'urgent' }],
  },
  // 5. Tag in condition (any-block, not_includes).
  {
    id: 1005,
    title: 'Any-not-VIP path',
    active: true,
    position: 5,
    conditions: {
      all: [],
      any: [{ field: 'current_tags', operator: 'not_includes', value: 'vip' }],
    },
    actions: [],
  },
  // 6. Deactivated trigger that still references form_id.
  {
    id: 1006,
    title: 'Old form router (off)',
    active: false,
    position: 6,
    conditions: {
      all: [{ field: 'ticket_form_id', operator: 'is', value: '42' }],
      any: [],
    },
    actions: [{ field: 'group_id', value: '7' }],
  },
  // 7. References group_id via action with numeric value.
  {
    id: 1007,
    title: 'Route to support group',
    active: true,
    position: 7,
    conditions: { all: [], any: [] },
    actions: [{ field: 'group_id', value: 7 }],
  },
  // 8. set_tags (replace) variant.
  {
    id: 1008,
    title: 'Replace all tags with cleanup',
    active: true,
    position: 8,
    conditions: { all: [], any: [] },
    actions: [{ field: 'set_tags', value: 'cleanup' }],
  },
  // 9. Status action solved.
  {
    id: 1009,
    title: 'Auto-solve resolved',
    active: true,
    position: 9,
    conditions: {
      all: [{ field: 'status', operator: 'is', value: 'pending' }],
      any: [],
    },
    actions: [{ field: 'status', value: 'solved' }],
  },
  // 10. Trigger that references group_id with a different value (negative case for value-narrowed find).
  {
    id: 1010,
    title: 'Route to billing group',
    active: true,
    position: 10,
    conditions: { all: [], any: [] },
    actions: [{ field: 'group_id', value: 99 }],
  },
];

// ---- findByTag ----------------------------------------------------------

test('findByTag(sets): single-tag and multi-tag actions match', () => {
  const matches = findByTag(fixtures, 'vip', 'sets');
  const ids = matches.map((m) => m.id);
  assert.ok(ids.includes(1001), 'should match single-tag action');
  assert.ok(ids.includes(1002), 'should match space-separated multi-tag action');
  assert.ok(!ids.includes(1003), 'should NOT match removes-only trigger');
  assert.ok(!ids.includes(1004), 'should NOT match condition-only trigger');
});

test('findByTag(sets): set_tags (replace) variant is included', () => {
  const matches = findByTag(fixtures, 'cleanup', 'sets');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, 1008);
  assert.match(matches[0].why_matched, /tag 'cleanup'/);
});

test('findByTag(removes): only matches remove_tags actions', () => {
  const matches = findByTag(fixtures, 'pending_review', 'removes');
  const ids = matches.map((m) => m.id);
  assert.deepEqual(ids, [1003]);
  assert.match(matches[0].why_matched, /removes tag 'pending_review' in action #\d+/);
});

test('findByTag(condition): matches all-block and any-block', () => {
  const matches = findByTag(fixtures, 'vip', 'condition');
  const ids = matches.map((m) => m.id).sort();
  assert.deepEqual(ids, [1004, 1005]);
  // why_matched mentions block name
  const all = matches.find((m) => m.id === 1004);
  const any = matches.find((m) => m.id === 1005);
  assert.match(all.why_matched, /all-block/);
  assert.match(any.why_matched, /any-block/);
  assert.match(any.why_matched, /not_includes/);
});

test('findByTag(any): union of sets, removes, and condition matches', () => {
  const matches = findByTag(fixtures, 'vip', 'any');
  const ids = matches.map((m) => m.id);
  // 1001 (sets), 1002 (sets), 1004 (cond all), 1005 (cond any)
  assert.ok(ids.includes(1001));
  assert.ok(ids.includes(1002));
  assert.ok(ids.includes(1004));
  assert.ok(ids.includes(1005));
  assert.ok(!ids.includes(1003), 'pending_review trigger should not match vip');
});

test('findByTag: results sorted by position ascending', () => {
  const matches = findByTag(fixtures, 'vip', 'any');
  const positions = matches.map((m) => m.position);
  const sorted = [...positions].sort((a, b) => a - b);
  assert.deepEqual(positions, sorted);
});

test('findByTag: why_matched conforms to expected text shape (regex)', () => {
  const matches = findByTag(fixtures, 'vip', 'any');
  const setsMatch = matches.find((m) => m.id === 1001);
  // "sets tag 'vip' in action #1"
  assert.match(setsMatch.why_matched, /^sets tag '[^']+' in action #\d+/);
  const condMatch = matches.find((m) => m.id === 1004);
  assert.match(
    condMatch.why_matched,
    /^condition checks tag '[^']+' \([^)]+\) in condition #\d+ of (all|any)-block/,
  );
});

test('findByTag: invalid mode throws', () => {
  assert.throws(() => findByTag(fixtures, 'vip', 'bogus'), /mode must be one of/);
});

test('findByTag: empty tag throws', () => {
  assert.throws(() => findByTag(fixtures, '', 'any'), /non-empty string/);
});

test('findByTag: non-array triggers throws', () => {
  assert.throws(() => findByTag(null, 'vip', 'any'), /must be an array/);
});

test('findByTag: tag not present anywhere returns empty array', () => {
  const matches = findByTag(fixtures, 'nonexistent', 'any');
  assert.deepEqual(matches, []);
});

// ---- findByField --------------------------------------------------------

test('findByField: matches references in conditions', () => {
  const matches = findByField(fixtures, 'ticket_form_id');
  const ids = matches.map((m) => m.id);
  assert.deepEqual(ids, [1006]);
  assert.match(matches[0].why_matched, /condition #\d+ of all-block/);
});

test('findByField: matches references in actions', () => {
  const matches = findByField(fixtures, 'group_id');
  const ids = matches.map((m) => m.id).sort();
  // 1006 (action group_id=7), 1007 (action group_id=7), 1010 (action group_id=99)
  assert.deepEqual(ids, [1006, 1007, 1010]);
});

test('findByField: value filter narrows to exact match (string-vs-number coerced)', () => {
  // numeric 7 in action vs string '7' search, both should hit
  const matchesNum = findByField(fixtures, 'group_id', 7);
  const matchesStr = findByField(fixtures, 'group_id', '7');
  assert.deepEqual(
    matchesNum.map((m) => m.id).sort(),
    [1006, 1007],
  );
  assert.deepEqual(
    matchesStr.map((m) => m.id).sort(),
    [1006, 1007],
  );
});

test('findByField: value filter excludes non-matching values', () => {
  const matches = findByField(fixtures, 'group_id', 7);
  const ids = matches.map((m) => m.id);
  assert.ok(!ids.includes(1010), 'group_id=99 should not match value=7');
});

test('findByField: status=solved finds the solving trigger only on action side', () => {
  const matches = findByField(fixtures, 'status', 'solved');
  const ids = matches.map((m) => m.id);
  assert.deepEqual(ids, [1009]);
  assert.match(matches[0].why_matched, /references status=solved in action #\d+/);
});

test('findByField: deactivated triggers are still scanned and flagged inactive', () => {
  const matches = findByField(fixtures, 'ticket_form_id');
  const m = matches.find((x) => x.id === 1006);
  assert.ok(m, 'deactivated trigger should appear in results');
  assert.match(m.why_matched, /\[inactive\]$/);
});

test('findByField: results sorted by position ascending', () => {
  const matches = findByField(fixtures, 'group_id');
  const positions = matches.map((m) => m.position);
  const sorted = [...positions].sort((a, b) => a - b);
  assert.deepEqual(positions, sorted);
});

test('findByField: no value filter returns all references regardless of value', () => {
  const matches = findByField(fixtures, 'group_id');
  // why_matched should NOT include "=" since no value filter
  for (const m of matches) {
    assert.doesNotMatch(m.why_matched, /references group_id=/);
    assert.match(m.why_matched, /references group_id in /);
  }
});

test('findByField: empty field name throws', () => {
  assert.throws(() => findByField(fixtures, '', 'x'), /non-empty string/);
});

test('findByField: unknown field returns empty array', () => {
  const matches = findByField(fixtures, 'no_such_field');
  assert.deepEqual(matches, []);
});

test('findByField: handles malformed trigger entries gracefully', () => {
  const dirty = [
    null,
    undefined,
    { id: 9, title: 'no conditions', active: true, position: 11 },
    { id: 10, title: 'string conds', conditions: 'not an object', actions: null },
    ...fixtures,
  ];
  const matches = findByField(dirty, 'group_id');
  assert.equal(matches.length, 3); // 1006, 1007, 1010
});

// ---- exports ------------------------------------------------------------

test('TriggerAnalyzer namespace re-exports findByTag and findByField', () => {
  assert.equal(typeof TriggerAnalyzer.findByTag, 'function');
  assert.equal(typeof TriggerAnalyzer.findByField, 'function');
  assert.equal(TriggerAnalyzer.findByTag, findByTag);
  assert.equal(TriggerAnalyzer.findByField, findByField);
});
