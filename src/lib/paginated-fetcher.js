/**
 * Auto-walks Zendesk paginated list endpoints up to a cap.
 *
 * Two pagination modes:
 *   - cursor: modern Zendesk endpoints support `?page[size]=N` and return
 *     `{ <items>, meta: { has_more, after_cursor }, links: { next } }`.
 *   - offset: older endpoints use `?page=N&per_page=N` and return
 *     `{ <items>, next_page, count }`.
 *
 * Strategy: try cursor first when the caller declares the kind supports it
 * (most do); fall back to offset semantics if the response shape doesn't
 * carry a `meta.has_more` field. The caller passes `itemsKey` so we know
 * which property to drain (e.g. "triggers", "tickets").
 *
 * Returns: { items, count, truncated, cursor }
 *   - items: T[] (length <= max)
 *   - count: number (items.length)
 *   - truncated: boolean (true if there were more pages beyond the cap)
 *   - cursor: next pagination token if truncated, else null
 */
export class PaginatedFetcher {
  static async fetchAll(client, path, opts = {}) {
    const {
      params = {},
      max = 25000,
      itemsKey,
      mode = 'auto', // 'cursor' | 'offset' | 'auto'
      perPage = 100,
    } = opts;
    if (!itemsKey) {
      throw new Error('PaginatedFetcher: itemsKey required');
    }

    const items = [];
    let nextUrl = null;
    let nextCursor = null;
    let pageNum = 1;
    let firstResponse = null;

    // Initial query params:
    //   cursor mode: page[size]=perPage
    //   offset mode: page=1&per_page=perPage
    let queryParams;
    let useCursor;
    if (mode === 'cursor') {
      useCursor = true;
      queryParams = { ...params, 'page[size]': perPage };
    } else if (mode === 'offset') {
      useCursor = false;
      queryParams = { ...params, page: pageNum, per_page: perPage };
    } else {
      // auto: prefer cursor; if first response shows neither cursor meta
      // nor next_page, we just stop, single page.
      useCursor = true;
      queryParams = { ...params, 'page[size]': perPage };
    }

    while (true) {
      const response = nextUrl
        ? await client.request('GET', nextUrl, {})
        : await client.request('GET', path, { params: queryParams });
      if (!firstResponse) firstResponse = response;

      const pageItems = Array.isArray(response[itemsKey])
        ? response[itemsKey]
        : [];
      for (const it of pageItems) {
        if (items.length >= max) break;
        items.push(it);
      }

      // Cursor-mode detection (only meaningful on first iteration in 'auto').
      if (mode === 'auto' && firstResponse === response) {
        if (response.meta && typeof response.meta.has_more === 'boolean') {
          useCursor = true;
        } else if (
          response.next_page !== undefined ||
          typeof response.count === 'number'
        ) {
          useCursor = false;
        } else {
          // Single-page response; we're done.
          return finalize(items, max, null);
        }
      }

      if (items.length >= max) {
        // Hit cap. Compute next cursor if the underlying response says there's more.
        const cursor = extractNextCursor(response, useCursor);
        return finalize(items, max, cursor);
      }

      // Step to next page if available.
      if (useCursor) {
        const hasMore = response.meta?.has_more === true;
        const link = response.links?.next || null;
        if (!hasMore || !link) {
          return finalize(items, max, null);
        }
        nextUrl = link;
        nextCursor = response.meta?.after_cursor || null;
      } else {
        const link = response.next_page || null;
        if (!link) {
          return finalize(items, max, null);
        }
        nextUrl = link;
        pageNum += 1;
      }
    }
  }
}

function extractNextCursor(response, useCursor) {
  if (useCursor) {
    if (response.meta?.has_more && response.links?.next) {
      return response.meta?.after_cursor || response.links.next;
    }
    return null;
  }
  return response.next_page || null;
}

function finalize(items, max, cursor) {
  return {
    items,
    count: items.length,
    truncated: items.length >= max && cursor !== null,
    cursor: cursor,
  };
}
