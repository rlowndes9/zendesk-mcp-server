import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  auditTagSprawl,
  AuditComposites,
} from '../src/lib/audit-tag-sprawl.js';
import { TagAnalyzer } from '../src/lib/tag-analyzer.js';

/* ----------------------------- helpers ----------------------------- */

function setTrigger(id, title, value) {
  return {
    id,
    title,
    conditions: { all: [], any: [] },
    actions: [{ field: 'current_tags', value }],
  };
}

function condTrigger(id, title, value) {
  return {
    id,
    title,
    conditions: {
      all: [{ field: 'current_tags', operator: 'includes', value }],
      any: [],
    },
    actions: [],
  };
}

/* ----------------------------- tests ----------------------------- */

test('auditTagSprawl: inventory passes through TagAnalyzer.inventory shape exactly', () => {
  const corpus = {
    triggers: [
      setTrigger(1, 'sets vip', 'vip'),
      condTrigger(2, 'reads vip', 'vip'),
    ],
    automations: [],
    macros: [],
  };
  const out = auditTagSprawl(corpus);
  const expected = TagAnalyzer.inventory(corpus);
  assert.deepEqual(out.inventory, expected);
  // The inventory has the documented row shape.
  for (const row of out.inventory) {
    assert.equal(typeof row.tag, 'string');
    assert.ok(Array.isArray(row.used_in));
    assert.ok(Array.isArray(row.dupe_suspects));
    assert.equal(typeof row.set_only, 'boolean');
  }
});

test('auditTagSprawl: case-variant cluster (vip, VIP, v_i_p) collapses into one cluster of size 3', () => {
  const corpus = {
    triggers: [
      setTrigger(1, 'lower', 'vip'),
      setTrigger(2, 'upper', 'VIP'),
      setTrigger(3, 'separated', 'v_i_p'),
    ],
  };
  const out = auditTagSprawl(corpus);
  assert.equal(out.suspected_duplicates.length, 1);
  const cluster = out.suspected_duplicates[0];
  assert.equal(cluster.cluster_size, 3);
  // Sorted case-insensitive alphabetically, V before v lexicographically
  // upper-case... but case-insensitive sort puts them by lowercase, then
  // raw comparison breaks ties. Three identical lowercase forms means
  // raw-tiebreak ordering: capitals first lexicographically.
  assert.deepEqual(cluster.cluster.slice().sort(), ['VIP', 'v_i_p', 'vip']);
  // total_usage = 3 used_in entries (one per trigger).
  assert.equal(cluster.total_usage, 3);
});

test('auditTagSprawl: cluster transitive closure, A↔B and B↔C produce one cluster {A,B,C}, not two', () => {
  // Levenshtein-1 chain by progressive insertion. All length ≥ 5 to clear
  // the dupe-detector length threshold:
  //   abcde   ↔ abcdef    (Lev=1)
  //   abcdef  ↔ abcdefg   (Lev=1)
  //   abcde   ↔ abcdefg   (Lev=2 → NOT a direct dupe)
  // The audit must close transitively over the chain.
  const corpus = {
    triggers: [
      setTrigger(1, 'a', 'abcde'),
      setTrigger(2, 'b', 'abcdef'),
      setTrigger(3, 'c', 'abcdefg'),
    ],
  };
  const out = auditTagSprawl(corpus);
  const inv = Object.fromEntries(out.inventory.map((r) => [r.tag, r]));
  // Sanity-check: the chain endpoints are NOT direct dupes, otherwise
  // this test isn't exercising transitive closure.
  assert.ok(!inv['abcde'].dupe_suspects.includes('abcdefg'),
    'endpoints should not be direct dupes (Lev=2)');
  assert.ok(inv['abcde'].dupe_suspects.includes('abcdef'));
  assert.ok(inv['abcdef'].dupe_suspects.includes('abcdefg'));
  // The audit composite must collapse them via transitive closure.
  assert.equal(out.suspected_duplicates.length, 1);
  const cluster = out.suspected_duplicates[0];
  assert.equal(cluster.cluster_size, 3);
  assert.deepEqual(cluster.cluster, ['abcde', 'abcdef', 'abcdefg']);
});

test('auditTagSprawl: set_only_tags includes only tags with set_only=true, sorted by name', () => {
  const corpus = {
    triggers: [
      // dead_tag, only set, never conditioned on -> set_only true
      setTrigger(1, 'sets dead', 'dead_tag'),
      // live_tag, both set and conditioned on -> set_only false
      setTrigger(2, 'sets live', 'live_tag'),
      condTrigger(3, 'reads live', 'live_tag'),
      // archive, only removed, never conditioned on -> set_only true
      {
        id: 4,
        title: 'remove arch',
        conditions: { all: [], any: [] },
        actions: [{ field: 'remove_tags', value: 'archive' }],
      },
    ],
  };
  const out = auditTagSprawl(corpus);
  assert.deepEqual(out.set_only_tags, [
    { tag: 'archive', used_in_count: 1 },
    { tag: 'dead_tag', used_in_count: 1 },
  ]);
  // live_tag must NOT be in the set_only list.
  const tags = out.set_only_tags.map((r) => r.tag);
  assert.equal(tags.includes('live_tag'), false);
});

test('auditTagSprawl: usage_distribution respects top_n cap and is sorted descending by count', () => {
  const corpus = {
    triggers: [
      // Tag 'hot' used 3 times across 3 triggers
      setTrigger(1, 'a', 'hot'),
      setTrigger(2, 'b', 'hot'),
      setTrigger(3, 'c', 'hot'),
      // Tag 'warm' used 2 times
      setTrigger(4, 'd', 'warm'),
      setTrigger(5, 'e', 'warm'),
      // Tags 'cold' and 'cool' used once each
      setTrigger(6, 'f', 'cold'),
      setTrigger(7, 'g', 'cool'),
    ],
  };
  const fullOut = auditTagSprawl(corpus);
  // Default cap = 25; corpus has 4 tags, all should appear sorted desc.
  assert.deepEqual(
    fullOut.usage_distribution.map((r) => r.tag),
    ['hot', 'warm', 'cold', 'cool'],
  );
  assert.deepEqual(
    fullOut.usage_distribution.map((r) => r.count),
    [3, 2, 1, 1],
  );
  // top_n caps the list.
  const cappedOut = auditTagSprawl(corpus, { topN: 2 });
  assert.equal(cappedOut.usage_distribution.length, 2);
  assert.deepEqual(
    cappedOut.usage_distribution.map((r) => r.tag),
    ['hot', 'warm'],
  );
});

test('auditTagSprawl: empty corpus → all sections empty', () => {
  const out = auditTagSprawl({});
  assert.deepEqual(out.inventory, []);
  assert.deepEqual(out.suspected_duplicates, []);
  assert.deepEqual(out.set_only_tags, []);
  assert.deepEqual(out.usage_distribution, []);

  const out2 = auditTagSprawl({ triggers: [], automations: [], macros: [] });
  assert.deepEqual(out2.inventory, []);
  assert.deepEqual(out2.suspected_duplicates, []);
  assert.deepEqual(out2.set_only_tags, []);
  assert.deepEqual(out2.usage_distribution, []);
});

test('auditTagSprawl: single tag with no dupes → suspected_duplicates is empty', () => {
  const corpus = {
    triggers: [setTrigger(1, 'only', 'solo_tag')],
  };
  const out = auditTagSprawl(corpus);
  assert.equal(out.inventory.length, 1);
  assert.equal(out.inventory[0].tag, 'solo_tag');
  // Singletons are NOT clusters.
  assert.deepEqual(out.suspected_duplicates, []);
  // It's set-only (no condition) so it appears in set_only_tags.
  assert.deepEqual(out.set_only_tags, [{ tag: 'solo_tag', used_in_count: 1 }]);
  assert.deepEqual(out.usage_distribution, [{ tag: 'solo_tag', count: 1 }]);
});

test('auditTagSprawl: multiple independent clusters are sorted by cluster_size desc, ties by alpha', () => {
  const corpus = {
    triggers: [
      // Cluster 1: three case variants of "alpha"
      setTrigger(1, 'a', 'alpha'),
      setTrigger(2, 'b', 'ALPHA'),
      setTrigger(3, 'c', 'a_l_p_h_a'),
      // Cluster 2: two variants of "bravo"
      setTrigger(4, 'd', 'bravo'),
      setTrigger(5, 'e', 'BRAVO'),
      // Cluster 3: two variants of "charlie"
      setTrigger(6, 'f', 'charlie'),
      setTrigger(7, 'g', 'CHARLIE'),
    ],
  };
  const out = auditTagSprawl(corpus);
  assert.equal(out.suspected_duplicates.length, 3);
  // Largest cluster first.
  assert.equal(out.suspected_duplicates[0].cluster_size, 3);
  // Two-member clusters tied at size 2; tie-break alpha by first member.
  assert.equal(out.suspected_duplicates[1].cluster_size, 2);
  assert.equal(out.suspected_duplicates[2].cluster_size, 2);
  // bravo cluster sorts before charlie cluster (b < c, case-insensitive).
  const firstOfSecond = out.suspected_duplicates[1].cluster[0].toLowerCase();
  const firstOfThird = out.suspected_duplicates[2].cluster[0].toLowerCase();
  assert.ok(firstOfSecond.startsWith('b'));
  assert.ok(firstOfThird.startsWith('c'));
});

test('auditTagSprawl: total_usage sums used_in.length across the cluster', () => {
  // vip set in 2 triggers, VIP set in 1, conditioned on in 1 more.
  const corpus = {
    triggers: [
      setTrigger(1, 'a', 'vip'),
      setTrigger(2, 'b', 'vip'),
      setTrigger(3, 'c', 'VIP'),
      condTrigger(4, 'd', 'VIP'),
    ],
  };
  const out = auditTagSprawl(corpus);
  assert.equal(out.suspected_duplicates.length, 1);
  // vip used_in: 2 (set in trigger 1, set in trigger 2)
  // VIP used_in: 2 (set in trigger 3, condition in trigger 4)
  // total_usage: 4
  assert.equal(out.suspected_duplicates[0].total_usage, 4);
});

test('auditTagSprawl: AuditComposites.tagSprawl is the same function', () => {
  assert.equal(AuditComposites.tagSprawl, auditTagSprawl);
});
