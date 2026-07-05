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

const KIND = 'search';

export const searchTools = [
  {
    name: 'search',
    description:
      'Run a Zendesk v2 Search query across tickets, users, organizations, and groups; returns mixed-type results in their native shape. Use the standard query syntax (e.g. `type:ticket status:open`, `type:user email:foo@bar.com`, `type:organization tags:vip`). **Always reach for this before `list_tickets` / `list_users` / `list_organizations`** when you\'re looking for specific records, the search index is much faster than enumeration. **Scope-gated** when results include tickets/users/orgs (`config_plus_audits` or `full`).',
    schema: {
      query: z
        .string()
        .min(1)
        .describe('Zendesk search query (e.g. "type:ticket status:open")'),
      sort_by: z.string().optional().describe('Field to sort by'),
      sort_order: z
        .enum(['asc', 'desc'])
        .optional()
        .describe('Sort order (asc or desc)'),
      instance: z
        .string()
        .optional()
        .describe('Override the sticky instance for this call'),
      refresh: z
        .boolean()
        .optional()
        .describe('Bypass cache and re-fetch from Zendesk'),
    },
    handler: async ({ query, sort_by, sort_order, instance, refresh = false } = {}) => {
      let resolved = null;
      try {
        resolved = instanceSession.resolve(instance);
        const factory = await getClientFactory();
        const client = factory.getClient(resolved);
        const cache = getCache();

        const queryHash = `q:${query}|sb:${sort_by ?? ''}|so:${sort_order ?? ''}`;
        // Search uses the canonical full payload, so verbose flag is irrelevant; key with true.
        const key = ResourceCache.makeKey(resolved, KIND, queryHash, true);

        if (refresh) cache.invalidate(resolved, [KIND]);

        const params = { query };
        if (sort_by) params.sort_by = sort_by;
        if (sort_order) params.sort_order = sort_order;

        const { value, fetched_at, cached_at } = await cache.getOrFetch(
          key,
          undefined,
          async () => {
            const result = await PaginatedFetcher.fetchAll(client, '/search.json', {
              itemsKey: 'results',
              perPage: 100,
              mode: 'auto',
              params,
            });
            return {
              count: result.count,
              truncated: result.truncated,
              cursor: result.cursor,
              items: result.items,
            };
          },
        );

        return asMcp(success(resolved, value, { fetched_at, cached_at }));
      } catch (err) {
        return asMcp(fromError(err, resolved));
      }
    },
  },
];
