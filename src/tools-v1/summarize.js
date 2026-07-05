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
import { summarize } from '../lib/instance-summarizer.js';

/**
 * summarize_instance.
 *
 * One call, dashboard view of every config object's count + active/inactive
 * splits + a few headline metrics. Tolerates per-kind upstream errors so
 * plan-gated endpoints (e.g. routing on smaller plans) don't fail the whole
 * composite, those kinds are silently omitted from `counts` and noted in
 * `notes`.
 */

// Endpoint metadata for the kinds we summarise. Mirrors what each primitive
// `list_*` tool uses internally so the cache key matches and we share state.
const KIND_ENDPOINTS = {
  triggers: { path: '/triggers.json', itemsKey: 'triggers' },
  automations: { path: '/automations.json', itemsKey: 'automations' },
  macros: { path: '/macros.json', itemsKey: 'macros' },
  views: { path: '/views.json', itemsKey: 'views' },
  ticket_fields: { path: '/ticket_fields.json', itemsKey: 'ticket_fields' },
  ticket_forms: { path: '/ticket_forms.json', itemsKey: 'ticket_forms' },
  custom_statuses: { path: '/custom_statuses.json', itemsKey: 'custom_statuses' },
  trigger_categories: { path: '/trigger_categories.json', itemsKey: 'trigger_categories' },
  groups: { path: '/groups.json', itemsKey: 'groups' },
  custom_roles: { path: '/custom_roles.json', itemsKey: 'custom_roles' },
  brands: { path: '/brands.json', itemsKey: 'brands' },
  schedules: { path: '/business_hours/schedules.json', itemsKey: 'schedules' },
  sla_policies: { path: '/slas/policies.json', itemsKey: 'sla_policies' },
  locales: { path: '/locales.json', itemsKey: 'locales' },
  webhooks: { path: '/webhooks.json', itemsKey: 'webhooks' },
  dynamic_content: { path: '/dynamic_content/items.json', itemsKey: 'items' },
};

// Kinds the summariser cares about.
const KINDS = Object.keys(KIND_ENDPOINTS);

async function fetchKindList(client, cache, instance, kind, refresh) {
  const meta = KIND_ENDPOINTS[kind];
  // verbose=true so the cache shares state with verbose primitive list calls
  // and so we have everything the summariser needs (active/position/etc).
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

export const summarizeTools = [
  {
    name: 'summarize_instance',
    description:
      'One-call dashboard for a Zendesk instance, counts of every config object (active/inactive splits where applicable) plus headline metrics (oldest/newest trigger, biggest trigger category, deactivated-but-positioned triggers). **Run this first when picking up a new client engagement**, it primes the cache for everything that follows, so subsequent analyzer / audit calls are essentially free. Tolerates per-kind upstream errors (plan-gated endpoints don\'t fail the whole composite); failures are listed in `notes`.',
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

        const corpus = {};
        const notes = [];

        // Fan-out fetches concurrently. The HTTP client's per-instance
        // semaphore (default 5) keeps this within Zendesk's rate window.
        const results = await Promise.all(
          KINDS.map(async (kind) => {
            try {
              const items = await fetchKindList(client, cache, resolved, kind, refresh);
              return { kind, items };
            } catch (err) {
              return { kind, error: err };
            }
          }),
        );

        for (const r of results) {
          if (r.error) {
            const status = r.error?.http_status;
            const reason = status ? `http ${status}` : (r.error?.code || 'upstream_error');
            notes.push(`${r.kind} unavailable (${reason})`);
            continue;
          }
          corpus[r.kind] = r.items;
        }

        const summary = summarize(corpus);

        return asMcp(
          success(resolved, {
            instance: resolved,
            counts: summary.counts,
            headlines: summary.headlines,
            notes,
          }),
        );
      } catch (err) {
        return asMcp(fromError(err, resolved));
      }
    },
  },
];
