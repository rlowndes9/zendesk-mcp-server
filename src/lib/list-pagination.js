/**
 * Slice A, centralised filter / slice / project pipeline used by every
 * paginated list_* tool.
 *
 * The list-tool handler fetches the full corpus into the cache (as before),
 * then hands the corpus to `applyFilterAndSlice` along with the user's
 * pagination args plus the cache snapshot timestamp (`cachedAt`).
 *
 * Pipeline:
 *   1. apply structured filter (active / category_id / title_contains /
 *      updated_since); unsupported keys are ignored and surfaced via
 *      `filter_notes`.
 *   2. decode + validate the cursor; stale cursors reset offset to 0 and
 *      flag `cursor_invalidated: true`.
 *   3. slice [offset, offset + limit).
 *   4. project to skeleton (default), arbitrary fields whitelist, or pass
 *      through verbose.
 *   5. emit a fresh cursor for the next page (null when no more items).
 *
 * The corpus passed in is cached, callers should NOT mutate it. We use
 * filter() / slice() / map() which all return new arrays.
 */

import { z } from 'zod';
import { encode as encodeCursor, decode as decodeCursor, isFresh } from './cursor.js';
import { projectionRegistry } from './projection-registry.js';
import { PaginatedFetcher } from './paginated-fetcher.js';
import { ResourceCache } from './resource-cache.js';

/**
 * Slice A, the four shared pagination args added to every list_* tool.
 * Spread into a tool's `schema` object alongside its existing args.
 */
export const LIST_PAGINATION_SCHEMA = {
  limit: z
    .number()
    .int()
    .positive()
    .max(25000)
    .optional()
    .describe(
      'Max items to return. Default 100. The full corpus is fetched and cached server-side; this only limits what the response carries.',
    ),
  cursor: z
    .string()
    .optional()
    .describe(
      'Opaque pagination token from a previous response. Slices the next page from the cached corpus. Stale cursors (older than the cache TTL) auto-reset to offset 0 and set cursor_invalidated: true.',
    ),
  fields: z
    .array(z.string())
    .optional()
    .describe(
      'Whitelist of field names. Overrides the default projection. Use to opt into extra fields (e.g. ["id","title","active","position","category_id","updated_at"]) without going fully verbose.',
    ),
  filter: z
    .object({})
    .passthrough()
    .optional()
    .describe(
      'Structured filter applied to the cached corpus before slicing. Supported keys: active (bool), category_id (number/string), title_contains (string, case-insensitive), updated_since (ISO timestamp). Unsupported keys are ignored with a note in the response.',
    ),
};

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 25000;

const SUPPORTED_FILTER_KEYS = new Set([
  'active',
  'category_id',
  'title_contains',
  'updated_since',
]);

function applyFilter(items, filter) {
  if (!filter || typeof filter !== 'object') {
    return { items, notes: [] };
  }
  const notes = [];
  for (const k of Object.keys(filter)) {
    if (!SUPPORTED_FILTER_KEYS.has(k)) {
      notes.push(`unsupported filter key ignored: ${k}`);
    }
  }
  let out = items;
  if (Object.prototype.hasOwnProperty.call(filter, 'active')) {
    const want = filter.active === true || filter.active === 'true';
    out = out.filter((it) => Boolean(it && it.active) === want);
  }
  if (filter.category_id !== undefined && filter.category_id !== null) {
    const want = String(filter.category_id);
    out = out.filter((it) => it && String(it.category_id ?? '') === want);
  }
  if (typeof filter.title_contains === 'string' && filter.title_contains.length > 0) {
    const needle = filter.title_contains.toLowerCase();
    out = out.filter((it) => {
      if (!it) return false;
      const hay = (it.title || it.name || it.subject || '').toString().toLowerCase();
      return hay.includes(needle);
    });
  }
  if (typeof filter.updated_since === 'string' && filter.updated_since.length > 0) {
    const since = Date.parse(filter.updated_since);
    if (!Number.isNaN(since)) {
      out = out.filter((it) => {
        if (!it) return false;
        const ts = Date.parse(it.updated_at || it.created_at || '');
        return !Number.isNaN(ts) && ts >= since;
      });
    } else {
      notes.push('updated_since is not a parseable ISO timestamp; ignored');
    }
  }
  return { items: out, notes };
}

function projectItems({ items, kind, fields, verbose }) {
  if (verbose && (!fields || fields.length === 0)) return items;
  if (Array.isArray(fields) && fields.length > 0) {
    return items.map((it) => projectionRegistry.projectFields(it, fields));
  }
  return projectionRegistry.skeletonMany(kind, items);
}

/**
 * @param {Array} corpus            Full (cached) corpus, unprojected.
 * @param {object} opts
 * @param {object} [opts.filter]    Structured filter; unsupported keys ignored.
 * @param {number} [opts.limit]     Items to return; defaults to 100, capped at 25000.
 * @param {string} [opts.cursor]    Opaque token from a previous response.
 * @param {string[]} [opts.fields]  Whitelist that overrides the skeleton.
 * @param {boolean} [opts.verbose]  Skip projection entirely (full payload).
 * @param {string}  opts.kind       Resource kind (e.g. 'triggers').
 * @param {string}  opts.instance   Instance name.
 * @param {string}  opts.queryHash  Cache query-hash (e.g. 'all').
 * @param {string|null} opts.cachedAt  Snapshot timestamp; used to validate cursors.
 * @returns {{ count, total, truncated, cursor, cursor_invalidated, items, filter_notes? }}
 */
export function applyFilterAndSlice(corpus, opts) {
  const {
    filter,
    limit,
    cursor,
    fields,
    verbose = false,
    kind,
    instance,
    queryHash = 'all',
    cachedAt = null,
  } = opts || {};

  const safeLimit = Math.max(
    1,
    Math.min(
      Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT,
      MAX_LIMIT,
    ),
  );

  const safeCorpus = Array.isArray(corpus) ? corpus : [];
  const { items: filtered, notes: filterNotes } = applyFilter(safeCorpus, filter);

  let offset = 0;
  let cursorInvalidated = false;
  if (typeof cursor === 'string' && cursor.length > 0) {
    try {
      const decoded = decodeCursor(cursor);
      if (isFresh(decoded, cachedAt)) {
        offset = Math.max(0, decoded.offset || 0);
      } else {
        cursorInvalidated = true;
        offset = 0;
      }
    } catch (_e) {
      cursorInvalidated = true;
      offset = 0;
    }
  }

  if (offset > filtered.length) offset = filtered.length;
  const sliced = filtered.slice(offset, offset + safeLimit);
  const projected = projectItems({ items: sliced, kind, fields, verbose });
  const nextOffset = offset + sliced.length;
  const truncated = nextOffset < filtered.length;
  const nextCursor = truncated
    ? encodeCursor({
        instance,
        kind,
        queryHash,
        verbose: Boolean(verbose),
        offset: nextOffset,
        cached_at: cachedAt,
      })
    : null;

  const out = {
    count: projected.length,
    total: filtered.length,
    truncated,
    cursor: nextCursor,
    cursor_invalidated: cursorInvalidated,
    items: projected,
  };
  if (filterNotes.length > 0) out.filter_notes = filterNotes;
  return out;
}

/**
 * Fetch (and cache) the full corpus for a paginated list endpoint, returning
 * the raw items plus the cache-snapshot timestamps.
 *
 * Always keyed under `verbose: true` so internal analyzers (loadTriggersVerbose
 * etc.) and public list_* tools share the same corpus entry.
 *
 * @returns {{ items: Array, fetched_at: string|null, cached_at: string|null }}
 */
export async function fetchCorpus({
  client,
  cache,
  instance,
  kind,
  queryHash = 'all',
  refresh = false,
  fetcher,
  // The endpoint + paginated-fetcher options are exposed for one-liner callers.
  path,
  itemsKey,
  perPage = 100,
  mode = 'auto',
  params,
}) {
  const key = ResourceCache.makeKey(instance, kind, queryHash, true);
  if (refresh) cache.invalidate(instance, [kind]);
  const entry = await cache.getOrFetch(key, undefined, async () => {
    if (typeof fetcher === 'function') {
      const items = await fetcher();
      return { items: Array.isArray(items) ? items : [] };
    }
    const result = await PaginatedFetcher.fetchAll(client, path, {
      itemsKey,
      perPage,
      mode,
      params,
    });
    return { items: result.items };
  });
  return {
    items: Array.isArray(entry.value?.items) ? entry.value.items : [],
    fetched_at: entry.fetched_at,
    cached_at: entry.cached_at,
  };
}

/**
 * One-liner used by every list_* tool handler: fetch the corpus, then slice.
 *
 * Returns:
 *   { value, fetched_at, cached_at }
 * where `value` is the response payload (count/total/truncated/cursor/items).
 * Pass it straight into `success(resolved, value, { fetched_at, cached_at })`.
 *
 * Optional `extra` is shallow-merged onto the response payload, useful for
 * carrying through resource-scoped fields like `webhook_id`, `ticket_id`.
 */
export async function fetchAndSlice({
  client,
  cache,
  instance,
  kind,
  queryHash = 'all',
  refresh = false,
  // Slice/projection args (from the tool's user input):
  limit,
  cursor,
  fields,
  verbose = false,
  filter,
  // Corpus fetcher knobs:
  path,
  itemsKey,
  perPage = 100,
  mode = 'auto',
  params,
  fetcher,
  // Optional extras merged onto the result.
  extra,
}) {
  const corpus = await fetchCorpus({
    client,
    cache,
    instance,
    kind,
    queryHash,
    refresh,
    path,
    itemsKey,
    perPage,
    mode,
    params,
    fetcher,
  });
  const sliced = applyFilterAndSlice(corpus.items, {
    filter,
    limit,
    cursor,
    fields,
    verbose,
    kind,
    instance,
    queryHash,
    cachedAt: corpus.fetched_at,
  });
  return {
    value: extra ? { ...extra, ...sliced } : sliced,
    fetched_at: corpus.fetched_at,
    cached_at: corpus.cached_at,
  };
}

