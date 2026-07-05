import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findConflicts,
  TriggerAnalyzer,
} from '../src/lib/trigger-analyzer.js';

// findConflicts. Hand-built fixtures isolate each rule.
//
// Conflict definition (verbatim from PRD):
//   1. Two triggers' all-block condition signatures overlap (i.e. they share
//      at least one (field, operator, value) tuple in their all-blocks).
//   2. They both write to the same target field with different values, OR
//      one sets a tag and the other removes the same tag.
//
// Sub-classes:
//   - field_overwrite (different values on same action field)
//   - tag_set_remove_pair (set/remove asymmetry on a tag)
//
// One-sided overlap (strict superset with no shared tuple) is intentionally
// NOT flagged, those are usually intended refinements; flagging would be
// noise. See JSDoc on findConflicts for the full rationale.

const cond = (field, operator, value) => ({ field, operator, value });
const trig = (over) => ({
  active: true,
  conditions: { all: [], any: [] },
  actions: [],
  ...over,
});

// ---- field_overwrite ---------------------------------------------------

test('findConflicts: same all-block, different status values → field_overwrite', () => {
  const triggers = [
    trig({
      id: 1,
      title: 'Open ticket → assign to Alice',
      position: 1,
      conditions: { all: [cond('status', 'is', 'open')], any: [] },
      actions: [{ field: 'assignee_id', value: 5 }],
    }),
    trig({
      id: 2,
      title: 'Open ticket → assign to Bob',
      position: 2,
      conditions: { all: [cond('status', 'is', 'open')], any: [] },
      actions: [{ field: 'assignee_id', value: 8 }],
    }),
  ];
  const conflicts = findConflicts(triggers);
  assert.equal(conflicts.length, 1);
  const c = conflicts[0];
  assert.equal(c.conflict_type, 'field_overwrite');
  assert.equal(c.trigger_a.id, 1);
  assert.equal(c.trigger_b.id, 2);
  assert.match(c.why_matched, /status/);
  assert.match(c.why_matched, /assignee_id=/);
  assert.match(c.why_matched, /'5'/);
  assert.match(c.why_matched, /'8'/);
});

test('findConflicts: same field, same value → NOT flagged', () => {
  const triggers = [
    trig({
      id: 1,
      title: 'A',
      position: 1,
      conditions: { all: [cond('status', 'is', 'open')], any: [] },
      actions: [{ field: 'priority', value: 'high' }],
    }),
    trig({
      id: 2,
      title: 'B',
      position: 2,
      conditions: { all: [cond('status', 'is', 'open')], any: [] },
      actions: [{ field: 'priority', value: 'high' }],
    }),
  ];
  assert.deepEqual(findConflicts(triggers), []);
});

// ---- tag_set_remove_pair ----------------------------------------------

test('findConflicts: A sets tag X, B removes tag X under shared all-block → tag_set_remove_pair', () => {
  const triggers = [
    trig({
      id: 10,
      title: 'Mark VIP',
      position: 1,
      conditions: { all: [cond('priority', 'is', 'urgent')], any: [] },
      actions: [{ field: 'current_tags', value: 'vip' }],
    }),
    trig({
      id: 11,
      title: 'Strip VIP',
      position: 2,
      conditions: { all: [cond('priority', 'is', 'urgent')], any: [] },
      actions: [{ field: 'remove_tags', value: 'vip' }],
    }),
  ];
  const conflicts = findConflicts(triggers);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].conflict_type, 'tag_set_remove_pair');
  assert.equal(conflicts[0].trigger_a.id, 10);
  assert.equal(conflicts[0].trigger_b.id, 11);
  assert.match(conflicts[0].why_matched, /priority/);
  assert.match(conflicts[0].why_matched, /sets tag 'vip'/);
  assert.match(conflicts[0].why_matched, /removes tag 'vip'/);
});

test('findConflicts: tag set/remove with set_tags (replace) variant', () => {
  const triggers = [
    trig({
      id: 20,
      title: 'Replace tags with cleanup',
      position: 1,
      conditions: { all: [cond('status', 'is', 'pending')], any: [] },
      actions: [{ field: 'set_tags', value: 'cleanup' }],
    }),
    trig({
      id: 21,
      title: 'Strip cleanup',
      position: 2,
      conditions: { all: [cond('status', 'is', 'pending')], any: [] },
      actions: [{ field: 'remove_tags', value: 'cleanup' }],
    }),
  ];
  const conflicts = findConflicts(triggers);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].conflict_type, 'tag_set_remove_pair');
});

test('findConflicts: tag set/remove ordering, remover positioned first still pair detected, lower-position is trigger_a', () => {
  const triggers = [
    trig({
      id: 30,
      title: 'Remove first (lower position)',
      position: 1,
      conditions: { all: [cond('status', 'is', 'open')], any: [] },
      actions: [{ field: 'remove_tags', value: 'flag' }],
    }),
    trig({
      id: 31,
      title: 'Set later (higher position)',
      position: 2,
      conditions: { all: [cond('status', 'is', 'open')], any: [] },
      actions: [{ field: 'current_tags', value: 'flag' }],
    }),
  ];
  const conflicts = findConflicts(triggers);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].trigger_a.id, 30, 'lower position becomes trigger_a');
  assert.equal(conflicts[0].trigger_b.id, 31);
  assert.equal(conflicts[0].conflict_type, 'tag_set_remove_pair');
  assert.match(conflicts[0].why_matched, /removes tag 'flag'/);
  assert.match(conflicts[0].why_matched, /sets tag 'flag'/);
});

// ---- negative: disjoint conditions ------------------------------------

test('findConflicts: completely disjoint all-blocks → not flagged', () => {
  const triggers = [
    trig({
      id: 1,
      title: 'A',
      position: 1,
      conditions: { all: [cond('status', 'is', 'open')], any: [] },
      actions: [{ field: 'assignee_id', value: 5 }],
    }),
    trig({
      id: 2,
      title: 'B',
      position: 2,
      conditions: { all: [cond('priority', 'is', 'urgent')], any: [] },
      actions: [{ field: 'assignee_id', value: 8 }],
    }),
  ];
  assert.deepEqual(findConflicts(triggers), []);
});

// ---- negative: one-sided overlap (strict superset, no shared tuple) ---
// Documented choice: strict superset relations with no shared tuple are NOT
// flagged. This is a deliberate conservative choice to suppress noise; the
// JSDoc on findConflicts states this. Even when one all-block is a strict
// superset, if there's no shared (field, operator, value) tuple, no flag.

test('findConflicts: one-sided overlap with NO shared tuple → not flagged', () => {
  const triggers = [
    trig({
      id: 1,
      title: 'Loose',
      position: 1,
      conditions: {
        all: [cond('status', 'is', 'open')],
        any: [],
      },
      actions: [{ field: 'assignee_id', value: 5 }],
    }),
    trig({
      id: 2,
      title: 'Stricter (different operator)',
      position: 2,
      // Same field but different operator/value tuple, no exact match.
      conditions: {
        all: [
          cond('status', 'changed_to', 'open'),
          cond('priority', 'is', 'urgent'),
        ],
        any: [],
      },
      actions: [{ field: 'assignee_id', value: 8 }],
    }),
  ];
  assert.deepEqual(
    findConflicts(triggers),
    [],
    'no shared (field,operator,value) tuple → no flag, even with related semantics',
  );
});

test('findConflicts: strict superset WITH shared tuple → still flagged on shared tuple', () => {
  // When a shared tuple exists alongside the superset relation, we DO flag , 
  // the conflict is on the shared precondition, not on the extra refinement.
  const triggers = [
    trig({
      id: 1,
      title: 'Loose',
      position: 1,
      conditions: { all: [cond('status', 'is', 'open')], any: [] },
      actions: [{ field: 'assignee_id', value: 5 }],
    }),
    trig({
      id: 2,
      title: 'Stricter superset',
      position: 2,
      conditions: {
        all: [
          cond('status', 'is', 'open'), // shared with #1
          cond('priority', 'is', 'urgent'),
        ],
        any: [],
      },
      actions: [{ field: 'assignee_id', value: 8 }],
    }),
  ];
  const conflicts = findConflicts(triggers);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].conflict_type, 'field_overwrite');
});

// ---- target_id filter --------------------------------------------------

test('findConflicts: target_id filter returns only conflicts involving that trigger', () => {
  const triggers = [
    trig({
      id: 100,
      title: 'A',
      position: 1,
      conditions: { all: [cond('status', 'is', 'open')], any: [] },
      actions: [{ field: 'assignee_id', value: 1 }],
    }),
    trig({
      id: 101,
      title: 'B',
      position: 2,
      conditions: { all: [cond('status', 'is', 'open')], any: [] },
      actions: [{ field: 'assignee_id', value: 2 }],
    }),
    trig({
      id: 102,
      title: 'C',
      position: 3,
      conditions: { all: [cond('status', 'is', 'open')], any: [] },
      actions: [{ field: 'assignee_id', value: 3 }],
    }),
  ];
  // Without filter: 3 pairwise conflicts (100-101, 100-102, 101-102).
  const all = findConflicts(triggers);
  assert.equal(all.length, 3);
  // With target_id=101: only conflicts involving 101 (100-101 and 101-102).
  const filtered = findConflicts(triggers, 101);
  assert.equal(filtered.length, 2);
  for (const c of filtered) {
    const ids = [c.trigger_a.id, c.trigger_b.id];
    assert.ok(ids.includes(101), 'every conflict involves 101');
  }
});

test('findConflicts: target_id filter coerces string ids', () => {
  const triggers = [
    trig({
      id: 1,
      title: 'A',
      position: 1,
      conditions: { all: [cond('status', 'is', 'open')], any: [] },
      actions: [{ field: 'assignee_id', value: 5 }],
    }),
    trig({
      id: 2,
      title: 'B',
      position: 2,
      conditions: { all: [cond('status', 'is', 'open')], any: [] },
      actions: [{ field: 'assignee_id', value: 8 }],
    }),
  ];
  assert.equal(findConflicts(triggers, '1').length, 1);
  assert.equal(findConflicts(triggers, '2').length, 1);
  assert.equal(findConflicts(triggers, '999').length, 0);
});

// ---- ordering ----------------------------------------------------------

test('findConflicts: results sorted by trigger_a.position ascending', () => {
  const triggers = [
    trig({
      id: 1,
      title: 'A',
      position: 5,
      conditions: { all: [cond('status', 'is', 'open')], any: [] },
      actions: [{ field: 'assignee_id', value: 1 }],
    }),
    trig({
      id: 2,
      title: 'B',
      position: 10,
      conditions: { all: [cond('status', 'is', 'open')], any: [] },
      actions: [{ field: 'assignee_id', value: 2 }],
    }),
    trig({
      id: 3,
      title: 'C',
      position: 1,
      conditions: { all: [cond('priority', 'is', 'urgent')], any: [] },
      actions: [{ field: 'group_id', value: 7 }],
    }),
    trig({
      id: 4,
      title: 'D',
      position: 2,
      conditions: { all: [cond('priority', 'is', 'urgent')], any: [] },
      actions: [{ field: 'group_id', value: 8 }],
    }),
  ];
  const conflicts = findConflicts(triggers);
  // Conflicts: (3,4) at positions (1,2) and (1,2) at positions (5,10).
  assert.equal(conflicts.length, 2);
  assert.equal(conflicts[0].trigger_a.id, 3); // position 1, fires first
  assert.equal(conflicts[1].trigger_a.id, 1); // position 5
});

test('findConflicts: canonical pairing, lower position is always trigger_a', () => {
  const triggers = [
    trig({
      id: 99,
      title: 'Higher id, lower position',
      position: 1,
      conditions: { all: [cond('status', 'is', 'open')], any: [] },
      actions: [{ field: 'assignee_id', value: 5 }],
    }),
    trig({
      id: 1,
      title: 'Lower id, higher position',
      position: 5,
      conditions: { all: [cond('status', 'is', 'open')], any: [] },
      actions: [{ field: 'assignee_id', value: 8 }],
    }),
  ];
  const conflicts = findConflicts(triggers);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].trigger_a.id, 99, 'lower position wins, regardless of id');
  assert.equal(conflicts[0].trigger_b.id, 1);
});

test('findConflicts: position tie-broken by id ascending', () => {
  const triggers = [
    trig({
      id: 7,
      title: 'A',
      position: 1,
      conditions: { all: [cond('status', 'is', 'open')], any: [] },
      actions: [{ field: 'assignee_id', value: 5 }],
    }),
    trig({
      id: 3,
      title: 'B',
      position: 1,
      conditions: { all: [cond('status', 'is', 'open')], any: [] },
      actions: [{ field: 'assignee_id', value: 8 }],
    }),
  ];
  const conflicts = findConflicts(triggers);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].trigger_a.id, 3, 'tied position → lower id wins');
  assert.equal(conflicts[0].trigger_b.id, 7);
});

// ---- result shape ------------------------------------------------------

test('findConflicts: result shape exposes id/title/position on both triggers', () => {
  const triggers = [
    trig({
      id: 1,
      title: 'First',
      position: 1,
      conditions: { all: [cond('status', 'is', 'open')], any: [] },
      actions: [{ field: 'assignee_id', value: 5 }],
    }),
    trig({
      id: 2,
      title: 'Second',
      position: 2,
      conditions: { all: [cond('status', 'is', 'open')], any: [] },
      actions: [{ field: 'assignee_id', value: 8 }],
    }),
  ];
  const c = findConflicts(triggers)[0];
  assert.deepEqual(Object.keys(c).sort(), [
    'conflict_type',
    'trigger_a',
    'trigger_b',
    'why_matched',
  ]);
  assert.deepEqual(c.trigger_a, { id: 1, title: 'First', position: 1 });
  assert.deepEqual(c.trigger_b, { id: 2, title: 'Second', position: 2 });
});

// ---- input validation --------------------------------------------------

test('findConflicts: non-array triggers throws', () => {
  assert.throws(() => findConflicts(null), /must be an array/);
  assert.throws(() => findConflicts({}), /must be an array/);
});

test('findConflicts: malformed entries are skipped, no throw', () => {
  const triggers = [
    null,
    undefined,
    { id: 1 }, // missing conditions/actions
    'not a trigger',
    trig({
      id: 10,
      title: 'A',
      position: 1,
      conditions: { all: [cond('status', 'is', 'open')], any: [] },
      actions: [{ field: 'assignee_id', value: 5 }],
    }),
    trig({
      id: 11,
      title: 'B',
      position: 2,
      conditions: { all: [cond('status', 'is', 'open')], any: [] },
      actions: [{ field: 'assignee_id', value: 8 }],
    }),
  ];
  const conflicts = findConflicts(triggers);
  assert.equal(conflicts.length, 1);
});

test('findConflicts: empty array returns empty', () => {
  assert.deepEqual(findConflicts([]), []);
});

// ---- TriggerAnalyzer namespace ----------------------------------------

test('TriggerAnalyzer namespace re-exports findConflicts', () => {
  assert.equal(typeof TriggerAnalyzer.findConflicts, 'function');
  assert.equal(TriggerAnalyzer.findConflicts, findConflicts);
});
