import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../src/lib/instance-summarizer.js';

function buildCorpus(overrides = {}) {
  return {
    triggers: [
      { id: 1, active: true, position: 1, category_id: 5, updated_at: '2024-01-15T10:00:00Z' },
      { id: 2, active: true, position: 2, category_id: 5, updated_at: '2026-04-20T10:00:00Z' },
      { id: 3, active: false, position: 3, category_id: 7, updated_at: '2018-03-01T10:00:00Z' },
      { id: 4, active: false, position: null, category_id: 5, updated_at: '2022-06-30T10:00:00Z' },
      { id: 5, active: true, position: 4, category_id: 7, updated_at: '2023-11-11T10:00:00Z' },
    ],
    automations: [
      { id: 10, active: true },
      { id: 11, active: false },
      { id: 12, active: true },
    ],
    macros: [
      { id: 20, active: true },
      { id: 21, active: true },
    ],
    views: [
      { id: 30, active: true },
      { id: 31, active: false },
    ],
    ticket_fields: [
      { id: 40, active: true },
      { id: 41, active: false },
    ],
    ticket_forms: [
      { id: 50, active: true, default: true },
      { id: 51, active: false, default: false },
    ],
    custom_statuses: [
      { id: 60, active: true },
      { id: 61, active: true },
      { id: 62, active: false },
    ],
    groups: [{ id: 70 }, { id: 71 }, { id: 72 }],
    custom_roles: [{ id: 80 }, { id: 81 }],
    brands: [
      { id: 90, active: true, default: true },
      { id: 91, active: true, default: false },
      { id: 92, active: false, default: false },
    ],
    schedules: [{ id: 100 }],
    sla_policies: [{ id: 110 }, { id: 111 }],
    locales: [{ id: 1, locale: 'en-US' }, { id: 2, locale: 'fr' }],
    webhooks: [
      { id: 120, active: true },
      { id: 121, active: false },
      { id: 122, active: true },
    ],
    dynamic_content: [{ id: 130 }, { id: 131 }],
    trigger_categories: [
      { id: 5, name: 'Routing' },
      { id: 7, name: 'Notifications' },
    ],
    ...overrides,
  };
}

test('summarize: active/inactive splits across active-aware kinds', () => {
  const out = summarize(buildCorpus());

  assert.deepEqual(out.counts.triggers, { total: 5, active: 3, inactive: 2 });
  assert.deepEqual(out.counts.automations, { total: 3, active: 2, inactive: 1 });
  assert.deepEqual(out.counts.macros, { total: 2, active: 2, inactive: 0 });
  assert.deepEqual(out.counts.views, { total: 2, active: 1, inactive: 1 });
  assert.deepEqual(out.counts.ticket_fields, { total: 2, active: 1, inactive: 1 });
  assert.deepEqual(out.counts.ticket_forms, { total: 2, active: 1, inactive: 1 });
  assert.deepEqual(out.counts.custom_statuses, { total: 3, active: 2, inactive: 1 });
  assert.deepEqual(out.counts.webhooks, { total: 3, active: 2, inactive: 1 });
});

test('summarize: total-only kinds report just total count', () => {
  const out = summarize(buildCorpus());
  assert.deepEqual(out.counts.groups, { total: 3 });
  assert.deepEqual(out.counts.custom_roles, { total: 2 });
  assert.deepEqual(out.counts.schedules, { total: 1 });
  assert.deepEqual(out.counts.sla_policies, { total: 2 });
  assert.deepEqual(out.counts.locales, { total: 2 });
  assert.deepEqual(out.counts.dynamic_content, { total: 2 });
  assert.deepEqual(out.counts.trigger_categories, { total: 2 });
});

test('summarize: brands report active, inactive, and default counts', () => {
  const out = summarize(buildCorpus());
  assert.deepEqual(out.counts.brands, { total: 3, active: 2, inactive: 1, default: 1 });
});

test('summarize: oldest/newest trigger updated_at are min/max from input', () => {
  const out = summarize(buildCorpus());
  assert.equal(out.headlines.oldest_trigger_updated_at, '2018-03-01T10:00:00Z');
  assert.equal(out.headlines.newest_trigger_updated_at, '2026-04-20T10:00:00Z');
});

test('summarize: biggest_trigger_category includes id, name, count when categories provided', () => {
  const out = summarize(buildCorpus());
  // category_id 5 has 3 triggers, category_id 7 has 2 triggers
  assert.deepEqual(out.headlines.biggest_trigger_category, {
    category_id: 5,
    name: 'Routing',
    count: 3,
  });
});

test('summarize: biggest_trigger_category falls back to id-only when categories absent', () => {
  const corpus = buildCorpus();
  delete corpus.trigger_categories;
  const out = summarize(corpus);
  assert.deepEqual(out.headlines.biggest_trigger_category, {
    category_id: 5,
    count: 3,
  });
  // trigger_categories absent should also be omitted from counts
  assert.equal(out.counts.trigger_categories, undefined);
});

test('summarize: deactivated_but_positioned_triggers, count and id list', () => {
  const out = summarize(buildCorpus());
  // trigger id 3 is the only one active=false with a positioned position; id 4 has position:null
  assert.deepEqual(out.headlines.deactivated_but_positioned_triggers, {
    count: 1,
    ids: [3],
  });
});

test('summarize: deactivated_but_positioned_triggers handles multiple matches', () => {
  const out = summarize({
    triggers: [
      { id: 1, active: false, position: 1 },
      { id: 2, active: false, position: 2 },
      { id: 3, active: true, position: 3 },
      { id: 4, active: false, position: null },
    ],
  });
  assert.deepEqual(out.headlines.deactivated_but_positioned_triggers, {
    count: 2,
    ids: [1, 2],
  });
});

test('summarize: missing kinds are silently omitted, no crash', () => {
  // Bare minimum corpus, only triggers
  const out = summarize({
    triggers: [
      { id: 1, active: true, position: 1, category_id: 5, updated_at: '2024-01-01T00:00:00Z' },
    ],
  });
  assert.ok(out.counts.triggers);
  // None of the other kinds should appear in counts
  assert.equal(out.counts.macros, undefined);
  assert.equal(out.counts.views, undefined);
  assert.equal(out.counts.brands, undefined);
  assert.equal(out.counts.groups, undefined);
  assert.equal(out.counts.webhooks, undefined);
});

test('summarize: empty corpus produces empty counts, null trigger headlines', () => {
  const out = summarize({});
  assert.deepEqual(out.counts, {});
  // headlines object exists but is empty (no triggers means no headlines computed)
  assert.deepEqual(out.headlines, {});
});

test('summarize: empty triggers array produces null oldest/newest and biggest', () => {
  const out = summarize({ triggers: [] });
  assert.deepEqual(out.counts.triggers, { total: 0, active: 0, inactive: 0 });
  assert.equal(out.headlines.oldest_trigger_updated_at, null);
  assert.equal(out.headlines.newest_trigger_updated_at, null);
  assert.equal(out.headlines.biggest_trigger_category, null);
  assert.deepEqual(out.headlines.deactivated_but_positioned_triggers, { count: 0, ids: [] });
});

test('summarize: tolerates list-envelope shape ({ items, count, ... })', () => {
  const out = summarize({
    triggers: {
      count: 1,
      items: [{ id: 1, active: true, position: 1, updated_at: '2025-01-01T00:00:00Z' }],
    },
    macros: { count: 0, items: [] },
  });
  assert.deepEqual(out.counts.triggers, { total: 1, active: 1, inactive: 0 });
  assert.deepEqual(out.counts.macros, { total: 0, active: 0, inactive: 0 });
});

test('summarize: items without `active` field do not contribute to active/inactive', () => {
  const out = summarize({
    triggers: [
      { id: 1, active: true, position: 1 },
      { id: 2, position: 2 }, // no active field
      { id: 3, active: false, position: 3 },
    ],
  });
  // total includes all 3, active=1, inactive=1
  assert.deepEqual(out.counts.triggers, { total: 3, active: 1, inactive: 1 });
});
