import { z } from 'zod';
import {
  getClientFactory,
  getCache,
  instanceSession,
} from '../lib/foundations.js';
import { PaginatedFetcher } from '../lib/paginated-fetcher.js';
import { ResourceCache } from '../lib/resource-cache.js';
import { success, fromError } from '../lib/response-envelope.js';
import { asMcp } from './meta.js';
import { auditTriggerHealth } from '../lib/audit-trigger-health.js';

/**
 * audit_trigger_health.
 *
 * Composes TriggerAnalyzer.findConflicts plus orphaned-reference
 * detection across groups, forms, ticket fields, and trigger categories.
 * Surfaces deactivated-but-referenced rules, ordering anomalies, and empty
 * rules.
 *
 * Always fetches verbose payloads, the audit needs trigger conditions and
 * actions (dropped by the thin trigger projection) and verbose payloads for
 * the support kinds. Cache keys here match the verbose-list cache keys used
 * by the primitive `list_*` tools, so two consecutive audits or an audit-
 * after-list don't double-fetch.
 *
 * `list_triggers` is fatal, without triggers there's nothing to audit.
 * Per-kind upstream errors on the support kinds (categories, groups,
 * fields, forms) are tolerated: the composite skips that orphan-class and
 * we add a `notes` entry per missing kind.
 */

const KIND_ENDPOINTS = {
  triggers: { path: '/triggers.json', itemsKey: 'triggers' },
  trigger_categories: { path: '/trigger_categories.json', itemsKey: 'trigger_categories' },
  groups: { path: '/groups.json', itemsKey: 'groups' },
  ticket_fields: { path: '/ticket_fields.json', itemsKey: 'ticket_fields' },
  ticket_forms: { path: '/ticket_forms.json', itemsKey: 'ticket_forms' },
};

const SUPPORT_KINDS = ['trigger_categories', 'groups', 'ticket_fields', 'ticket_forms'];

async function fetchKindList(client, cache, instance, kind, refresh) {
  const meta = KIND_ENDPOINTS[kind];
  const key = ResourceCache.makeKey(instance, kind, 'all', true);
  if (refresh) cache.invalidate(instance, [kind]);
  const { value } = await cache.getOrFetch(key, undefined, async () => {
    const result = await PaginatedFetcher.fetchAll(client, meta.path, {
      itemsKey: meta.itemsKey,
      perPage: 100,
      mode: 'auto',
    });
    return {
      count: result.count,
      truncated: result.truncated,
      cursor: result.cursor,
      items: result.items,
    };
  });
  return value.items || [];
}

export const auditTriggerHealthTools = [
  {
    name: 'audit_trigger_health',
    description:
      'Composite trigger-hygiene report: `conflicts` (overlapping preconditions with contradicting effects), `deactivated_but_referenced` (dead triggers still chained), `orphaned_references` (pointing at missing groups/forms/fields/categories), `ordering_anomalies` (inactive triggers in early slots, duplicate positions), and `empty_rules`. **The right starting point for trigger cleanup work**, bundles `find_trigger_conflicts` plus the orphan/order/empty checks in one call. Tolerates per-kind upstream errors on support kinds (notes listed in `notes`); a missing trigger list is fatal.',
    schema: {
      instance: z
        .string()
        .optional()
        .describe('Override the sticky instance for this call'),
      refresh: z
        .boolean()
        .optional()
        .describe('Bypass cache and re-fetch every kind from Zendesk'),
    },
    handler: async ({ instance, refresh = false } = {}) => {
      let resolved = null;
      try {
        resolved = instanceSession.resolve(instance);
        const factory = await getClientFactory();
        const client = factory.getClient(resolved);
        const cache = getCache();

        // Triggers are required, failure here is fatal.
        const triggers = await fetchKindList(client, cache, resolved, 'triggers', refresh);

        const corpus = { triggers };
        const notes = [];

        const supportResults = await Promise.all(
          SUPPORT_KINDS.map(async (kind) => {
            try {
              const items = await fetchKindList(client, cache, resolved, kind, refresh);
              return { kind, items };
            } catch (err) {
              return { kind, error: err };
            }
          }),
        );

        for (const r of supportResults) {
          if (r.error) {
            const status = r.error?.http_status;
            const reason = status ? `http ${status}` : (r.error?.code || 'upstream_error');
            notes.push(`${r.kind} unavailable (${reason}); skipping ${r.kind} orphan check`);
            continue;
          }
          corpus[r.kind] = r.items;
        }

        const audit = auditTriggerHealth(corpus);

        return asMcp(
          success(resolved, {
            instance: resolved,
            ...audit,
            notes,
          }),
        );
      } catch (err) {
        return asMcp(fromError(err, resolved));
      }
    },
  },
];
