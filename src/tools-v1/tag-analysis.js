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
import { inventory } from '../lib/tag-analyzer.js';

/**
 * Fetch the verbose list for a given corpus kind through the shared
 * ResourceCache. Cache key shape mirrors what list_*(verbose: true) tools
 * produce so this re-uses any in-memory entries the user has already
 * populated by listing the resources elsewhere in the session.
 */
async function fetchCorpusKind(client, cache, instance, kind, endpoint, itemsKey) {
  const key = ResourceCache.makeKey(instance, kind, 'all', true);
  const result = await cache.getOrFetch(key, undefined, async () => {
    const r = await PaginatedFetcher.fetchAll(client, endpoint, {
      itemsKey,
      perPage: 100,
      mode: 'auto',
    });
    return {
      count: r.count,
      truncated: r.truncated,
      cursor: r.cursor,
      items: r.items,
    };
  });
  return {
    items: Array.isArray(result.value?.items) ? result.value.items : [],
    fetched_at: result.fetched_at,
    cached_at: result.cached_at,
  };
}

const TAG_CORPUS_SPECS = [
  { corpusKey: 'triggers', kind: 'triggers', endpoint: '/triggers.json', itemsKey: 'triggers' },
  {
    corpusKey: 'automations',
    kind: 'automations',
    endpoint: '/automations.json',
    itemsKey: 'automations',
  },
  { corpusKey: 'macros', kind: 'macros', endpoint: '/macros.json', itemsKey: 'macros' },
];

export const tagAnalysisTools = [
  {
    name: 'list_tags_in_use',
    description:
      'Inventory every tag referenced across triggers, automations, and macros, with where-used rows (`kind`, `id`, `title`, `mode`), suspected near-duplicates (case-insensitive, separator-stripped, Levenshtein-1), and a `set_only` flag for tags written but never read in conditions. Operates over the cached verbose corpus, no extra HTTP unless `refresh: true`. **For a full tag-sprawl audit (clusters of dupes, top-N usage distribution) call `audit_tag_sprawl`**, it bundles this analyzer with clustering. For "which rules touch one specific tag?" use `find_triggers_by_tag`.',
    schema: {
      instance: z
        .string()
        .optional()
        .describe('Override the sticky instance for this call'),
      refresh: z
        .boolean()
        .optional()
        .describe('Bypass cache and re-fetch the corpus from Zendesk'),
    },
    handler: async ({ instance, refresh = false } = {}) => {
      let resolved = null;
      try {
        resolved = instanceSession.resolve(instance);
        const factory = await getClientFactory();
        const client = factory.getClient(resolved);
        const cache = getCache();

        if (refresh) {
          cache.invalidate(resolved, TAG_CORPUS_SPECS.map((s) => s.kind));
        }

        const corpus = {};
        let earliestFetched = null;
        let allCached = true;
        for (const spec of TAG_CORPUS_SPECS) {
          const { items, fetched_at, cached_at } = await fetchCorpusKind(
            client,
            cache,
            resolved,
            spec.kind,
            spec.endpoint,
            spec.itemsKey,
          );
          corpus[spec.corpusKey] = items;
          if (!earliestFetched || (fetched_at && fetched_at < earliestFetched)) {
            earliestFetched = fetched_at;
          }
          if (cached_at === null) allCached = false;
        }

        const tags = inventory(corpus);
        const set_only_count = tags.filter((t) => t.set_only).length;
        const dupe_suspect_count = tags.filter(
          (t) => t.dupe_suspects.length > 0,
        ).length;

        return asMcp(
          success(
            resolved,
            {
              tags,
              tag_count: tags.length,
              set_only_count,
              dupe_suspect_count,
            },
            {
              fetched_at: earliestFetched,
              cached_at: allCached ? new Date().toISOString() : null,
            },
          ),
        );
      } catch (err) {
        return asMcp(fromError(err, resolved));
      }
    },
  },
];
