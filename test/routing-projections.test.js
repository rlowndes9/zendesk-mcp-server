import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectionRegistry } from '../src/lib/projection-registry.js';

// Verify routing projections are registered and behave correctly.
// Projections are the single source of truth for what list_* returns
// thin-by-default; the analyzer/audit composites built on top of them depend
// on these field sets being stable.

test('ProjectionRegistry: routing_attributes thin projection', () => {
  const full = {
    id: 'attr-uuid-1',
    name: 'Skill',
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-02T00:00:00Z',
    description: 'a longer description',
    values_count: 12,
  };
  const thin = projectionRegistry.project('routing_attributes', full);
  assert.deepEqual(thin, {
    id: 'attr-uuid-1',
    name: 'Skill',
    created_at: '2026-04-01T00:00:00Z',
  });
});

test('ProjectionRegistry: routing_attribute_values thin projection', () => {
  const full = {
    id: 'val-uuid-1',
    attribute_id: 'attr-uuid-1',
    name: 'Spanish',
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-02T00:00:00Z',
    extra_field: 'should-be-stripped',
  };
  const thin = projectionRegistry.project('routing_attribute_values', full);
  assert.deepEqual(thin, {
    id: 'val-uuid-1',
    attribute_id: 'attr-uuid-1',
    name: 'Spanish',
    created_at: '2026-04-01T00:00:00Z',
  });
});

test('ProjectionRegistry: projectMany over routing values', () => {
  const items = [
    { id: 'a', attribute_id: 'x', name: 'one', created_at: 't', drop: 1 },
    { id: 'b', attribute_id: 'x', name: 'two', created_at: 't', drop: 2 },
  ];
  const thin = projectionRegistry.projectMany('routing_attribute_values', items);
  assert.equal(thin.length, 2);
  assert.deepEqual(Object.keys(thin[0]).sort(), [
    'attribute_id',
    'created_at',
    'id',
    'name',
  ]);
  assert.equal(thin[0].drop, undefined);
});
