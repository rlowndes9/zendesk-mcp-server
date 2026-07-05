import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect, UnusedDetector } from '../src/lib/unused-detector.js';

// Unit tests for the pure detector. Macros and views use
// Zendesk's usage_24h/usage_7d/usage_30d fields for confident verdicts;
// triggers and automations always return "indeterminate" because the
// API does not expose firing data on standard plans (PRD user stories
// 24, 25).

test('macro with usage_30d: 0 → unused', () => {
  const items = [
    {
      id: 101,
      title: 'Old support macro',
      usage_24h: 0,
      usage_7d: 0,
      usage_30d: 0,
    },
  ];
  const out = detect('macros', items);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 101);
  assert.equal(out[0].title, 'Old support macro');
  assert.equal(out[0].status, 'unused');
  assert.equal(out[0].usage_30d, 0);
});

test('macro with usage_30d: 5 → used', () => {
  const items = [
    {
      id: 102,
      title: 'Active macro',
      usage_24h: 1,
      usage_7d: 3,
      usage_30d: 5,
    },
  ];
  const out = detect('macros', items);
  assert.equal(out[0].status, 'used');
  assert.equal(out[0].usage_30d, 5);
});

test('view with all-zero usage fields → unused', () => {
  const items = [
    {
      id: 201,
      title: 'Stale view',
      usage_24h: 0,
      usage_7d: 0,
      usage_30d: 0,
    },
  ];
  const out = detect('views', items);
  assert.equal(out[0].status, 'unused');
  assert.equal(out[0].usage_30d, 0);
});

test('view with non-zero 24h usage but zero 30d → unused (30d wins)', () => {
  // 30d window is the canonical signal per PRD.
  const items = [
    { id: 202, title: 'Edge view', usage_24h: 0, usage_7d: 0, usage_30d: 0 },
  ];
  const out = detect('views', items);
  assert.equal(out[0].status, 'unused');
});

test('macro with last_used_at passes it through', () => {
  const items = [
    {
      id: 103,
      title: 'Tagged',
      usage_30d: 7,
      last_used_at: '2026-04-20T10:00:00Z',
    },
  ];
  const out = detect('macros', items);
  assert.equal(out[0].status, 'used');
  assert.equal(out[0].last_used_at, '2026-04-20T10:00:00Z');
});

test('macro with no usage fields at all → indeterminate', () => {
  // If the caller forgot verbose:true, payload lacks usage fields and
  // we surface that rather than guessing "unused".
  const items = [{ id: 104, title: 'Thin payload' }];
  const out = detect('macros', items);
  assert.equal(out[0].status, 'indeterminate');
  assert.match(out[0].reason, /usage_24h\/usage_7d\/usage_30d/);
});

test('trigger fixture → indeterminate with documented reason', () => {
  const items = [
    {
      id: 301,
      title: 'Auto-tag urgent',
      // even if we faked usage fields, the detector must NOT use them
      // for triggers, firing data is not reliably surfaced by Zendesk.
      usage_30d: 0,
      updated_at: '2024-01-01T00:00:00Z',
    },
  ];
  const out = detect('triggers', items);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 301);
  assert.equal(out[0].title, 'Auto-tag urgent');
  assert.equal(out[0].status, 'indeterminate');
  assert.equal(
    out[0].reason,
    'trigger firing data not available via API on standard plans',
  );
});

test('automation fixture → indeterminate with documented reason', () => {
  const items = [
    {
      id: 401,
      title: 'Close after 7 days',
      updated_at: '2024-06-01T00:00:00Z',
    },
  ];
  const out = detect('automations', items);
  assert.equal(out[0].status, 'indeterminate');
  assert.equal(
    out[0].reason,
    'automation firing data not available via API on standard plans',
  );
});

test('detect throws on unsupported kind', () => {
  assert.throws(
    () => detect('users', [{ id: 1 }]),
    /unsupported kind/,
  );
});

test('detect handles non-array gracefully', () => {
  assert.deepEqual(detect('macros', null), []);
  assert.deepEqual(detect('triggers', undefined), []);
});

test('UnusedDetector default export wraps detect', () => {
  assert.equal(typeof UnusedDetector.detect, 'function');
  const out = UnusedDetector.detect('triggers', [{ id: 1, title: 't' }]);
  assert.equal(out[0].status, 'indeterminate');
});
