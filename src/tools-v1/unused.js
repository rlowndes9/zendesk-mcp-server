import { z } from 'zod';
import {
  getClientFactory,
  getCache,
  instanceSession,
} from '../lib/foundations.js';
import { PaginatedFetcher } from '../lib/paginated-fetcher.js';
import { ResourceCache } from '../lib/resource-cache.js';
import { success, fromError, error } from '../lib/response-envelope.js';
import { asMcp } from './meta.js';
import { detect } from '../lib/unused-detector.js';

/**
 * find_unused, composite over the existing list primitives.
 *
 * For macros and views we need verbose payloads (the thin projection
 * does not include usage_24h/usage_7d/usage_30d). The tool fetches
 * verbose=true (cached separately from the thin variant) and runs the
 * pure detector.
 *
 * For triggers and automations the detector returns "indeterminate"
 * regardless, see PRD.md user stories 24 and 25.
 */

const PATHS = {
  macros: { path: '/macros.json', itemsKey: 'macros' },
  views: { path: '/views.json', itemsKey: 'views' },
  triggers: { path: '/triggers.json', itemsKey: 'triggers' },
  automations: { path: '/automations.json', itemsKey: 'automations' },
};

export const unusedTools = [
  {
    name: 'find_unused',
    description:
      'Detect unused macros and views by reading Zendesk\'s `usage_30d` stats; returns confident verdicts only where data exists. **`kind: "triggers"` and `kind: "automations"` always return `indeterminate`**, firing data is not exposed by the Zendesk API on standard plans, so the tool refuses to guess. For trigger / automation cleanup, combine `find_trigger_conflicts`, `audit_trigger_health`, and `find_field_usage` / `find_group_usage` instead.',
    schema: {
      kind: z
        .enum(['macros', 'views', 'triggers', 'automations'])
        .describe('Resource kind to scan'),
      instance: z
        .string()
        .optional()
        .describe('Override the sticky instance for this call'),
      refresh: z
        .boolean()
        .optional()
        .describe('Bypass cache and re-fetch from Zendesk'),
    },
    handler: async ({ kind, instance, refresh = false } = {}) => {
      let resolved = null;
      try {
        resolved = instanceSession.resolve(instance);
        const route = PATHS[kind];
        if (!route) {
          return asMcp(
            error(
              resolved,
              'bad_request',
              `Unsupported kind "${kind}". Expected macros|views|triggers|automations.`,
            ),
          );
        }

        const factory = await getClientFactory();
        const client = factory.getClient(resolved);
        const cache = getCache();

        // Always verbose, detector needs usage_30d on payloads.
        const verbose = true;
        const key = ResourceCache.makeKey(resolved, kind, 'all', verbose);
        if (refresh) cache.invalidate(resolved, [kind]);

        const { value, fetched_at, cached_at } = await cache.getOrFetch(
          key,
          undefined,
          async () => {
            const result = await PaginatedFetcher.fetchAll(client, route.path, {
              itemsKey: route.itemsKey,
              perPage: 100,
              mode: 'auto',
            });
            return { items: result.items };
          },
        );

        const results = detect(kind, value.items);
        let unused_count = 0;
        let used_count = 0;
        let indeterminate_count = 0;
        for (const r of results) {
          if (r.status === 'unused') unused_count += 1;
          else if (r.status === 'used') used_count += 1;
          else indeterminate_count += 1;
        }

        return asMcp(
          success(
            resolved,
            { results, unused_count, used_count, indeterminate_count },
            { fetched_at, cached_at },
          ),
        );
      } catch (err) {
        return asMcp(fromError(err, resolved));
      }
    },
  },
];
