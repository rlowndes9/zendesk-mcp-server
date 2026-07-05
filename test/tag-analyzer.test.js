import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inventory,
  parseTagValue,
  TagAnalyzer,
} from '../src/lib/tag-analyzer.js';

// TagAnalyzer. Hand-built corpora isolate one rule per fixture.
// Tests pin the user-facing inventory shape: tag, used_in[], dupe_suspects[],
// set_only.

// ---- inventory: basic recording ----------------------------------------

test('inventory: tag set in trigger action and condition in another trigger, both recorded with mode', () => {
  const triggers = [
    {
      id: 1,
      title: 'Set VIP',
      conditions: { all: [], any: [] },
      actions: [{ field: 'current_tags', value: 'vip' }],
    },
    {
      id: 2,
      title: 'When VIP, escalate',
      conditions: {
        all: [{ field: 'current_tags', operator: 'includes', value: 'vip' }],
        any: [],
      },
      actions: [{ field: 'priority', value: 'urgent' }],
    },
  ];
  const result = inventory({ triggers, automations: [], macros: [] });
  assert.equal(result.length, 1);
  const rec = result[0];
  assert.equal(rec.tag, 'vip');
  // Two used_in entries, one per trigger, with distinct modes.
  const modes = rec.used_in.map((u) => `${u.kind}:${u.id}:${u.mode}`).sort();
  assert.deepEqual(modes, ['trigger:1:sets', 'trigger:2:condition']);
  assert.equal(rec.set_only, false, 'has both action and condition usage');
});

test('inventory: tag removed via remove_tags action records mode=removes', () => {
  const triggers = [
    {
      id: 10,
      title: 'Clear stale',
      conditions: { all: [], any: [] },
      actions: [{ field: 'remove_tags', value: 'stale' }],
    },
  ];
  const result = inventory({ triggers });
  assert.equal(result.length, 1);
  const rec = result[0];
  assert.equal(rec.tag, 'stale');
  assert.equal(rec.used_in.length, 1);
  assert.equal(rec.used_in[0].mode, 'removes');
  assert.equal(rec.used_in[0].kind, 'trigger');
  assert.equal(rec.used_in[0].id, 10);
  assert.equal(rec.set_only, true, 'tag only ever appears in remove action');
});

// ---- inventory: dupe-suspect detection ---------------------------------

test('inventory: case-insensitive and separator-stripped dupes (vip / VIP / v_i_p) mutually flagged', () => {
  const triggers = [
    {
      id: 1,
      title: 'lower',
      conditions: { all: [], any: [] },
      actions: [{ field: 'current_tags', value: 'vip' }],
    },
    {
      id: 2,
      title: 'upper',
      conditions: { all: [], any: [] },
      actions: [{ field: 'current_tags', value: 'VIP' }],
    },
    {
      id: 3,
      title: 'separated',
      conditions: { all: [], any: [] },
      actions: [{ field: 'current_tags', value: 'v_i_p' }],
    },
  ];
  const result = inventory({ triggers });
  const byTag = Object.fromEntries(result.map((r) => [r.tag, r]));
  assert.deepEqual(byTag['vip'].dupe_suspects.sort(), ['VIP', 'v_i_p']);
  assert.deepEqual(byTag['VIP'].dupe_suspects.sort(), ['v_i_p', 'vip']);
  assert.deepEqual(byTag['v_i_p'].dupe_suspects.sort(), ['VIP', 'vip']);
  // Self never appears in own dupe_suspects.
  for (const tag of Object.keys(byTag)) {
    assert.ok(!byTag[tag].dupe_suspects.includes(tag), `${tag} not in own suspects`);
  }
});

test('inventory: separator-stripped dupe (vip-customer / vipcustomer)', () => {
  const triggers = [
    {
      id: 1,
      title: 'a',
      conditions: { all: [], any: [] },
      actions: [{ field: 'current_tags', value: 'vip-customer' }],
    },
    {
      id: 2,
      title: 'b',
      conditions: { all: [], any: [] },
      actions: [{ field: 'current_tags', value: 'vipcustomer' }],
    },
  ];
  const result = inventory({ triggers });
  const byTag = Object.fromEntries(result.map((r) => [r.tag, r]));
  assert.deepEqual(byTag['vip-customer'].dupe_suspects, ['vipcustomer']);
  assert.deepEqual(byTag['vipcustomer'].dupe_suspects, ['vip-customer']);
});

test('inventory: Levenshtein-1 dupes for length ≥ 5 (customer / customr) are flagged', () => {
  const triggers = [
    {
      id: 1,
      title: 'a',
      conditions: { all: [], any: [] },
      actions: [{ field: 'current_tags', value: 'customer' }],
    },
    {
      id: 2,
      title: 'b',
      conditions: { all: [], any: [] },
      actions: [{ field: 'current_tags', value: 'customr' }],
    },
  ];
  const result = inventory({ triggers });
  const byTag = Object.fromEntries(result.map((r) => [r.tag, r]));
  assert.deepEqual(byTag['customer'].dupe_suspects, ['customr']);
  assert.deepEqual(byTag['customr'].dupe_suspects, ['customer']);
});

test('inventory: Levenshtein-1 dupes for short tags (cat / bat) are NOT flagged', () => {
  const triggers = [
    {
      id: 1,
      title: 'a',
      conditions: { all: [], any: [] },
      actions: [{ field: 'current_tags', value: 'cat' }],
    },
    {
      id: 2,
      title: 'b',
      conditions: { all: [], any: [] },
      actions: [{ field: 'current_tags', value: 'bat' }],
    },
  ];
  const result = inventory({ triggers });
  const byTag = Object.fromEntries(result.map((r) => [r.tag, r]));
  assert.deepEqual(byTag['cat'].dupe_suspects, []);
  assert.deepEqual(byTag['bat'].dupe_suspects, []);
});

// ---- inventory: set_only flag ------------------------------------------

test('inventory: set_only=true when tag appears only in actions', () => {
  const triggers = [
    {
      id: 1,
      title: 'set in action',
      conditions: { all: [], any: [] },
      actions: [{ field: 'current_tags', value: 'orphan_tag' }],
    },
  ];
  const result = inventory({ triggers });
  const rec = result.find((r) => r.tag === 'orphan_tag');
  assert.ok(rec);
  assert.equal(rec.set_only, true);
});

test('inventory: set_only=false when tag also appears in a condition', () => {
  const triggers = [
    {
      id: 1,
      title: 'set in action',
      conditions: { all: [], any: [] },
      actions: [{ field: 'current_tags', value: 'live_tag' }],
    },
    {
      id: 2,
      title: 'cond reads it',
      conditions: {
        all: [],
        any: [{ field: 'current_tags', operator: 'includes', value: 'live_tag' }],
      },
      actions: [],
    },
  ];
  const result = inventory({ triggers });
  const rec = result.find((r) => r.tag === 'live_tag');
  assert.ok(rec);
  assert.equal(rec.set_only, false);
});

test('inventory: set_only=true when tag appears only via remove_tags (no condition)', () => {
  const triggers = [
    {
      id: 1,
      title: 'just removes',
      conditions: { all: [], any: [] },
      actions: [{ field: 'remove_tags', value: 'gone' }],
    },
  ];
  const result = inventory({ triggers });
  const rec = result.find((r) => r.tag === 'gone');
  assert.equal(rec.set_only, true);
});

// ---- inventory: empty / edge cases -------------------------------------

test('inventory: empty corpus returns empty array', () => {
  assert.deepEqual(inventory({}), []);
  assert.deepEqual(inventory({ triggers: [], automations: [], macros: [] }), []);
});

test('inventory: handles malformed entries gracefully', () => {
  const triggers = [
    null,
    undefined,
    {},
    { id: 1, title: 'no actions or conds' },
    { id: 2, title: 'string conds', conditions: 'oops', actions: null },
    {
      id: 3,
      title: 'good',
      conditions: { all: [], any: [] },
      actions: [{ field: 'current_tags', value: 'real' }],
    },
  ];
  const result = inventory({ triggers });
  assert.equal(result.length, 1);
  assert.equal(result[0].tag, 'real');
});

// ---- inventory: dedup across multiple resources ------------------------

test('inventory: same tag set in multiple resources appears once with multiple used_in entries', () => {
  const triggers = [
    {
      id: 1,
      title: 'trigger one',
      conditions: { all: [], any: [] },
      actions: [{ field: 'current_tags', value: 'shared' }],
    },
  ];
  const automations = [
    {
      id: 100,
      title: 'auto one',
      conditions: { all: [], any: [] },
      actions: [{ field: 'current_tags', value: 'shared' }],
    },
  ];
  const macros = [
    {
      id: 500,
      title: 'macro one',
      actions: [{ field: 'current_tags', value: 'shared' }],
    },
  ];
  const result = inventory({ triggers, automations, macros });
  assert.equal(result.length, 1);
  assert.equal(result[0].tag, 'shared');
  assert.equal(result[0].used_in.length, 3);
  const kinds = result[0].used_in.map((u) => u.kind).sort();
  assert.deepEqual(kinds, ['automation', 'macro', 'trigger']);
});

test('inventory: dedupes (kind, id, mode), same trigger sets same tag in two actions appears once', () => {
  const triggers = [
    {
      id: 1,
      title: 'duplicate sets',
      conditions: { all: [], any: [] },
      actions: [
        { field: 'current_tags', value: 'tagx' },
        { field: 'current_tags', value: 'tagx other' },
      ],
    },
  ];
  const result = inventory({ triggers });
  // tagx and other -> 2 tags; tagx used_in should have one entry
  const tagx = result.find((r) => r.tag === 'tagx');
  assert.equal(tagx.used_in.length, 1);
  assert.equal(tagx.used_in[0].mode, 'sets');
});

// ---- inventory: macros + automations ----------------------------------

test('inventory: macro actions contribute (sets/removes only, no conditions)', () => {
  const macros = [
    {
      id: 9,
      title: 'macro w/ tag',
      actions: [
        { field: 'current_tags', value: 'm_tag' },
        { field: 'remove_tags', value: 'm_old' },
      ],
    },
  ];
  const result = inventory({ macros });
  assert.equal(result.length, 2);
  const mTag = result.find((r) => r.tag === 'm_tag');
  const mOld = result.find((r) => r.tag === 'm_old');
  assert.equal(mTag.used_in[0].kind, 'macro');
  assert.equal(mTag.used_in[0].mode, 'sets');
  assert.equal(mOld.used_in[0].mode, 'removes');
});

test('inventory: automations contribute via both conditions and actions', () => {
  const automations = [
    {
      id: 200,
      title: 'auto cond',
      conditions: {
        all: [{ field: 'current_tags', operator: 'includes', value: 'a_tag' }],
        any: [],
      },
      actions: [{ field: 'current_tags', value: 'b_tag' }],
    },
  ];
  const result = inventory({ automations });
  const aTag = result.find((r) => r.tag === 'a_tag');
  const bTag = result.find((r) => r.tag === 'b_tag');
  assert.equal(aTag.used_in[0].kind, 'automation');
  assert.equal(aTag.used_in[0].mode, 'condition');
  assert.equal(aTag.set_only, false);
  assert.equal(bTag.used_in[0].mode, 'sets');
  assert.equal(bTag.set_only, true);
});

// ---- inventory: sorting ------------------------------------------------

test('inventory: results sorted by tag name ascending (case-insensitive)', () => {
  const triggers = [
    {
      id: 1,
      title: 't',
      conditions: { all: [], any: [] },
      actions: [
        { field: 'current_tags', value: 'zebra alpha Mango bravo' },
      ],
    },
  ];
  const result = inventory({ triggers });
  const names = result.map((r) => r.tag);
  // alpha, bravo, Mango, zebra (case-insensitive sort)
  assert.deepEqual(names, ['alpha', 'bravo', 'Mango', 'zebra']);
});

// ---- parseTagValue helper ----------------------------------------------

test('parseTagValue: splits whitespace, drops empties, handles arrays and null', () => {
  assert.deepEqual(parseTagValue('vip pending  urgent'), ['vip', 'pending', 'urgent']);
  assert.deepEqual(parseTagValue(['vip pending', 'urgent']), ['vip', 'pending', 'urgent']);
  assert.deepEqual(parseTagValue(null), []);
  assert.deepEqual(parseTagValue(undefined), []);
  assert.deepEqual(parseTagValue(''), []);
  assert.deepEqual(parseTagValue('   '), []);
});

test('inventory: defensive, value provided as array is split per element', () => {
  const triggers = [
    {
      id: 1,
      title: 'array val',
      conditions: { all: [], any: [] },
      actions: [{ field: 'current_tags', value: ['vip', 'urgent escalation'] }],
    },
  ];
  const result = inventory({ triggers });
  const names = result.map((r) => r.tag).sort();
  assert.deepEqual(names, ['escalation', 'urgent', 'vip']);
});

// ---- exports ------------------------------------------------------------

test('TagAnalyzer namespace re-exports inventory and parseTagValue', () => {
  assert.equal(TagAnalyzer.inventory, inventory);
  assert.equal(TagAnalyzer.parseTagValue, parseTagValue);
});
