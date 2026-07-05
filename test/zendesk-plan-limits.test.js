import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAN_LIMITS,
  PLAN_NAMES,
  normalisePlanName,
  categoriseEndpoint,
} from '../src/lib/zendesk-plan-limits.js';

test('PLAN_LIMITS: every plan has the three categories defined', () => {
  for (const plan of PLAN_NAMES) {
    const entry = PLAN_LIMITS[plan];
    assert.ok(entry, `plan ${plan} has limits`);
    assert.ok(Number.isFinite(entry.overall_per_min), `${plan}.overall_per_min`);
    assert.ok(Number.isFinite(entry.search_per_min), `${plan}.search_per_min`);
    assert.ok(Number.isFinite(entry.incremental_per_min), `${plan}.incremental_per_min`);
  }
});

test('PLAN_NAMES: covers the documented Suite tiers', () => {
  for (const expected of [
    'team',
    'growth',
    'professional',
    'enterprise',
    'enterprise_plus',
  ]) {
    assert.ok(PLAN_NAMES.includes(expected), `missing plan: ${expected}`);
  }
});

test('normalisePlanName: accepts canonical, spaced, hyphenated, mixed-case', () => {
  assert.equal(normalisePlanName('team'), 'team');
  assert.equal(normalisePlanName('Team'), 'team');
  assert.equal(normalisePlanName('Enterprise Plus'), 'enterprise_plus');
  assert.equal(normalisePlanName('enterprise-plus'), 'enterprise_plus');
  assert.equal(normalisePlanName('  ENTERPRISE_PLUS  '), 'enterprise_plus');
  assert.equal(normalisePlanName('PROFESSIONAL'), 'professional');
});

test('normalisePlanName: rejects unknown plans', () => {
  assert.equal(normalisePlanName('basic'), null);
  assert.equal(normalisePlanName('legacy'), null);
  assert.equal(normalisePlanName(''), null);
  assert.equal(normalisePlanName(null), null);
  assert.equal(normalisePlanName(undefined), null);
  assert.equal(normalisePlanName(42), null);
});

test('categoriseEndpoint: search endpoints', () => {
  assert.equal(categoriseEndpoint('/search.json'), 'search');
  assert.equal(categoriseEndpoint('search.json'), 'search');
  assert.equal(categoriseEndpoint('/search'), 'search');
});

test('categoriseEndpoint: incremental endpoints', () => {
  assert.equal(categoriseEndpoint('/incremental/tickets.json'), 'incremental');
  assert.equal(categoriseEndpoint('/incremental/users/cursor.json'), 'incremental');
  assert.equal(categoriseEndpoint('incremental/organizations.json'), 'incremental');
});

test('categoriseEndpoint: default for everything else', () => {
  assert.equal(categoriseEndpoint('/triggers.json'), 'default');
  assert.equal(categoriseEndpoint('/tickets.json'), 'default');
  assert.equal(categoriseEndpoint('/macros/12345.json'), 'default');
  assert.equal(categoriseEndpoint('/'), 'default');
  assert.equal(categoriseEndpoint(''), 'default');
});

test('categoriseEndpoint: tolerant of bad input', () => {
  assert.equal(categoriseEndpoint(undefined), 'default');
  assert.equal(categoriseEndpoint(null), 'default');
  assert.equal(categoriseEndpoint(42), 'default');
});

test('Plan limits monotonicity: bigger plans are not stricter than smaller ones', () => {
  // Sanity: enterprise_plus shouldn't be stricter than team on overall budget.
  assert.ok(
    PLAN_LIMITS.enterprise_plus.overall_per_min >= PLAN_LIMITS.team.overall_per_min,
  );
  assert.ok(
    PLAN_LIMITS.professional.overall_per_min >= PLAN_LIMITS.growth.overall_per_min,
  );
  assert.ok(
    PLAN_LIMITS.growth.overall_per_min >= PLAN_LIMITS.team.overall_per_min,
  );
});
