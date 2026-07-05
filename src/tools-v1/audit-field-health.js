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
import { auditFieldHealth } from '../lib/audit-field-health.js';

/**
 * audit_field_health.
 *
 * Composes UsageAnalyzer + the field/form primitives to flag unused custom
 * fields, fields used only by inactive rules, fields with empty option lists,
 * and fields not in any active form.
 *
 * Always fetches verbose payloads, the audit needs `custom_field_options`
 * (dropped by the thin ticket-fields projection) and rule conditions/actions
 * (dropped by thin trigger/automation/macro/view projections). Cache keys
 * here match the verbose-list cache keys used by the primitive `list_*`
 * tools, so two consecutive audits or an audit-after-list don't double-fetch.
 *
 * Per-kind upstream errors are tolerated: the audit continues with whatever
 * kinds it could fetch and adds a `notes` entry per missing kind.
 */

const KIND_ENDPOINTS = {
  ticket_fields: { path: '/ticket_fields.json', itemsKey: 'ticket_fields' },
  ticket_forms: { path: '/ticket_forms.json', itemsKey: 'ticket_forms' },
  triggers: { path: '/triggers.json', itemsKey: 'triggers' },
  automations: { path: '/automations.json', itemsKey: 'automations' },
  macros: { path: '/macros.json', itemsKey: 'macros' },
  views: { path: '/views.json', itemsKey: 'views' },
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

export const auditFieldHealthTools = [
  {
    name: 'audit_field_health',
    description:
      'Composite ticket-field hygiene report: flags fields referenced by nothing, fields referenced only by inactive rules, dropdown/multiselect fields with empty option lists, and custom fields not on any active form. Skips system fields (subject, status, priority, etc.). **The right starting point for field-cleanup work**, bundles `find_field_usage` plus the option-list and form-coverage checks. Tolerates per-kind upstream errors with `notes`.',
    schema: {
      instance: z
        .string()
        .optional()
        .describe('Override the sticky instance for this call'),
      refresh: z
        .boolean()
        .optional()
        .describe('Bypass cache and re-fetch every kind from Zendesk'),
    },
    handler: async ({ instance, refresh = false } = {}) => {
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

        const audit = auditFieldHealth(corpus);

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
