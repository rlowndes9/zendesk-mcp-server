import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFilterAndSlice } from '../src/lib/list-pagination.js';
import { decode as decodeCursor } from '../src/lib/cursor.js';
import { projectionRegistry } from '../src/lib/projection-registry.js';

function makeTriggers(n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push({
      id: i,
      title: `Trigger ${i}`,
      active: i % 2 === 0,
      position: i,
      category_id: (i % 3) + 1,
      description: 'long description bytes '.repeat(20),
      updated_at: new Date(Date.UTC(2026, 0, i)).toISOString(),
    });
  }
  return out;
}

test('list-pagination: defaults to skeleton projection (4 fields)', () => {
  const corpus = makeTriggers(5);
  const out = applyFilterAndSlice(corpus, {
    kind: 'triggers',
    instance: 'acme',
    cachedAt: 'snap-1',
  });
  assert.equal(out.count, 5);
  assert.equal(out.total, 5);
  assert.equal(out.truncated, false);
  assert.equal(out.cursor, null);
  for (const item of out.items) {
    assert.deepEqual(Object.keys(item).sort(), ['active', 'id', 'title', 'updated_at']);
  }
});

test('list-pagination: applies limit then surfaces a fresh cursor', () => {
  const corpus = makeTriggers(250);
  const out = applyFilterAndSlice(corpus, {
    kind: 'triggers',
    instance: 'acme',
    cachedAt: 'snap-1',
    limit: 100,
  });
  assert.equal(out.count, 100);
  assert.equal(out.total, 250);
  assert.equal(out.truncated, true);
  assert.equal(typeof out.cursor, 'string');
  const decoded = decodeCursor(out.cursor);
  assert.equal(decoded.offset, 100);
  assert.equal(decoded.cached_at, 'snap-1');
});

test('list-pagination: cursor walks across the corpus', () => {
  const corpus = makeTriggers(250);
  const p1 = applyFilterAndSlice(corpus, {
    kind: 'triggers',
    instance: 'acme',
    cachedAt: 'snap-1',
    limit: 100,
  });
  assert.equal(p1.items[0].id, 1);
  assert.equal(p1.items[99].id, 100);

  const p2 = applyFilterAndSlice(corpus, {
    kind: 'triggers',
    instance: 'acme',
    cachedAt: 'snap-1',
    limit: 100,
    cursor: p1.cursor,
  });
  assert.equal(p2.items[0].id, 101);
  assert.equal(p2.items[99].id, 200);
  assert.equal(p2.cursor_invalidated, false);
  assert.equal(p2.truncated, true);

  const p3 = applyFilterAndSlice(corpus, {
    kind: 'triggers',
    instance: 'acme',
    cachedAt: 'snap-1',
    limit: 100,
    cursor: p2.cursor,
  });
  assert.equal(p3.items[0].id, 201);
  assert.equal(p3.items.length, 50);
  assert.equal(p3.truncated, false);
  assert.equal(p3.cursor, null);
});

test('list-pagination: stale cursor (cached_at mismatch) resets and flags', () => {
  const corpus = makeTriggers(50);
  const p1 = applyFilterAndSlice(corpus, {
    kind: 'triggers',
    instance: 'acme',
    cachedAt: 'snap-1',
    limit: 10,
  });
  // simulate cache refresh, different cached_at
  const p2 = applyFilterAndSlice(corpus, {
    kind: 'triggers',
    instance: 'acme',
    cachedAt: 'snap-2',
    limit: 10,
    cursor: p1.cursor,
  });
  assert.equal(p2.cursor_invalidated, true);
  assert.equal(p2.items[0].id, 1, 'reset to offset 0');
});

test('list-pagination: malformed cursor flags cursor_invalidated', () => {
  const corpus = makeTriggers(20);
  const out = applyFilterAndSlice(corpus, {
    kind: 'triggers',
    instance: 'acme',
    cachedAt: 'snap-1',
    cursor: 'not-a-real-token!@',
  });
  assert.equal(out.cursor_invalidated, true);
  assert.equal(out.items[0].id, 1);
});

test('list-pagination: fields whitelist overrides skeleton', () => {
  const corpus = makeTriggers(3);
  const out = applyFilterAndSlice(corpus, {
    kind: 'triggers',
    instance: 'acme',
    cachedAt: 'snap-1',
    fields: ['id', 'position', 'category_id'],
  });
  for (const item of out.items) {
    assert.deepEqual(Object.keys(item).sort(), ['category_id', 'id', 'position']);
  }
});

test('list-pagination: verbose:true skips projection (full payload)', () => {
  const corpus = makeTriggers(3);
  const out = applyFilterAndSlice(corpus, {
    kind: 'triggers',
    instance: 'acme',
    cachedAt: 'snap-1',
    verbose: true,
  });
  assert.ok('description' in out.items[0]);
});

test('list-pagination: filter.active applied before slicing', () => {
  const corpus = makeTriggers(20); // 10 active, 10 inactive
  const out = applyFilterAndSlice(corpus, {
    kind: 'triggers',
    instance: 'acme',
    cachedAt: 'snap-1',
    filter: { active: true },
  });
  assert.equal(out.total, 10);
  for (const item of out.items) assert.equal(item.active, true);
});

test('list-pagination: filter.title_contains is case-insensitive', () => {
  const corpus = [
    { id: 1, title: 'Auto-assign VIP', active: true, updated_at: 'x' },
    { id: 2, title: 'auto Reply', active: true, updated_at: 'x' },
    { id: 3, title: 'Greet customer', active: true, updated_at: 'x' },
  ];
  const out = applyFilterAndSlice(corpus, {
    kind: 'triggers',
    instance: 'acme',
    cachedAt: 'snap-1',
    filter: { title_contains: 'AUTO' },
  });
  assert.equal(out.total, 2);
});

test('list-pagination: filter.updated_since drops older items', () => {
  const corpus = [
    { id: 1, title: 't1', active: true, updated_at: '2026-01-01T00:00:00Z' },
    { id: 2, title: 't2', active: true, updated_at: '2026-04-15T00:00:00Z' },
    { id: 3, title: 't3', active: true, updated_at: '2026-04-20T00:00:00Z' },
  ];
  const out = applyFilterAndSlice(corpus, {
    kind: 'triggers',
    instance: 'acme',
    cachedAt: 'snap-1',
    filter: { updated_since: '2026-04-10T00:00:00Z' },
  });
  assert.equal(out.total, 2);
});

test('list-pagination: unsupported filter key surfaces a note', () => {
  const corpus = makeTriggers(3);
  const out = applyFilterAndSlice(corpus, {
    kind: 'triggers',
    instance: 'acme',
    cachedAt: 'snap-1',
    filter: { not_a_real_key: 'hi' },
  });
  assert.ok(Array.isArray(out.filter_notes));
  assert.match(out.filter_notes[0], /not_a_real_key/);
});

test('list-pagination: limit caps at 25000', () => {
  const corpus = makeTriggers(10);
  const out = applyFilterAndSlice(corpus, {
    kind: 'triggers',
    instance: 'acme',
    cachedAt: 'snap-1',
    limit: 999999,
  });
  // Should accept (cap) but not error.
  assert.equal(out.count, 10);
});

test('list-pagination: empty corpus returns empty page, no cursor', () => {
  const out = applyFilterAndSlice([], {
    kind: 'triggers',
    instance: 'acme',
    cachedAt: 'snap-1',
  });
  assert.equal(out.count, 0);
  assert.equal(out.total, 0);
  assert.equal(out.truncated, false);
  assert.equal(out.cursor, null);
});

test('skeleton registry: registers expected primary kinds', () => {
  const kinds = projectionRegistry.registeredSkeletonKinds();
  for (const k of ['triggers', 'macros', 'views', 'tickets', 'users', 'webhooks']) {
    assert.ok(kinds.includes(k), `expected skeleton for ${k}`);
  }
});

test('skeleton registry: triggers skeleton is exactly 4 fields', () => {
  const fields = projectionRegistry.skeletonFieldsFor('triggers');
  assert.deepEqual(fields, ['id', 'title', 'active', 'updated_at']);
});
