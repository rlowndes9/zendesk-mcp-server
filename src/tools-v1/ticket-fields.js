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

const KIND = 'ticket_fields';

export const ticketFieldsToolsV1 = [
  {
    name: 'list_ticket_fields',
    description:
      'Returns ticket fields (system + custom) as paginated skeletons (`id`, `type`, `key`, `title`, `active`, `updated_at`). Default `limit: 100`; pass `cursor`, `fields`, `filter`, or `verbose: true` for full bodies including dropdown `custom_field_options`. **For "is it safe to delete this field?" call `find_field_usage`**, it scans every rule and form for references with `why_matched` breadcrumbs. For a full field hygiene report, `audit_field_health` bundles unused / inactive-only / empty-options / not-on-any-form checks.',
    schema: {
      instance: z
        .string()
        .optional()
        .describe('Override the sticky instance for this call'),
      verbose: z
        .boolean()
        .optional()
        .describe('Return full ticket-field objects instead of the thin projection'),
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
          path: '/ticket_fields.json',
          itemsKey: 'ticket_fields',
        });

        return asMcp(success(resolved, value, { fetched_at, cached_at }));
      } catch (err) {
        return asMcp(fromError(err, resolved));
      }
    },
  },
  {
    name: 'get_ticket_field',
    description: 'Fetch one ticket field by ID with full body (dropdown options, regex, etc). For impact analysis before deletion, prefer `find_field_usage`.',
    schema: {
      id: z.union([z.number(), z.string()]).describe('Ticket field ID'),
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
              `/ticket_fields/${encodeURIComponent(id)}.json`,
              {},
            );
            return body.ticket_field;
          },
        );

        return asMcp(success(resolved, value, { fetched_at, cached_at }));
      } catch (err) {
        return asMcp(fromError(err, resolved));
      }
    },
  },
];
