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
import { auditTagSprawl } from '../lib/audit-tag-sprawl.js';

/**
 * audit_tag_sprawl.
 *
 * Composes TagAnalyzer over the verbose triggers/automations/macros
 * corpus to produce a clustered tag-sprawl report. Cache keys here match
 * the verbose-list cache keys used by the primitive `list_*` tools so
 * back-to-back audits or audit-after-list don't double-fetch.
 *
 * Per-kind upstream errors are tolerated, rare for these three list
 * endpoints, but the audit continues with whatever kinds it could fetch
 * and adds a `notes` entry per missing kind.
 */

const KIND_ENDPOINTS = {
  triggers: { path: '/triggers.json', itemsKey: 'triggers' },
  automations: { path: '/automations.json', itemsKey: 'automations' },
  macros: { path: '/macros.json', itemsKey: 'macros' },
};

const KINDS = Object.keys(KIND_ENDPOINTS);

async function fetchKindList(client, cache, instance, kind, refresh) {
  const meta = KIND_ENDPOINTS[kind];
  // verbose=true so cache shares state with verbose primitive list calls.
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

export const auditTagSprawlTools = [
  {
    name: 'audit_tag_sprawl',
    description:
      'Composite tag-hygiene report: full inventory (per-tag where-used, dupe suspects, `set_only` flag), clustered groups of suspected duplicates (`vip` / `VIP` / `v_i_p` collapse together), `set_only` tags written but never read, and a top-N usage distribution. **The right starting point for tag-cleanup work**, bundles `list_tags_in_use` with clustering. For "which rules touch tag X?" use `find_triggers_by_tag` instead. Tolerates per-kind upstream errors with `notes`.',
    schema: {
      instance: z
        .string()
        .optional()
        .describe('Override the sticky instance for this call'),
      refresh: z
        .boolean()
        .optional()
        .describe('Bypass cache and re-fetch every kind from Zendesk'),
      top_n: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Cap on usage_distribution rows (default 25)'),
    },
    handler: async ({ instance, refresh = false, top_n } = {}) => {
      let resolved = null;
      try {
        resolved = instanceSession.resolve(instance);
        const factory = await getClientFactory();
        const client = factory.getClient(resolved);
        const cache = getCache();

        const corpus = {};
        const notes = [];

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

        const audit = auditTagSprawl(corpus, { topN: top_n });

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
