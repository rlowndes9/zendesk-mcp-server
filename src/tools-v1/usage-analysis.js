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
import {
  findFieldUsage,
  findFormUsage,
  findGroupUsage,
} from '../lib/usage-analyzer.js';

/**
 * Fetch the verbose list for a given corpus kind, going through the same
 * ResourceCache the list_* tools use, so the analyzer reuses cached payloads
 * when possible. Cache key shape mirrors what list_triggers et al. produce:
 *   makeKey(instance, KIND, 'all', verbose=true)
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

const CORPUS_KIND_SPECS = {
  triggers: { kind: 'triggers', endpoint: '/triggers.json', itemsKey: 'triggers' },
  automations: {
    kind: 'automations',
    endpoint: '/automations.json',
    itemsKey: 'automations',
  },
  macros: { kind: 'macros', endpoint: '/macros.json', itemsKey: 'macros' },
  views: { kind: 'views', endpoint: '/views.json', itemsKey: 'views' },
  forms: {
    kind: 'ticket_forms',
    endpoint: '/ticket_forms.json',
    itemsKey: 'ticket_forms',
  },
  sla_policies: {
    kind: 'sla_policies',
    endpoint: '/slas/policies.json',
    itemsKey: 'sla_policies',
  },
};

/**
 * Build a `{ corpusKey: items[] }` object plus aggregate timestamps and
 * `scanned` counts.
 */
async function buildCorpus(client, cache, instance, neededKeys) {
  const corpus = {};
  const scanned = {};
  let earliestFetched = null;
  let allCached = true;

  for (const corpusKey of neededKeys) {
    const spec = CORPUS_KIND_SPECS[corpusKey];
    if (!spec) continue;
    const { items, fetched_at, cached_at } = await fetchCorpusKind(
      client,
      cache,
      instance,
      spec.kind,
      spec.endpoint,
      spec.itemsKey,
    );
    corpus[corpusKey] = items;
    scanned[corpusKey] = items.length;
    if (!earliestFetched || (fetched_at && fetched_at < earliestFetched)) {
      earliestFetched = fetched_at;
    }
    if (cached_at === null) allCached = false;
  }

  return {
    corpus,
    scanned,
    fetched_at: earliestFetched,
    cached_at: allCached ? new Date().toISOString() : null,
  };
}

function invalidateKinds(cache, instance, neededKeys) {
  const kinds = neededKeys
    .map((k) => CORPUS_KIND_SPECS[k]?.kind)
    .filter(Boolean);
  cache.invalidate(instance, kinds);
}

const FIELD_CORPUS_KEYS = ['triggers', 'automations', 'macros', 'views', 'forms'];
const FORM_CORPUS_KEYS = ['triggers', 'automations', 'macros', 'views'];
const GROUP_CORPUS_KEYS = ['triggers', 'automations', 'views', 'sla_policies'];

export const usageAnalysisTools = [
  {
    name: 'find_field_usage',
    description:
      'Find every reference to a custom ticket field across triggers, automations, macros, views, and ticket forms, returns `references` with `why_matched` breadcrumbs and `reference_count`. **The right tool for "is it safe to delete this field?"** Operates over the cached verbose corpus, no extra HTTP unless `refresh: true`. For a full field-hygiene report (unused / inactive-only / empty options / not on any active form), use `audit_field_health` instead, it bundles this analyzer.',
    schema: {
      field_id: z
        .union([z.number(), z.string()])
        .describe(
          'Custom field ID (numeric, or the "custom_fields_<id>" key). The numeric portion is what gets matched.',
        ),
      instance: z
        .string()
        .optional()
        .describe('Override the sticky instance for this call'),
      refresh: z
        .boolean()
        .optional()
        .describe('Bypass cache and re-fetch the corpus from Zendesk'),
    },
    handler: async ({ field_id, instance, refresh = false } = {}) => {
      let resolved = null;
      try {
        resolved = instanceSession.resolve(instance);
        const factory = await getClientFactory();
        const client = factory.getClient(resolved);
        const cache = getCache();

        if (refresh) invalidateKinds(cache, resolved, FIELD_CORPUS_KEYS);

        const { corpus, scanned, fetched_at, cached_at } = await buildCorpus(
          client,
          cache,
          resolved,
          FIELD_CORPUS_KEYS,
        );

        const references = findFieldUsage(field_id, corpus);
        return asMcp(
          success(
            resolved,
            {
              references,
              reference_count: references.length,
              scanned,
            },
            { fetched_at, cached_at },
          ),
        );
      } catch (err) {
        return asMcp(fromError(err, resolved));
      }
    },
  },
  {
    name: 'find_form_usage',
    description:
      'Find every reference to a ticket form across triggers, automations, macros, and views, returns `references` with `why_matched` breadcrumbs. **The right tool for "is it safe to retire this form?"** Operates over the cached verbose corpus, no extra HTTP. For broader form hygiene (forms with no active rules, etc.), `audit_field_health` covers the form-side checks too.',
    schema: {
      form_id: z
        .union([z.number(), z.string()])
        .describe('Ticket form ID'),
      instance: z
        .string()
        .optional()
        .describe('Override the sticky instance for this call'),
      refresh: z
        .boolean()
        .optional()
        .describe('Bypass cache and re-fetch the corpus from Zendesk'),
    },
    handler: async ({ form_id, instance, refresh = false } = {}) => {
      let resolved = null;
      try {
        resolved = instanceSession.resolve(instance);
        const factory = await getClientFactory();
        const client = factory.getClient(resolved);
        const cache = getCache();

        if (refresh) invalidateKinds(cache, resolved, FORM_CORPUS_KEYS);

        const { corpus, scanned, fetched_at, cached_at } = await buildCorpus(
          client,
          cache,
          resolved,
          FORM_CORPUS_KEYS,
        );

        const references = findFormUsage(form_id, corpus);
        return asMcp(
          success(
            resolved,
            {
              references,
              reference_count: references.length,
              scanned,
            },
            { fetched_at, cached_at },
          ),
        );
      } catch (err) {
        return asMcp(fromError(err, resolved));
      }
    },
  },
  {
    name: 'find_group_usage',
    description:
      'Find every reference to an agent group across triggers, automations, views, and SLA policies, returns `references` with `why_matched` breadcrumbs. **The right tool for "is it safe to delete this group?"** Operates over the cached verbose corpus, no extra HTTP unless `refresh: true`. For broader trigger-orphan detection (including dangling group ids), `audit_trigger_health` checks group, form, field, and category orphans in one pass.',
    schema: {
      group_id: z
        .union([z.number(), z.string()])
        .describe('Group ID'),
      instance: z
        .string()
        .optional()
        .describe('Override the sticky instance for this call'),
      refresh: z
        .boolean()
        .optional()
        .describe('Bypass cache and re-fetch the corpus from Zendesk'),
    },
    handler: async ({ group_id, instance, refresh = false } = {}) => {
      let resolved = null;
      try {
        resolved = instanceSession.resolve(instance);
        const factory = await getClientFactory();
        const client = factory.getClient(resolved);
        const cache = getCache();

        if (refresh) invalidateKinds(cache, resolved, GROUP_CORPUS_KEYS);

        const { corpus, scanned, fetched_at, cached_at } = await buildCorpus(
          client,
          cache,
          resolved,
          GROUP_CORPUS_KEYS,
        );

        const references = findGroupUsage(group_id, corpus);
        return asMcp(
          success(
            resolved,
            {
              references,
              reference_count: references.length,
              scanned,
            },
            { fetched_at, cached_at },
          ),
        );
      } catch (err) {
        return asMcp(fromError(err, resolved));
      }
    },
  },
];
