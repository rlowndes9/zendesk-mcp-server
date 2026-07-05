import { z } from 'zod';
import {
  getClientFactory,
  getCache,
  instanceSession,
} from '../lib/foundations.js';
import { ResourceCache } from '../lib/resource-cache.js';
import {
  LIST_PAGINATION_SCHEMA,
  fetchAndSlice,
} from '../lib/list-pagination.js';
import { success, fromError } from '../lib/response-envelope.js';
import { asMcp } from './meta.js';

const KIND = 'triggers';

export const triggersTools = [
  {
    name: 'list_triggers',
    description:
      'Returns triggers as paginated skeletons (`id`, `title`, `active`, `updated_at`). Default `limit: 100`; pass `cursor` to walk pages, `fields` to project additional columns, `filter` for active/category/title-contains/updated-since, or `verbose: true` for full bodies. **For "which triggers do X?" questions prefer `find_triggers_by_tag` / `find_triggers_by_field` / `find_trigger_conflicts`**, they filter inside conditions and actions server-side and return only the matches with `why_matched` breadcrumbs. `list_triggers` without a filter on instances with thousands of triggers can be slow on first call (cold cache); subsequent calls slice from the cache and are near-instant.',
    schema: {
      instance: z
        .string()
        .optional()
        .describe('Override the sticky instance for this call'),
      verbose: z
        .boolean()
        .optional()
        .describe('Return full trigger objects instead of the thin projection'),
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
          path: '/triggers.json',
          itemsKey: 'triggers',
        });
        return asMcp(success(resolved, value, { fetched_at, cached_at }));
      } catch (err) {
        return asMcp(fromError(err, resolved));
      }
    },
  },
  {
    name: 'get_trigger',
    description: 'Fetch one trigger by ID with full conditions and actions. Use after `list_triggers` / `find_triggers_by_*` to inspect a specific rule\'s body. For health audits over the whole trigger set, prefer `audit_trigger_health`.',
    schema: {
      id: z.union([z.number(), z.string()]).describe('Trigger ID'),
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
          KIND,
          `id:${id}`,
          true,
        );
        const { value, fetched_at, cached_at } = await cache.getOrFetch(
          key,
          undefined,
          async () => {
            const body = await client.request(
              'GET',
              `/triggers/${encodeURIComponent(id)}.json`,
              {},
            );
            return body.trigger;
          },
        );

        return asMcp(success(resolved, value, { fetched_at, cached_at }));
      } catch (err) {
        return asMcp(fromError(err, resolved));
      }
    },
  },
];
