import { z } from 'zod';
import {
  getClientFactory,
  getCache,
  instanceSession,
} from '../lib/foundations.js';
import {
  LIST_PAGINATION_SCHEMA,
  fetchAndSlice,
} from '../lib/list-pagination.js';
import { success, fromError } from '../lib/response-envelope.js';
import { asMcp } from './meta.js';

const KIND = 'chats';

export const chatTools = [
  {
    name: 'list_chats',
    description:
      'List Zendesk Chat conversations as paginated items in their native shape (no skeleton projection, chat payloads are already compact). Default `limit: 100`; pass `cursor`, `fields`, or `filter`. **Plan-gated**, degrades to `upstream_error` on instances without the Chat add-on. **Scope-gated** when chats include user/ticket data (`config_plus_audits` or `full`).',
    schema: {
      instance: z
        .string()
        .optional()
        .describe('Override the sticky instance for this call'),
      refresh: z
        .boolean()
        .optional()
        .describe('Bypass cache and re-fetch from Zendesk'),
      ...LIST_PAGINATION_SCHEMA,
    },
    handler: async ({
      instance,
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

        // Chats have no skeleton/thin projection; treat as verbose so the
        // helper passes items through untouched (unless `fields:` is set).
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
          verbose: true,
          filter,
          path: '/chats.json',
          itemsKey: 'chats',
        });
        return asMcp(success(resolved, value, { fetched_at, cached_at }));
      } catch (err) {
        return asMcp(fromError(err, resolved));
      }
    },
  },
];
