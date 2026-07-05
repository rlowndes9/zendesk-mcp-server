import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PaginatedFetcher } from '../src/lib/paginated-fetcher.js';

function makeFakeClient(pages) {
  // pages: array of { match: (path, params) => bool, response: object }
  let i = 0;
  return {
    async request(method, pathOrUrl, opts) {
      const page = pages[i];
      assert.ok(page, `unexpected extra request to ${pathOrUrl}`);
      i += 1;
      if (page.match) {
        page.match(pathOrUrl, opts);
      }
      return page.response;
    },
    remaining() {
      return pages.length - i;
    },
  };
}

test('PaginatedFetcher: cursor mode walks pages until has_more=false', async () => {
  const client = makeFakeClient([
    {
      response: {
        triggers: [{ id: 1 }, { id: 2 }],
        meta: { has_more: true, after_cursor: 'c1' },
        links: { next: 'https://x/triggers.json?page[after]=c1' },
      },
    },
    {
      response: {
        triggers: [{ id: 3 }],
        meta: { has_more: false },
        links: {},
      },
    },
  ]);
  const result = await PaginatedFetcher.fetchAll(client, '/triggers.json', {
    itemsKey: 'triggers',
    max: 500,
  });
  assert.equal(result.count, 3);
  assert.equal(result.truncated, false);
  assert.equal(result.cursor, null);
  assert.deepEqual(result.items.map((t) => t.id), [1, 2, 3]);
});

test('PaginatedFetcher: cursor mode truncates at max', async () => {
  const client = makeFakeClient([
    {
      response: {
        triggers: [{ id: 1 }, { id: 2 }, { id: 3 }],
        meta: { has_more: true, after_cursor: 'c1' },
        links: { next: 'https://x/triggers.json?page[after]=c1' },
      },
    },
  ]);
  const result = await PaginatedFetcher.fetchAll(client, '/triggers.json', {
    itemsKey: 'triggers',
    max: 2,
  });
  assert.equal(result.count, 2);
  assert.equal(result.truncated, true);
  assert.ok(result.cursor, 'cursor should be set when truncated');
});

test('PaginatedFetcher: offset mode walks via next_page', async () => {
  const client = makeFakeClient([
    {
      response: {
        triggers: [{ id: 1 }],
        next_page: 'https://x/triggers.json?page=2',
        count: 2,
      },
    },
    {
      response: {
        triggers: [{ id: 2 }],
        next_page: null,
        count: 2,
      },
    },
  ]);
  const result = await PaginatedFetcher.fetchAll(client, '/triggers.json', {
    itemsKey: 'triggers',
    max: 500,
  });
  assert.equal(result.count, 2);
  assert.equal(result.truncated, false);
});

test('PaginatedFetcher: single-page response (no pagination markers) terminates', async () => {
  const client = makeFakeClient([
    {
      response: { triggers: [{ id: 1 }, { id: 2 }] },
    },
  ]);
  const result = await PaginatedFetcher.fetchAll(client, '/triggers.json', {
    itemsKey: 'triggers',
    max: 500,
  });
  assert.equal(result.count, 2);
  assert.equal(result.truncated, false);
  assert.equal(result.cursor, null);
});

test('PaginatedFetcher: offset mode truncates and surfaces next_page as cursor', async () => {
  const client = makeFakeClient([
    {
      response: {
        triggers: [{ id: 1 }, { id: 2 }, { id: 3 }],
        next_page: 'https://x/triggers.json?page=2',
        count: 100,
      },
    },
  ]);
  const result = await PaginatedFetcher.fetchAll(client, '/triggers.json', {
    itemsKey: 'triggers',
    max: 2,
    mode: 'offset',
  });
  assert.equal(result.count, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.cursor, 'https://x/triggers.json?page=2');
});

test('PaginatedFetcher: explicit cursor mode emits page[size] param', async () => {
  let captured = null;
  const client = {
    async request(method, pathOrUrl, opts) {
      captured = opts;
      return { triggers: [{ id: 1 }], meta: { has_more: false } };
    },
  };
  await PaginatedFetcher.fetchAll(client, '/triggers.json', {
    itemsKey: 'triggers',
    mode: 'cursor',
    perPage: 50,
  });
  assert.equal(captured.params['page[size]'], 50);
});
