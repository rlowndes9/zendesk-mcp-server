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

const KIND = 'webhooks';
const INVOCATIONS_KIND = 'webhook_invocations';

// NOTE on endpoint convention:
// The modern Zendesk Webhooks API is hosted at `/api/v2/webhooks` (no `.json`
// suffix), it's a newer API and breaks from the legacy `.json` convention.
// However, in practice the platform tolerates the `.json` suffix on most
// accounts. We follow the documented convention here (no `.json`) which is
// the path that works on all current Zendesk plans.
const WEBHOOKS_PATH = '/webhooks';

export const webhooksTools = [
  {
    name: 'list_webhooks',
    description:
      'Returns webhooks (the modern outbound integration mechanism) as paginated skeletons (`id`, `name`, `status`, `endpoint`, `updated_at`). Default `limit: 100`; pass `cursor`, `fields`, `filter`, or `verbose: true`. **For per-webhook delivery history use `list_webhook_invocations`** with a `webhook_id`, that\'s where you\'ll find request/response timing and HTTP status. `list_targets` is the legacy equivalent, most modern instances should be on webhooks.',
    schema: {
      instance: z
        .string()
        .optional()
        .describe('Override the sticky instance for this call'),
      verbose: z
        .boolean()
        .optional()
        .describe('Return full webhook objects instead of the thin projection'),
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
          path: WEBHOOKS_PATH,
          itemsKey: 'webhooks',
        });
        return asMcp(success(resolved, value, { fetched_at, cached_at }));
      } catch (err) {
        return asMcp(fromError(err, resolved));
      }
    },
  },
  {
    name: 'get_webhook',
    description: 'Fetch one webhook by ID with full body (auth, signing key, subscriptions). For delivery history, use `list_webhook_invocations`.',
    schema: {
      id: z.union([z.number(), z.string()]).describe('Webhook ID'),
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
              `${WEBHOOKS_PATH}/${encodeURIComponent(id)}`,
              {},
            );
            return body.webhook;
          },
        );

        return asMcp(success(resolved, value, { fetched_at, cached_at }));
      } catch (err) {
        return asMcp(fromError(err, resolved));
      }
    },
  },
  {
    name: 'list_webhook_invocations',
    description:
      'Returns the delivery history for one webhook, every fire with `http_status`, request/response timing, and outcome. Default `limit: 100`; pass `cursor`, `fields`, `filter`. **The right tool for "is this webhook actually working?"**, failures and slow responses surface here. For instance-wide configuration changes (not webhook deliveries), use `list_audit_logs`.',
    schema: {
      webhook_id: z
        .union([z.number(), z.string()])
        .describe('Webhook ID whose invocation history to fetch'),
      instance: z
        .string()
        .optional()
        .describe('Override the sticky instance for this call'),
      verbose: z
        .boolean()
        .optional()
        .describe('Return full invocation objects instead of the thin projection'),
      refresh: z
        .boolean()
        .optional()
        .describe('Bypass cache and re-fetch from Zendesk'),
      ...LIST_PAGINATION_SCHEMA,
    },
    handler: async ({
      webhook_id,
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
          kind: INVOCATIONS_KIND,
          queryHash: `webhook_id:${webhook_id}`,
          refresh,
          limit,
          cursor,
          fields,
          verbose,
          filter,
          path: `${WEBHOOKS_PATH}/${encodeURIComponent(webhook_id)}/invocations`,
          itemsKey: 'invocations',
          extra: { webhook_id },
        });
        return asMcp(success(resolved, value, { fetched_at, cached_at }));
      } catch (err) {
        return asMcp(fromError(err, resolved));
      }
    },
  },
];
