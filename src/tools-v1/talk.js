import { z } from 'zod';
import {
  getClientFactory,
  getCache,
  instanceSession,
} from '../lib/foundations.js';
import { ResourceCache } from '../lib/resource-cache.js';
import { success, fromError } from '../lib/response-envelope.js';
import { asMcp } from './meta.js';

const KIND = 'talk_stats';

export const talkTools = [
  {
    name: 'get_talk_stats',
    description:
      'Fetch the current account-overview snapshot for Zendesk Talk (voice channel), average wait/handle time, calls in queue, agents online. **Plan-gated** to instances with Talk enabled; degrades to a structured `upstream_error` envelope otherwise. Snapshot only, for historical voice analytics use the Zendesk Explore product directly.',
    schema: {
      instance: z
        .string()
        .optional()
        .describe('Override the sticky instance for this call'),
      refresh: z
        .boolean()
        .optional()
        .describe('Bypass cache and re-fetch from Zendesk'),
    },
    handler: async ({ instance, refresh = false } = {}) => {
      let resolved = null;
      try {
        resolved = instanceSession.resolve(instance);
        const factory = await getClientFactory();
        const client = factory.getClient(resolved);
        const cache = getCache();

        const key = ResourceCache.makeKey(resolved, KIND, 'all', true);
        if (refresh) cache.invalidate(resolved, [KIND]);

        const { value, fetched_at, cached_at } = await cache.getOrFetch(
          key,
          undefined,
          async () => {
            const body = await client.request(
              'GET',
              '/channels/voice/stats.json',
              {},
            );
            return body;
          },
        );

        return asMcp(success(resolved, value, { fetched_at, cached_at }));
      } catch (err) {
        return asMcp(fromError(err, resolved));
      }
    },
  },
];
