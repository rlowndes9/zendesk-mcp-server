import { z } from 'zod';
import {
  getClientFactory,
  getCache,
  instanceSession,
} from '../lib/foundations.js';
import {
  LIST_PAGINATION_SCHEMA,
  fetchAndSlice,
} from '../lib/list-pagination.js';
import { success, error, fromError } from '../lib/response-envelope.js';
import { asMcp } from './meta.js';

const KIND = 'audit_logs';

/**
 * Audit logs are an Enterprise-plan feature. On non-Enterprise instances the
 * endpoint typically returns 403 (auth_failed under our classification) or
 * 404 (not_found). Translate either into a structured `upstream_error`
 * envelope with the original http_status so the agent can adapt without the
 * user ever seeing a generic failure.
 */
function isPlanGatedFailure(err) {
  if (!err) return false;
  const status = err.http_status;
  return status === 403 || status === 404;
}

export const auditLogsTools = [
  {
    name: 'list_audit_logs',
    description:
      'Returns instance-wide configuration audit logs as paginated skeletons (`id`, `source_type`, `actor_name`, `action`, `change_description`, `created_at`), every admin/config change with attribution. **Enterprise-plan-gated**; on lower plans returns `upstream_error` with the underlying http_status (403/404). Default `limit: 100`; pass `cursor`, `fields`, `filter` (server-side filters for `source_type`/`action` are honored). **For per-ticket field changes use `get_ticket_audits`**, this tool is admin-config only, not ticket-level.',
    schema: {
      instance: z
        .string()
        .optional()
        .describe('Override the sticky instance for this call'),
      verbose: z
        .boolean()
        .optional()
        .describe('Return full audit log objects instead of the thin projection'),
      refresh: z
        .boolean()
        .optional()
        .describe('Bypass cache and re-fetch from Zendesk'),
      filter_source_type: z
        .string()
        .optional()
        .describe('Optional filter[source_type] query (e.g. "Trigger", "User")'),
      filter_action: z
        .string()
        .optional()
        .describe('Optional filter[action] query (e.g. "create", "update")'),
      ...LIST_PAGINATION_SCHEMA,
    },
    handler: async ({
      instance,
      verbose = false,
      refresh = false,
      filter_source_type,
      filter_action,
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

        const params = {};
        if (filter_source_type) params['filter[source_type]'] = filter_source_type;
        if (filter_action) params['filter[action]'] = filter_action;

        const queryHash = JSON.stringify({
          source_type: filter_source_type ?? null,
          action: filter_action ?? null,
        });

        try {
          const { value, fetched_at, cached_at } = await fetchAndSlice({
            client,
            cache,
            instance: resolved,
            kind: KIND,
            queryHash,
            refresh,
            limit,
            cursor,
            fields,
            verbose,
            filter,
            path: '/audit_logs.json',
            itemsKey: 'audit_logs',
            params,
          });
          return asMcp(success(resolved, value, { fetched_at, cached_at }));
        } catch (innerErr) {
          if (isPlanGatedFailure(innerErr)) {
            return asMcp(
              error(
                resolved,
                'upstream_error',
                'audit_logs unavailable on this plan',
                { http_status: innerErr.http_status },
              ),
            );
          }
          throw innerErr;
        }
      } catch (err) {
        return asMcp(fromError(err, resolved));
      }
    },
  },
];
