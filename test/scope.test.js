import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCOPES,
  TOOL_REQUIRED_SCOPE,
  getRequiredScope,
  scopeAllowsTool,
  normaliseScope,
  defaultScopeForEnv,
  redactAuditCommentBodies,
} from '../src/lib/scope.js';

test('SCOPES: contains the three documented levels', () => {
  assert.deepEqual(SCOPES, ['config', 'config_plus_audits', 'full']);
});

test('getRequiredScope: returns config for unknown tool names', () => {
  assert.equal(getRequiredScope('list_triggers'), 'config');
  assert.equal(getRequiredScope('summarize_instance'), 'config');
  assert.equal(getRequiredScope('whatever_does_not_exist'), 'config');
});

test('getRequiredScope: returns config_plus_audits for audit tools', () => {
  assert.equal(getRequiredScope('get_ticket_audits'), 'config_plus_audits');
  assert.equal(getRequiredScope('get_ticket_metrics'), 'config_plus_audits');
});

test('getRequiredScope: returns full for ticket / user / org tools', () => {
  assert.equal(getRequiredScope('list_tickets'), 'full');
  assert.equal(getRequiredScope('get_ticket'), 'full');
  assert.equal(getRequiredScope('get_ticket_comments'), 'full');
  assert.equal(getRequiredScope('list_side_conversations'), 'full');
  assert.equal(getRequiredScope('list_chats'), 'full');
  assert.equal(getRequiredScope('list_users'), 'full');
  assert.equal(getRequiredScope('get_user'), 'full');
  assert.equal(getRequiredScope('list_organizations'), 'full');
  assert.equal(getRequiredScope('get_organization'), 'full');
  assert.equal(getRequiredScope('search'), 'full');
});

test('scopeAllowsTool: monotonic, higher instance scope allows everything below', () => {
  assert.equal(scopeAllowsTool('full', 'config'), true);
  assert.equal(scopeAllowsTool('full', 'config_plus_audits'), true);
  assert.equal(scopeAllowsTool('full', 'full'), true);

  assert.equal(scopeAllowsTool('config_plus_audits', 'config'), true);
  assert.equal(scopeAllowsTool('config_plus_audits', 'config_plus_audits'), true);
  assert.equal(scopeAllowsTool('config_plus_audits', 'full'), false);

  assert.equal(scopeAllowsTool('config', 'config'), true);
  assert.equal(scopeAllowsTool('config', 'config_plus_audits'), false);
  assert.equal(scopeAllowsTool('config', 'full'), false);
});

test('scopeAllowsTool: rejects unknown scope strings', () => {
  assert.equal(scopeAllowsTool('hacker', 'config'), false);
  assert.equal(scopeAllowsTool('config', 'hacker'), false);
  assert.equal(scopeAllowsTool(null, 'config'), false);
});

test('normaliseScope: accepts canonical and forgiving forms', () => {
  assert.equal(normaliseScope('config'), 'config');
  assert.equal(normaliseScope('CONFIG'), 'config');
  assert.equal(normaliseScope('config_plus_audits'), 'config_plus_audits');
  assert.equal(normaliseScope('Config Plus Audits'), 'config_plus_audits');
  assert.equal(normaliseScope('config-plus-audits'), 'config_plus_audits');
  assert.equal(normaliseScope('full'), 'full');
});

test('normaliseScope: rejects unknown values', () => {
  assert.equal(normaliseScope('open'), null);
  assert.equal(normaliseScope(''), null);
  assert.equal(normaliseScope(null), null);
  assert.equal(normaliseScope(42), null);
});

test('defaultScopeForEnv: prod gets config; sandbox gets full', () => {
  assert.equal(defaultScopeForEnv('prod'), 'config');
  assert.equal(defaultScopeForEnv('sandbox'), 'full');
  assert.equal(defaultScopeForEnv(undefined), 'config');
});

test('redactAuditCommentBodies: strips body fields from Comment events', () => {
  const audits = [
    {
      id: 1,
      ticket_id: 100,
      author_id: 5,
      events: [
        { type: 'Change', field_name: 'group_id', previous_value: '1', value: '2' },
        {
          type: 'Comment',
          body: 'I cannot log in',
          html_body: '<p>I cannot log in</p>',
          plain_body: 'I cannot log in',
          public: true,
          author_id: 99,
        },
      ],
    },
  ];
  const result = redactAuditCommentBodies(audits);
  assert.equal(result.length, 1);
  const events = result[0].events;
  assert.equal(events[0].type, 'Change');
  assert.equal(events[0].field_name, 'group_id');
  assert.equal(events[0].value, '2');
  assert.equal(events[1].type, 'Comment');
  assert.equal(events[1].public, true);
  assert.equal(events[1].author_id, 99);
  assert.equal(events[1].redacted, true);
  assert.equal(events[1].body, undefined);
  assert.equal(events[1].html_body, undefined);
  assert.equal(events[1].plain_body, undefined);
});

test('redactAuditCommentBodies: preserves Change-event values (these are NOT customer content)', () => {
  const audits = [
    {
      id: 1,
      events: [
        { type: 'Change', field_name: 'status', previous_value: 'open', value: 'solved' },
        { type: 'Change', field_name: 'assignee_id', previous_value: null, value: 42 },
      ],
    },
  ];
  const result = redactAuditCommentBodies(audits);
  assert.deepEqual(result[0].events, audits[0].events);
});

test('redactAuditCommentBodies: tolerates missing / malformed input', () => {
  assert.equal(redactAuditCommentBodies(null), null);
  assert.equal(redactAuditCommentBodies(undefined), undefined);
  assert.deepEqual(redactAuditCommentBodies([]), []);
  // Audit without events array, passes through unchanged.
  assert.deepEqual(
    redactAuditCommentBodies([{ id: 1, ticket_id: 7 }]),
    [{ id: 1, ticket_id: 7 }],
  );
});

test('redactAuditCommentBodies: preserves top-level audit metadata (rule attribution)', () => {
  const audits = [
    {
      id: 1,
      ticket_id: 100,
      created_at: '2026-01-01T00:00:00Z',
      author_id: 5,
      via: { channel: 'rule', source: { rel: 'trigger', id: 200, title: 'Auto-spam' } },
      events: [{ type: 'Comment', body: 'PII here', plain_body: 'PII here' }],
    },
  ];
  const result = redactAuditCommentBodies(audits);
  assert.equal(result[0].id, 1);
  assert.equal(result[0].ticket_id, 100);
  assert.equal(result[0].created_at, '2026-01-01T00:00:00Z');
  assert.equal(result[0].author_id, 5);
  assert.deepEqual(result[0].via, audits[0].via);
});

test('redactAuditCommentBodies: is non-mutating (input unchanged)', () => {
  const audits = [
    {
      events: [{ type: 'Comment', body: 'secret', plain_body: 'secret' }],
    },
  ];
  const original = JSON.parse(JSON.stringify(audits));
  redactAuditCommentBodies(audits);
  assert.deepEqual(audits, original);
});

test('TOOL_REQUIRED_SCOPE: every tagged tool maps to a known scope', () => {
  for (const [tool, scope] of Object.entries(TOOL_REQUIRED_SCOPE)) {
    assert.ok(SCOPES.includes(scope), `${tool} → ${scope} not in SCOPES`);
  }
});
