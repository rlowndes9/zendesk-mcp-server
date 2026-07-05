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

const KIND = 'users';

export const usersTools = [
  {
    name: 'list_users',
    description:
      'Returns users as paginated skeletons (`id`, `name`, `email`, `role`, `organization_id`, `active`, timestamps). Default `limit: 100`; pass `cursor`, `fields`, `filter`, or `verbose: true`. **Scope-gated**, requires `config_plus_audits` or `full`; on `config` returns `scope_blocked`. **For finding a specific user prefer `search`** (e.g. `type:user email:foo@bar.com`), full enumeration on a large customer base is rarely the right call. For an agent\'s SBR skill values, use `list_agent_skill_assignments`.',
    schema: {
      instance: z
        .string()
        .optional()
        .describe('Override the sticky instance for this call'),
      verbose: z
        .boolean()
        .optional()
        .describe('Return full user objects instead of the thin projection'),
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
          path: '/users.json',
          itemsKey: 'users',
        });

        return asMcp(success(resolved, value, { fetched_at, cached_at }));
      } catch (err) {
        return asMcp(fromError(err, resolved));
      }
    },
  },
  {
    name: 'get_user',
    description: 'Fetch one user by ID with full profile details. **Scope-gated** (`config_plus_audits` or `full`). For lookup by email or other criteria, use `search` with `type:user`.',
    schema: {
      id: z.union([z.number(), z.string()]).describe('User ID'),
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

        const key = ResourceCache.makeKey(resolved, KIND, `id:${id}`, true);
        const { value, fetched_at, cached_at } = await cache.getOrFetch(
          key,
          undefined,
          async () => {
            const body = await client.request(
              'GET',
              `/users/${encodeURIComponent(id)}.json`,
              {},
            );
            return body.user;
          },
        );

        return asMcp(success(resolved, value, { fetched_at, cached_at }));
      } catch (err) {
        return asMcp(fromError(err, resolved));
      }
    },
  },
];
