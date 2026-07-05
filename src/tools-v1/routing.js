import { z } from 'zod';
import {
  getClientFactory,
  getCache,
  instanceSession,
} from '../lib/foundations.js';
import { PaginatedFetcher } from '../lib/paginated-fetcher.js';
import { ResourceCache } from '../lib/resource-cache.js';
import {
  LIST_PAGINATION_SCHEMA,
  fetchAndSlice,
} from '../lib/list-pagination.js';
import { success, error, fromError } from '../lib/response-envelope.js';
import { asMcp } from './meta.js';

/**
 * Routing primitives.
 *
 * Read-only primitives backing the omnichannel/skill-based routing
 * solutionising workflow (PRD: "Solutionising workflows", story 31, and the
 * "Routing endpoints, extra attention" note).
 *
 * Endpoints (Zendesk Skill-Based Routing API):
 *   - /api/v2/routing/attributes.json               , list/get routing attrs
 *   - /api/v2/routing/attributes/{id}/values.json   , list values for an attr
 *   - /api/v2/users/{user_id}/instance_values.json  , agent's assigned values
 *
 * Skills:
 *   Modern Zendesk does NOT expose a distinct top-level /api/v2/skills.json
 *   endpoint. "Skills" in skill-based routing are modeled as routing-attribute
 *   values (typically under an attribute named "Skill"). The legacy Talk-only
 *   /api/v2/talk/skills endpoint is deprecated and not present on most
 *   instances. We therefore expose `list_skills` as a convenience that surfaces
 *   the values of a "skills-like" attribute (resolved by id or by name match),
 *   documenting this clearly in the tool description.
 *
 * Plan gating:
 *   The Skill-Based Routing API is gated to Suite Professional and above. On
 *   smaller plans Zendesk returns 403 (Forbidden) or 404 (route not enabled).
 *   We catch these and return an `upstream_error` envelope carrying the
 *   Zendesk-side reason and `http_status`, never a generic failure. This is
 *   the most common degrade case in real consultancy use because audit work
 *   often happens on small-plan instances.
 */

const KIND_ATTRIBUTES = 'routing_attributes';
const KIND_ATTRIBUTE_VALUES = 'routing_attribute_values';
const KIND_AGENT_ASSIGNMENTS = 'routing_agent_assignments';

/**
 * Wrap a routing endpoint call with the plan-gated graceful-degrade envelope.
 *
 * If the underlying error is a 403 or 404 from RateLimitedHttpClient, return
 * an `upstream_error` envelope that the agent can recognize as
 * "this instance doesn't have routing config enabled" rather than a hard fail.
 */
function degradeIfPlanGated(err, instance) {
  const status = err?.http_status;
  if (status === 403 || status === 404) {
    return asMcp(
      error(
        instance,
        'upstream_error',
        `routing config unavailable on this plan: ${err.message}`,
        { http_status: status },
      ),
    );
  }
  return asMcp(fromError(err, instance));
}

export const routingTools = [
  {
    name: 'list_routing_attributes',
    description:
      'Returns skill-based-routing attribute definitions (e.g. "Skill", "Language", "Region") as paginated skeletons (`id`, `name`, `updated_at`). Default `limit: 100`; pass `cursor`, `fields`, `filter`, or `verbose: true`. **Plan-gated**, requires omnichannel routing; degrades to `upstream_error` (403/404) when the feature isn\'t enabled. **For the values inside one attribute use `list_routing_attribute_values`;** for the legacy "skills" entry-point use `list_skills`.',
    schema: {
      instance: z
        .string()
        .optional()
        .describe('Override the sticky instance for this call'),
      verbose: z
        .boolean()
        .optional()
        .describe('Return full attribute objects instead of the thin projection'),
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
          kind: KIND_ATTRIBUTES,
          queryHash: 'all',
          refresh,
          limit,
          cursor,
          fields,
          verbose,
          filter,
          path: '/routing/attributes.json',
          itemsKey: 'attributes',
          mode: 'offset',
        });
        return asMcp(success(resolved, value, { fetched_at, cached_at }));
      } catch (err) {
        return degradeIfPlanGated(err, resolved);
      }
    },
  },
  {
    name: 'get_routing_attribute',
    description:
      'Fetch one routing attribute definition by ID. **Plan-gated**, degrades to `upstream_error` on 403/404 when omnichannel routing is off. For the attribute\'s values, call `list_routing_attribute_values`.',
    schema: {
      id: z.union([z.string(), z.number()]).describe('Routing attribute ID (UUID string or numeric)'),
      instance: z.string().optional().describe('Override the sticky instance'),
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
          KIND_ATTRIBUTES,
          `id:${id}`,
          true,
        );
        const { value, fetched_at, cached_at } = await cache.getOrFetch(
          key,
          undefined,
          async () => {
            const body = await client.request(
              'GET',
              `/routing/attributes/${encodeURIComponent(id)}.json`,
              {},
            );
            return body.attribute;
          },
        );

        return asMcp(success(resolved, value, { fetched_at, cached_at }));
      } catch (err) {
        return degradeIfPlanGated(err, resolved);
      }
    },
  },
  {
    name: 'list_routing_attribute_values',
    description:
      'Returns the values defined under one routing attribute (e.g. the actual skills under a "Skill" attribute) as paginated skeletons (`id`, `attribute_id`, `name`, `updated_at`). Default `limit: 100`; pass `cursor`, `fields`, `filter`, or `verbose: true`. **Plan-gated**, degrades to `upstream_error` when omnichannel routing is off. To see which agents have a given value, use `list_agent_skill_assignments` per agent.',
    schema: {
      attribute_id: z
        .union([z.string(), z.number()])
        .describe('Parent routing attribute ID'),
      instance: z.string().optional().describe('Override the sticky instance'),
      verbose: z.boolean().optional().describe('Return full value objects'),
      refresh: z.boolean().optional().describe('Bypass cache and re-fetch'),
      ...LIST_PAGINATION_SCHEMA,
    },
    handler: async ({
      attribute_id,
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
        if (attribute_id === undefined || attribute_id === null || attribute_id === '') {
          return asMcp(
            error(
              resolved,
              'validation_error',
              'attribute_id is required',
            ),
          );
        }
        const factory = await getClientFactory();
        const client = factory.getClient(resolved);
        const cache = getCache();
        const { value, fetched_at, cached_at } = await fetchAndSlice({
          client,
          cache,
          instance: resolved,
          kind: KIND_ATTRIBUTE_VALUES,
          queryHash: `attr:${attribute_id}`,
          refresh,
          limit,
          cursor,
          fields,
          verbose,
          filter,
          path: `/routing/attributes/${encodeURIComponent(attribute_id)}/values.json`,
          itemsKey: 'attribute_values',
          mode: 'offset',
        });
        return asMcp(success(resolved, value, { fetched_at, cached_at }));
      } catch (err) {
        return degradeIfPlanGated(err, resolved);
      }
    },
  },
  {
    name: 'list_skills',
    description:
      'Convenience wrapper that resolves a "skills"-like routing attribute and returns its values as skeletons. Pass `attribute_id` to target one specifically, or `attribute_name` (case-insensitive; defaults to "skill"/"skills"). **Modern Zendesk has no `/skills.json` endpoint**, this tool exists because LLMs ask for "skills" by name; under the hood it\'s `list_routing_attribute_values` against the skill attribute. **Plan-gated**. For agent assignments use `list_agent_skill_assignments`.',
    schema: {
      instance: z.string().optional().describe('Override the sticky instance'),
      attribute_id: z
        .union([z.string(), z.number()])
        .optional()
        .describe('Specific routing attribute ID to enumerate as skills'),
      attribute_name: z
        .string()
        .optional()
        .describe('Match an attribute by name (case-insensitive). Default: matches "skill" or "skills".'),
      verbose: z.boolean().optional().describe('Return full value objects'),
      refresh: z.boolean().optional().describe('Bypass cache and re-fetch'),
      ...LIST_PAGINATION_SCHEMA,
    },
    handler: async ({
      instance,
      attribute_id,
      attribute_name,
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

        // Resolve the target attribute id.
        let targetId = attribute_id;
        if (!targetId) {
          // Fetch the attribute list (cached) and pick the first one whose
          // name matches `attribute_name` (or "skill"/"skills" by default).
          const attrsKey = ResourceCache.makeKey(
            resolved,
            KIND_ATTRIBUTES,
            'all',
            true,
          );
          if (refresh) cache.invalidate(resolved, [KIND_ATTRIBUTES]);
          const attrsResult = await cache.getOrFetch(
            attrsKey,
            undefined,
            async () => {
              const result = await PaginatedFetcher.fetchAll(
                client,
                '/routing/attributes.json',
                {
                  itemsKey: 'attributes',
                  perPage: 100,
                  mode: 'offset',
                },
              );
              return {
                count: result.count,
                truncated: result.truncated,
                cursor: result.cursor,
                items: result.items,
              };
            },
          );

          const wanted = (attribute_name || '').toLowerCase().trim();
          const defaults = ['skill', 'skills'];
          const match = attrsResult.value.items.find((a) => {
            const n = String(a?.name || '').toLowerCase().trim();
            if (wanted) return n === wanted;
            return defaults.includes(n);
          });
          if (!match) {
            return asMcp(
              success(
                resolved,
                {
                  count: 0,
                  truncated: false,
                  cursor: null,
                  items: [],
                  note:
                    'No "skill"-like routing attribute found on this instance. Pass attribute_id or attribute_name to target a specific attribute, or call list_routing_attributes to discover what exists.',
                },
                { fetched_at: attrsResult.fetched_at, cached_at: attrsResult.cached_at },
              ),
            );
          }
          targetId = match.id;
        }

        const { value, fetched_at, cached_at } = await fetchAndSlice({
          client,
          cache,
          instance: resolved,
          kind: KIND_ATTRIBUTE_VALUES,
          queryHash: `attr:${targetId}`,
          refresh,
          limit,
          cursor,
          fields,
          verbose,
          filter,
          path: `/routing/attributes/${encodeURIComponent(targetId)}/values.json`,
          itemsKey: 'attribute_values',
          mode: 'offset',
          extra: { attribute_id: targetId },
        });

        return asMcp(success(resolved, value, { fetched_at, cached_at }));
      } catch (err) {
        return degradeIfPlanGated(err, resolved);
      }
    },
  },
  {
    name: 'list_agent_skill_assignments',
    description:
      'Returns the routing-attribute values an agent holds (i.e. which skills/queues that user is eligible for) as paginated skeletons. Backed by `/api/v2/users/{user_id}/instance_values.json`, the canonical SBR-assignment endpoint. **Plan-gated**, degrades to `upstream_error` when omnichannel routing is off. **Scope-gated** because it touches user data (`config_plus_audits` or `full`). For attribute/value catalogs (not assignments), use `list_routing_attributes` / `list_routing_attribute_values`.',
    schema: {
      user_id: z
        .union([z.string(), z.number()])
        .describe('Agent (Zendesk user) ID'),
      instance: z.string().optional().describe('Override the sticky instance'),
      verbose: z.boolean().optional().describe('Return full value objects'),
      refresh: z.boolean().optional().describe('Bypass cache and re-fetch'),
      ...LIST_PAGINATION_SCHEMA,
    },
    handler: async ({
      user_id,
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
        if (user_id === undefined || user_id === null || user_id === '') {
          return asMcp(
            error(resolved, 'validation_error', 'user_id is required'),
          );
        }
        const factory = await getClientFactory();
        const client = factory.getClient(resolved);
        const cache = getCache();

        // /api/v2/users/{user_id}/instance_values.json is not paginated
        // (single response, typically small), use a custom fetcher so we
        // still benefit from the cache-and-slice pipeline.
        const { value, fetched_at, cached_at } = await fetchAndSlice({
          client,
          cache,
          instance: resolved,
          kind: KIND_AGENT_ASSIGNMENTS,
          queryHash: `user:${user_id}`,
          refresh,
          limit,
          cursor,
          fields,
          verbose,
          filter,
          fetcher: async () => {
            const body = await client.request(
              'GET',
              `/users/${encodeURIComponent(user_id)}/instance_values.json`,
              {},
            );
            return Array.isArray(body?.attribute_values)
              ? body.attribute_values
              : [];
          },
          extra: { user_id },
        });

        return asMcp(success(resolved, value, { fetched_at, cached_at }));
      } catch (err) {
        return degradeIfPlanGated(err, resolved);
      }
    },
  },
];
