import { z } from 'zod';
import {
  getClientFactory,
  getCache,
  instanceSession,
} from '../lib/foundations.js';
import { PaginatedFetcher } from '../lib/paginated-fetcher.js';
import { ResourceCache } from '../lib/resource-cache.js';
import { success, fromError } from '../lib/response-envelope.js';
import {
  findByTag,
  findByField,
  findConflicts,
} from '../lib/trigger-analyzer.js';
import { asMcp } from './meta.js';

const KIND = 'triggers';

/**
 * Fetch all triggers (verbose) for the given resolved instance, hitting the
 * shared ResourceCache. Same key shape as triggers.js list_triggers verbose
 * path so the two share entries.
 */
async function loadTriggersVerbose(resolved, { refresh = false } = {}) {
  const factory = await getClientFactory();
  const client = factory.getClient(resolved);
  const cache = getCache();

  const queryHash = 'all';
  const verbose = true;
  const key = ResourceCache.makeKey(resolved, KIND, queryHash, verbose);

  if (refresh) cache.invalidate(resolved, [KIND]);

  const { value, fetched_at, cached_at } = await cache.getOrFetch(
    key,
    undefined,
    async () => {
      const result = await PaginatedFetcher.fetchAll(client, '/triggers.json', {
        itemsKey: 'triggers',
        perPage: 100,
        mode: 'auto',
      });
      return {
        count: result.count,
        truncated: result.truncated,
        cursor: result.cursor,
        items: result.items,
      };
    },
  );

  return { value, fetched_at, cached_at };
}

export const triggerAnalysisTools = [
  {
    name: 'find_triggers_by_tag',
    description:
      'Find triggers that reference a specific tag, scoped by `mode`: `sets` (action adds), `removes` (action removes), `condition` (read in `current_tags`), or `any` (union). Each match carries a `why_matched` breadcrumb so you can see exactly where it hit. **Always reach for this before `list_triggers` + manual scan**, it operates over the cached verbose corpus with no extra HTTP. For the broader "which tags exist at all?" question use `list_tags_in_use`; for a one-shot tag-hygiene audit use `audit_tag_sprawl`.',
    schema: {
      tag: z.string().min(1).describe('Exact tag to match'),
      mode: z
        .enum(['sets', 'removes', 'condition', 'any'])
        .default('any')
        .describe('Where to look: action-set, action-remove, condition, or any'),
      instance: z
        .string()
        .optional()
        .describe('Override the sticky instance for this call'),
      refresh: z
        .boolean()
        .optional()
        .describe('Bypass cache and re-fetch triggers from Zendesk'),
    },
    handler: async ({ tag, mode = 'any', instance, refresh = false } = {}) => {
      let resolved = null;
      try {
        resolved = instanceSession.resolve(instance);
        const { value, fetched_at, cached_at } = await loadTriggersVerbose(
          resolved,
          { refresh },
        );
        const triggers = Array.isArray(value?.items) ? value.items : [];
        const matches = findByTag(triggers, tag, mode);
        return asMcp(
          success(
            resolved,
            {
              matches,
              match_count: matches.length,
              scanned_count: triggers.length,
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
    name: 'find_triggers_by_field',
    description:
      'Find triggers that touch a named field in any condition or action, answers "which triggers reference `ticket_form_id` 42?", "which triggers set `status` to `solved`?", "which triggers route to `group_id` 7?". Optional `value` narrows to an exact match (string-coerced). **Prefer this over `list_triggers` for any field-reference question**, it scans the cached verbose corpus with `why_matched` breadcrumbs and zero extra HTTP. For impact-analysis on a custom ticket field specifically, `find_field_usage` checks triggers + automations + macros + views + forms in one call.',
    schema: {
      field: z
        .string()
        .min(1)
        .describe('Field name as it appears in trigger conditions/actions'),
      value: z
        .union([z.string(), z.number(), z.boolean()])
        .optional()
        .describe('Optional exact-value filter (compared as string)'),
      instance: z
        .string()
        .optional()
        .describe('Override the sticky instance for this call'),
      refresh: z
        .boolean()
        .optional()
        .describe('Bypass cache and re-fetch triggers from Zendesk'),
    },
    handler: async ({ field, value, instance, refresh = false } = {}) => {
      let resolved = null;
      try {
        resolved = instanceSession.resolve(instance);
        const { value: cached, fetched_at, cached_at } =
          await loadTriggersVerbose(resolved, { refresh });
        const triggers = Array.isArray(cached?.items) ? cached.items : [];
        const matches = findByField(triggers, field, value);
        return asMcp(
          success(
            resolved,
            {
              matches,
              match_count: matches.length,
              scanned_count: triggers.length,
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
    name: 'find_trigger_conflicts',
    description:
      'Surface pairs of active triggers that fight each other, same all-block precondition signature with contradicting effects. Two classes: `field_overwrite` (both write different values to the same field) and `tag_set_remove_pair` (one sets a tag, the other removes it). Pass `trigger_id` to scope to conflicts involving one rule, or `include_inactive: true` for cleanup audits. **For a full trigger hygiene report (conflicts plus orphaned references, deactivated-but-referenced, ordering anomalies, empty rules), call `audit_trigger_health` instead, it bundles this analyzer with the support-kind checks.** Operates over the cached verbose corpus, no extra HTTP.',
    schema: {
      trigger_id: z
        .union([z.string(), z.number()])
        .optional()
        .describe('Optional: only return conflicts involving this trigger id'),
      include_inactive: z
        .boolean()
        .optional()
        .describe(
          'Include deactivated triggers in conflict scan (default false). Useful for cleanup audits where dead rules still count.',
        ),
      instance: z
        .string()
        .optional()
        .describe('Override the sticky instance for this call'),
      refresh: z
        .boolean()
        .optional()
        .describe('Bypass cache and re-fetch triggers from Zendesk'),
    },
    handler: async ({
      trigger_id,
      include_inactive = false,
      instance,
      refresh = false,
    } = {}) => {
      let resolved = null;
      try {
        resolved = instanceSession.resolve(instance);
        const { value, fetched_at, cached_at } = await loadTriggersVerbose(
          resolved,
          { refresh },
        );
        const all = Array.isArray(value?.items) ? value.items : [];
        const triggers = include_inactive
          ? all
          : all.filter((t) => t && t.active !== false);
        const conflicts = findConflicts(triggers, trigger_id);
        return asMcp(
          success(
            resolved,
            {
              conflicts,
              conflict_count: conflicts.length,
              scanned_count: triggers.length,
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
