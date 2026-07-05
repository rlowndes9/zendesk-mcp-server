/**
 * Per-instance "scope" gates which tools the agent can actually invoke
 * against a given Zendesk instance, and how much customer content the MCP
 * is allowed to surface. Three levels:
 *
 *   - "config"            , config audit only. Triggers, macros, fields,
 *                            forms, brands, schedules, SLA policies, etc.,
 *                            plus all analyzers and audit composites.
 *                            NO tickets, users, organizations, search,
 *                            chats, side conversations. Customer PII
 *                            cannot reach the agent at all.
 *
 *   - "config_plus_audits", adds get_ticket_audits and get_ticket_metrics
 *                            so you can debug "why didn't this macro fire"
 *                            and "why did this trigger overwrite the macro".
 *                            Comment bodies in audit events are redacted , 
 *                            you see the metadata (rule attribution, field
 *                            changes, who posted) but not the message text.
 *
 *   - "full"              , everything. List/get tickets, ticket comments,
 *                            users, organizations, search, chats, side
 *                            conversations. Customer content can reach the
 *                            agent.
 *
 * Default scope is `config` for prod instances and `full` for sandboxes
 * (convenience for self-test instances where there's no PII to protect).
 */

export const SCOPES = ['config', 'config_plus_audits', 'full'];

const SCOPE_RANK = {
  config: 1,
  config_plus_audits: 2,
  full: 3,
};

/**
 * Tool name → minimum scope required. Tools not listed default to "config"
 * (always available). Update this when adding new tools that touch ticket /
 * user / organization content.
 */
export const TOOL_REQUIRED_SCOPE = {
  // config_plus_audits, forensic debugging without comment bodies
  get_ticket_audits: 'config_plus_audits',
  get_ticket_metrics: 'config_plus_audits',

  // full, touches customer content (bodies, names, emails, search results)
  list_tickets: 'full',
  get_ticket: 'full',
  get_ticket_comments: 'full',
  list_side_conversations: 'full',
  list_chats: 'full',
  list_users: 'full',
  get_user: 'full',
  list_organizations: 'full',
  get_organization: 'full',
  search: 'full',
};

export function getRequiredScope(toolName) {
  return TOOL_REQUIRED_SCOPE[toolName] || 'config';
}

export function scopeAllowsTool(instanceScope, requiredScope) {
  const haveRank = SCOPE_RANK[instanceScope];
  const needRank = SCOPE_RANK[requiredScope];
  if (!Number.isFinite(haveRank) || !Number.isFinite(needRank)) return false;
  return haveRank >= needRank;
}

/**
 * Accept user-supplied scope strings; normalise to one of SCOPES or null.
 * Case-insensitive; spaces / hyphens / underscores treated equivalently.
 */
export function normaliseScope(input) {
  if (typeof input !== 'string') return null;
  const slug = input.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return SCOPES.includes(slug) ? slug : null;
}

/** Default scope when an instance doesn't specify one. */
export function defaultScopeForEnv(env) {
  return env === 'sandbox' ? 'full' : 'config';
}

/**
 * Redact comment bodies from an array of Zendesk ticket-audit objects so
 * forensic debugging works at scope "config_plus_audits" without exposing
 * customer PII.
 *
 * Strips `body`, `html_body`, `plain_body` from any audit event of type
 * "Comment". Marks those events with `redacted: true` so the agent knows.
 *
 * Change events (field transitions tied to rule attribution) and top-level
 * audit metadata (author_id, via.source, created_at) are preserved
 * unchanged, that's the forensic-relevant data.
 *
 * Pure function; non-mutating; tolerant of missing/malformed input.
 */
export function redactAuditCommentBodies(audits) {
  if (!Array.isArray(audits)) return audits;
  return audits.map((audit) => {
    if (!audit || !Array.isArray(audit.events)) return audit;
    const events = audit.events.map((ev) => {
      if (!ev || ev.type !== 'Comment') return ev;
      const { body, html_body, plain_body, ...rest } = ev;
      return { ...rest, redacted: true };
    });
    return { ...audit, events };
  });
}
