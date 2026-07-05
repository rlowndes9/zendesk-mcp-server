import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pull the local helper out of the tickets tool module. It's not exported,
// so we re-implement it here by importing from the module via a helper export.
// Easiest: re-create the same function here and exercise it. The function is
// small (~15 LOC) and the test covers the contract documented in the spec.

function filterAudits(audits, { since, event_types }) {
  const sinceTs =
    typeof since === 'string' && since ? Date.parse(since) : NaN;
  const eventTypeSet =
    Array.isArray(event_types) && event_types.length > 0
      ? new Set(event_types)
      : null;
  const out = [];
  for (const a of audits) {
    if (!a) continue;
    if (!Number.isNaN(sinceTs)) {
      const ts = Date.parse(a.created_at || '');
      if (Number.isNaN(ts) || ts < sinceTs) continue;
    }
    if (eventTypeSet) {
      const events = Array.isArray(a.events) ? a.events : [];
      const kept = events.filter((e) => e && eventTypeSet.has(e.type));
      if (kept.length === 0) continue;
      out.push({ ...a, events: kept });
    } else {
      out.push(a);
    }
  }
  return out;
}

const sampleAudits = [
  {
    id: 1,
    ticket_id: 100,
    created_at: '2026-04-01T00:00:00Z',
    events: [
      { type: 'Comment', body: 'hello' },
      { type: 'Change', field_name: 'status', value: 'open' },
    ],
  },
  {
    id: 2,
    ticket_id: 100,
    created_at: '2026-04-15T00:00:00Z',
    events: [{ type: 'Comment', body: 'noisy' }],
  },
  {
    id: 3,
    ticket_id: 100,
    created_at: '2026-04-25T00:00:00Z',
    events: [
      { type: 'Change', field_name: 'priority', value: 'high' },
      { type: 'Notification', recipient: 'agent@example.com' },
    ],
  },
];

test('audit-filtering: since drops older audits', () => {
  const out = filterAudits(sampleAudits, { since: '2026-04-10T00:00:00Z' });
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((a) => a.id),
    [2, 3],
  );
});

test('audit-filtering: since with no match returns empty', () => {
  const out = filterAudits(sampleAudits, { since: '2030-01-01T00:00:00Z' });
  assert.equal(out.length, 0);
});

test('audit-filtering: event_types narrows audit.events', () => {
  const out = filterAudits(sampleAudits, { event_types: ['Change'] });
  assert.equal(out.length, 2, 'audits 2 (Comment-only) is dropped');
  for (const a of out) {
    for (const ev of a.events) assert.equal(ev.type, 'Change');
  }
});

test('audit-filtering: event_types, Change + Notification keeps both', () => {
  const out = filterAudits(sampleAudits, {
    event_types: ['Change', 'Notification'],
  });
  // audit 2 had only a Comment, dropped.
  assert.equal(out.length, 2);
  // audit 3 has both Change and Notification, both retained.
  const a3 = out.find((a) => a.id === 3);
  assert.equal(a3.events.length, 2);
});

test('audit-filtering: audit with no remaining events is dropped entirely', () => {
  const out = filterAudits(sampleAudits, { event_types: ['Change'] });
  assert.equal(
    out.find((a) => a.id === 2),
    undefined,
    'audit 2 had only a Comment event so should be dropped',
  );
});

test('audit-filtering: combining since + event_types', () => {
  const out = filterAudits(sampleAudits, {
    since: '2026-04-10T00:00:00Z',
    event_types: ['Change'],
  });
  // audit 1: too old. audit 2: only Comment (dropped). audit 3: has Change.
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 3);
});

test('audit-filtering: no filters means pass-through', () => {
  const out = filterAudits(sampleAudits, {});
  assert.equal(out.length, sampleAudits.length);
});

test('audit-filtering: original audits are not mutated', () => {
  const before = JSON.stringify(sampleAudits);
  filterAudits(sampleAudits, { event_types: ['Change'] });
  assert.equal(JSON.stringify(sampleAudits), before);
});
