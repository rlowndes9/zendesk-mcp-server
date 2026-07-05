import { z } from 'zod';
import {
  getClientFactory,
  getCache,
  instanceSession,
  projectionRegistry,
  getInstanceScope,
} from '../lib/foundations.js';
import { ResourceCache } from '../lib/resource-cache.js';
import {
  LIST_PAGINATION_SCHEMA,
  fetchAndSlice,
  applyFilterAndSlice,
  fetchCorpus,
} from '../lib/list-pagination.js';
import { success, error, fromError } from '../lib/response-envelope.js';
import { redactAuditCommentBodies } from '../lib/scope.js';
import { asMcp } from './meta.js';

const KIND = 'tickets';
const COMMENTS_KIND = 'ticket_comments';
const AUDITS_KIND = 'ticket_audits';
const SIDE_CONVERSATIONS_KIND = 'side_conversations';
const METRICS_KIND = 'ticket_metrics';

/**
 * Internal: fetch (and cache) the full raw comments corpus for a ticket.
 * The cache is keyed under the verbose path so the inline-sideload caller
 * (get_ticket include_comments) and the paginated standalone tool
 * (get_ticket_comments) share a single corpus entry.
 */
async function fetchTicketCommentsCorpus({ client, cache, resolved, id, refresh }) {
  return fetchCorpus({
    client,
    cache,
    instance: resolved,
    kind: COMMENTS_KIND,
    queryHash: `ticket:${id}`,
    refresh,
    path: `/tickets/${encodeURIComponent(id)}/comments.json`,
    itemsKey: 'comments',
  });
}

async function fetchTicketAuditsCorpus({ client, cache, resolved, id, refresh }) {
  return fetchCorpus({
    client,
    cache,
    instance: resolved,
    kind: AUDITS_KIND,
    queryHash: `ticket:${id}`,
    refresh,
    path: `/tickets/${encodeURIComponent(id)}/audits.json`,
    itemsKey: 'audits',
  });
}

/**
 * Apply server-side audit filters: `since` (drop audits older than ts) and
 * `event_types` (drop events not in the list; drop audits whose events
 * become empty). Returns a NEW array, the input corpus is not mutated.
 */
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

/**
 * Side conversations are a plan-gated feature. On instances without it, the
 * endpoint returns 404 (or 403). We surface that as a structured
 * upstream_error rather than a generic failure.
 */
function isSideConversationsPlanFailure(err) {
  if (!err) return false;
  const status = err.http_status;
  return status === 403 || status === 404;
}

export const ticketsTools = [
  {
    name: 'list_tickets',
    description:
      'Returns tickets as paginated skeletons (`id`, `title`, `active`, `updated_at`). Default `limit: 100`; pass `cursor`, `fields`, `filter`, or `verbose: true` for full bodies. **Scope-gated**, requires the instance to be configured at scope `config_plus_audits` or `full`; on `config` you get a `scope_blocked` envelope. **For specific lookups prefer `search`** (full Zendesk query syntax: `type:ticket status:open`), `list_tickets` over a busy instance pulls everything and is rarely what you want. For a single ticket\'s context use `get_ticket` with `include_comments` / `include_audits`.',
    schema: {
      instance: z
        .string()
        .optional()
        .describe('Override the sticky instance for this call'),
      verbose: z
        .boolean()
        .optional()
        .describe('Return full ticket objects instead of the thin projection'),
      refresh: z
        .boolean()
        .optional()
        .describe('Bypass cache and re-fetch from Zendesk'),
      ...LIST_PAGINATION_SCHEMA,
    },
    handler: async ({
      instance,
      verbose = false,
      refresh = false,
      limit,
      cursor,
      fields,
      filter,
    } = {}) => {
      let resolved = null;
      try {
        resolved = instanceSession.resolve(instance);
        const factory = await getClientFactory();
        const client = factory.getClient(resolved);
        const cache = getCache();
        const { value, fetched_at, cached_at } = await fetchAndSlice({
          client,
          cache,
          instance: resolved,
          kind: KIND,
          queryHash: 'all',
          refresh,
          limit,
          cursor,
          fields,
          verbose,
          filter,
          path: '/tickets.json',
          itemsKey: 'tickets',
        });

        return asMcp(success(resolved, value, { fetched_at, cached_at }));
      } catch (err) {
        return asMcp(fromError(err, resolved));
      }
    },
  },
  {
    name: 'get_ticket',
    description:
      'Fetch one ticket by ID; optionally inline its `include_comments` thread and/or `include_audits` history in the same call. **Scope-gated** (`config_plus_audits` or `full`); blocked calls return `scope_blocked`. Use the inline includes when you need conversational context, they save a round-trip vs. calling `get_ticket_comments` / `get_ticket_audits` separately. For pure SLA / responsiveness numbers, `get_ticket_metrics` is cheaper than parsing audits.',
    schema: {
      id: z.union([z.number(), z.string()]).describe('Ticket ID'),
      instance: z
        .string()
        .optional()
        .describe('Override the sticky instance for this call'),
      verbose: z
        .boolean()
        .optional()
        .describe(
          'Return full objects (ticket, comments, audits) instead of thin projections. Affects sideloaded comments/audits when included.',
        ),
      include_comments: z
        .boolean()
        .optional()
        .describe('Include the ticket comment thread inline under data.comments'),
      include_audits: z
        .boolean()
        .optional()
        .describe('Include the ticket audit history inline under data.audits'),
    },
    handler: async ({
      id,
      instance,
      verbose = false,
      include_comments = false,
      include_audits = false,
    } = {}) => {
      let resolved = null;
      try {
        resolved = instanceSession.resolve(instance);
        const factory = await getClientFactory();
        const client = factory.getClient(resolved);
        const cache = getCache();

        const key = ResourceCache.makeKey(resolved, KIND, `id:${id}`, true);
        const ticketEntry = await cache.getOrFetch(
          key,
          undefined,
          async () => {
            const body = await client.request(
              'GET',
              `/tickets/${encodeURIComponent(id)}.json`,
              {},
            );
            return body.ticket;
          },
        );

        // Backwards-compatible: when neither flag set, return ticket as before.
        if (!include_comments && !include_audits) {
          return asMcp(
            success(resolved, ticketEntry.value, {
              fetched_at: ticketEntry.fetched_at,
              cached_at: ticketEntry.cached_at,
            }),
          );
        }

        const data = { ticket: ticketEntry.value };
        // Track the oldest fetched_at and the newest cached_at across the
        // ticket + any sideloads so the envelope reflects the freshest miss.
        let oldestFetchedAt = ticketEntry.fetched_at;
        let newestCachedAt = ticketEntry.cached_at;

        if (include_comments) {
          const corpus = await fetchTicketCommentsCorpus({
            client,
            cache,
            resolved,
            id,
            refresh: false,
          });
          const items = verbose
            ? corpus.items
            : projectionRegistry.projectMany(COMMENTS_KIND, corpus.items);
          data.comments = {
            ticket_id: typeof id === 'number' ? id : Number(id) || id,
            count: items.length,
            truncated: false,
            cursor: null,
            items,
          };
          if (corpus.fetched_at < oldestFetchedAt) {
            oldestFetchedAt = corpus.fetched_at;
          }
          // If any sideload was a fresh miss, surface that.
          if (corpus.cached_at === null) newestCachedAt = null;
        }

        if (include_audits) {
          const corpus = await fetchTicketAuditsCorpus({
            client,
            cache,
            resolved,
            id,
            refresh: false,
          });
          const items = verbose
            ? corpus.items
            : projectionRegistry.projectMany(AUDITS_KIND, corpus.items);
          data.audits = {
            ticket_id: typeof id === 'number' ? id : Number(id) || id,
            count: items.length,
            truncated: false,
            cursor: null,
            items,
          };
          if (corpus.fetched_at < oldestFetchedAt) {
            oldestFetchedAt = corpus.fetched_at;
          }
          if (corpus.cached_at === null) newestCachedAt = null;
        }

        return asMcp(
          success(resolved, data, {
            fetched_at: oldestFetchedAt,
            cached_at: newestCachedAt,
          }),
        );
      } catch (err) {
        return asMcp(fromError(err, resolved));
      }
    },
  },
  {
    name: 'get_ticket_comments',
    description:
      'Return the comment thread for one ticket as paginated skeletons (`id`, `type`, `author_id`, `body`, `html_body`, `public`, `created_at`). **Scope-gated** (`config_plus_audits` or `full`). Pass `verbose: true` for via-channel info and attachments. For "what changed on this ticket and why?" use `get_ticket_audits` instead, comments only carry the textual conversation, audits carry rule attribution.',
    schema: {
      id: z.union([z.number(), z.string()]).describe('Ticket ID'),
      instance: z
        .string()
        .optional()
        .describe('Override the sticky instance for this call'),
      verbose: z
        .boolean()
        .optional()
        .describe('Return full comment objects instead of the thin projection'),
      refresh: z
        .boolean()
        .optional()
        .describe('Bypass cache and re-fetch from Zendesk'),
      ...LIST_PAGINATION_SCHEMA,
    },
    handler: async ({
      id,
      instance,
      verbose = false,
      refresh = false,
      limit,
      cursor,
      fields,
      filter,
    } = {}) => {
      let resolved = null;
      try {
        resolved = instanceSession.resolve(instance);
        const factory = await getClientFactory();
        const client = factory.getClient(resolved);
        const cache = getCache();

        const corpus = await fetchTicketCommentsCorpus({
          client,
          cache,
          resolved,
          id,
          refresh,
        });
        const sliced = applyFilterAndSlice(corpus.items, {
          filter,
          limit,
          cursor,
          fields,
          verbose,
          kind: COMMENTS_KIND,
          instance: resolved,
          queryHash: `ticket:${id}`,
          cachedAt: corpus.fetched_at,
        });
        const value = {
          ticket_id: typeof id === 'number' ? id : Number(id) || id,
          ...sliced,
        };

        return asMcp(
          success(resolved, value, {
            fetched_at: corpus.fetched_at,
            cached_at: corpus.cached_at,
          }),
        );
      } catch (err) {
        return asMcp(fromError(err, resolved));
      }
    },
  },
  {
    name: 'get_ticket_audits',
    description:
      'Returns the audit history for a ticket, every state change with rule attribution and event timestamps. Defaults to `limit: 100` events; pass `since` to bound by date, `event_types: ["Change"]` to skip Comment events entirely (much smaller response). **Scope-gated**, requires `config_plus_audits` or `full`; at `config_plus_audits` Comment-event bodies are auto-redacted. **Use this for forensic debugging** ("why did this macro send the ticket to the wrong group?"), `via.source` on each audit names the trigger / macro / app that made the change. For pure timing data, `get_ticket_metrics` is cheaper.',
    schema: {
      id: z.union([z.number(), z.string()]).describe('Ticket ID'),
      instance: z
        .string()
        .optional()
        .describe('Override the sticky instance for this call'),
      verbose: z
        .boolean()
        .optional()
        .describe('Return full audit objects instead of the thin projection'),
      refresh: z
        .boolean()
        .optional()
        .describe('Bypass cache and re-fetch from Zendesk'),
      limit: z
        .number()
        .int()
        .positive()
        .max(25000)
        .optional()
        .describe(
          'Max audit events to return. Default 100. Audits on noisy tickets can run to thousands of events.',
        ),
      cursor: z.string().optional(),
      since: z
        .string()
        .optional()
        .describe(
          'ISO timestamp. Only return audits with created_at >= since. Useful for "what changed today" queries.',
        ),
      event_types: z
        .array(z.string())
        .optional()
        .describe(
          'Filter audit.events to only these types. Common: ["Change"] to skip Comment events entirely. ["Change","Notification"] to include rule notifications.',
        ),
      fields: z.array(z.string()).optional(),
      filter: z.object({}).passthrough().optional(),
    },
    handler: async ({
      id,
      instance,
      verbose = false,
      refresh = false,
      limit,
      cursor,
      since,
      event_types,
      fields,
      filter,
    } = {}) => {
      let resolved = null;
      try {
        resolved = instanceSession.resolve(instance);
        const factory = await getClientFactory();
        const client = factory.getClient(resolved);
        const cache = getCache();

        const corpus = await fetchTicketAuditsCorpus({
          client,
          cache,
          resolved,
          id,
          refresh,
        });

        // Apply audit-specific filters at the corpus level, `since` drops
        // old audits; `event_types` narrows audit.events and discards audits
        // with no events left.
        const filtered = filterAudits(corpus.items, { since, event_types });

        const sliced = applyFilterAndSlice(filtered, {
          filter,
          limit,
          cursor,
          fields,
          verbose,
          kind: AUDITS_KIND,
          instance: resolved,
          queryHash: `ticket:${id}|since:${since || ''}|et:${(event_types || []).join(',')}`,
          cachedAt: corpus.fetched_at,
        });
        const value = {
          ticket_id: typeof id === 'number' ? id : Number(id) || id,
          ...sliced,
        };
        const fetched_at = corpus.fetched_at;
        const cached_at = corpus.cached_at;

        // At scope "config_plus_audits", redact Comment-event bodies so
        // forensic debugging works without exposing customer PII. At "full",
        // bodies pass through unchanged. (Cache stores the raw response;
        // redaction happens on each call so different scopes don't poison
        // one another.)
        const scope = await getInstanceScope(resolved);
        const redactedValue =
          scope === 'config_plus_audits'
            ? { ...value, items: redactAuditCommentBodies(value.items) }
            : value;

        return asMcp(success(resolved, redactedValue, { fetched_at, cached_at }));
      } catch (err) {
        return asMcp(fromError(err, resolved));
      }
    },
  },
  {
    name: 'list_side_conversations',
    description:
      'List side conversations (Collaboration add-on) attached to a ticket as paginated skeletons. **Plan-gated**, on instances without the Collaboration add-on the call degrades to a structured `upstream_error` envelope with the underlying http_status, not a thrown failure. Also **scope-gated** (`config_plus_audits` or `full`). Use to surface the parallel email/Slack thread on a ticket; for the main public conversation use `get_ticket_comments`.',
    schema: {
      ticket_id: z.union([z.number(), z.string()]).describe('Ticket ID'),
      instance: z
        .string()
        .optional()
        .describe('Override the sticky instance for this call'),
      verbose: z
        .boolean()
        .optional()
        .describe(
          'Return full side-conversation objects instead of the thin projection',
        ),
      refresh: z
        .boolean()
        .optional()
        .describe('Bypass cache and re-fetch from Zendesk'),
      ...LIST_PAGINATION_SCHEMA,
    },
    handler: async ({
      ticket_id,
      instance,
      verbose = false,
      refresh = false,
      limit,
      cursor,
      fields,
      filter,
    } = {}) => {
      let resolved = null;
      try {
        resolved = instanceSession.resolve(instance);
        const factory = await getClientFactory();
        const client = factory.getClient(resolved);
        const cache = getCache();

        try {
          const { value, fetched_at, cached_at } = await fetchAndSlice({
            client,
            cache,
            instance: resolved,
            kind: SIDE_CONVERSATIONS_KIND,
            queryHash: `ticket:${ticket_id}`,
            refresh,
            limit,
            cursor,
            fields,
            verbose,
            filter,
            // Side conversations endpoint is unsuffixed (no `.json`).
            path: `/tickets/${encodeURIComponent(ticket_id)}/side_conversations`,
            itemsKey: 'side_conversations',
            extra: {
              ticket_id:
                typeof ticket_id === 'number'
                  ? ticket_id
                  : Number(ticket_id) || ticket_id,
            },
          });
          return asMcp(success(resolved, value, { fetched_at, cached_at }));
        } catch (innerErr) {
          if (isSideConversationsPlanFailure(innerErr)) {
            return asMcp(
              error(
                resolved,
                'upstream_error',
                'side conversations unavailable on this plan',
                { http_status: innerErr.http_status },
              ),
            );
          }
          throw innerErr;
        }
      } catch (err) {
        return asMcp(fromError(err, resolved));
      }
    },
  },
  {
    name: 'get_ticket_metrics',
    description:
      'Fetch the `ticket_metric` record for one ticket, reply count, reply/resolution times, reopens, station counts, on-hold time. **Scope-gated** (`config_plus_audits` or `full`). **Use this for SLA / responsiveness questions; use `get_ticket_audits` for "why did this happen?"** Audits carry rule attribution and field-level changes; metrics carry only the timing aggregates and are much cheaper.',
    schema: {
      id: z.union([z.number(), z.string()]).describe('Ticket ID'),
      instance: z
        .string()
        .optional()
        .describe('Override the sticky instance for this call'),
    },
    handler: async ({ id, instance } = {}) => {
      let resolved = null;
      try {
        resolved = instanceSession.resolve(instance);
        const factory = await getClientFactory();
        const client = factory.getClient(resolved);
        const cache = getCache();

        const key = ResourceCache.makeKey(
          resolved,
          METRICS_KIND,
          `ticket:${id}`,
          true,
        );
        const { value, fetched_at, cached_at } = await cache.getOrFetch(
          key,
          undefined,
          async () => {
            const body = await client.request(
              'GET',
              `/tickets/${encodeURIComponent(id)}/metrics.json`,
              {},
            );
            return body.ticket_metric;
          },
        );

        return asMcp(success(resolved, value, { fetched_at, cached_at }));
      } catch (err) {
        return asMcp(fromError(err, resolved));
      }
    },
  },
];
