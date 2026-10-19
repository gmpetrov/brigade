import assert from 'node:assert/strict'
import { test } from 'node:test'
import { googleAnalytics } from '../src/connectors/google-analytics.js'
import { googleSearchConsole } from '../src/connectors/google-search-console.js'
import type { ConnectorContext, ConnectorDefinition } from '../src/connectors/types.js'

type Call = { url: string; method: string; body?: unknown }

/** A context whose fetch answers from `routes` (first match by URL prefix) and records each call. */
function fake(routes: [string, (call: Call) => Response][]) {
  const calls: Call[] = []
  const ctx = {
    callId: 'call-1',
    fetch: async (url: string, init?: RequestInit) => {
      const call = {
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      }
      calls.push(call)
      const route = routes.find(([prefix]) => url.startsWith(prefix))
      if (!route) throw new Error(`unexpected ${url}`)
      return route[1](call)
    },
  } as unknown as ConnectorContext
  return { ctx, calls }
}

const ok = (body: unknown) => Response.json(body)
const run = (
  connector: ConnectorDefinition,
  name: string,
  ctx: ConnectorContext,
  input: unknown,
) => {
  const operation = connector.operations[name]!
  return operation.run(ctx, operation.input.parse(input))
}

test('search performance names each row by its dimensions and says where the next page starts', async () => {
  const { ctx, calls } = fake([
    [
      'https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query',
      () =>
        ok({
          rows: [
            {
              keys: ['seo tool', 'https://example.com/'],
              clicks: 12,
              impressions: 340,
              ctr: 0.035294,
              position: 4.4583,
            },
            {
              keys: ['ai seo', 'https://example.com/blog'],
              clicks: 3,
              impressions: 90,
              ctr: 0.0333,
              position: 9.02,
            },
          ],
          responseAggregationType: 'byPage',
        }),
    ],
  ])
  const result = (await run(googleSearchConsole, 'search_console_query', ctx, {
    siteUrl: 'sc-domain:example.com',
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    dimensions: ['query', 'page'],
    filters: [{ dimension: 'country', expression: 'fra' }],
    rowLimit: 2,
  })) as { rows: unknown[]; nextStartRow?: number }
  assert.deepEqual(result.rows[0], {
    query: 'seo tool',
    page: 'https://example.com/',
    clicks: 12,
    impressions: 340,
    ctr: 0.0353,
    position: 4.5,
  })
  assert.equal(result.nextStartRow, 2)
  assert.equal(calls[0]!.method, 'POST')
  assert.deepEqual(calls[0]!.body, {
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    dimensions: ['query', 'page'],
    type: 'web',
    aggregationType: 'auto',
    dataState: 'final',
    rowLimit: 2,
    startRow: 0,
    dimensionFilterGroups: [
      { filters: [{ dimension: 'country', operator: 'equals', expression: 'fra' }] },
    ],
  })
})

test('submitting a sitemap is a write, on the encoded property and sitemap', async () => {
  assert.equal(googleSearchConsole.operations.search_console_submit_sitemap!.write, true)
  assert.equal(googleSearchConsole.operations.search_console_query!.write, false)
  const { ctx, calls } = fake([
    ['https://searchconsole.googleapis.com/', () => new Response(null, { status: 204 })],
  ])
  await run(googleSearchConsole, 'search_console_submit_sitemap', ctx, {
    siteUrl: 'https://example.com/',
    sitemapUrl: 'https://example.com/sitemap.xml',
  })
  assert.deepEqual(calls[0], {
    url: 'https://searchconsole.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com%2F/sitemaps/https%3A%2F%2Fexample.com%2Fsitemap.xml',
    method: 'PUT',
    body: undefined,
  })
})

test('a GA4 report comes back as named rows with numbers, ordered by metric or dimension', async () => {
  const { ctx, calls } = fake([
    [
      'https://analyticsdata.googleapis.com/v1beta/properties/123456:runReport',
      () =>
        ok({
          dimensionHeaders: [{ name: 'sessionDefaultChannelGroup' }],
          metricHeaders: [
            { name: 'sessions', type: 'TYPE_INTEGER' },
            { name: 'engagementRate', type: 'TYPE_FLOAT' },
          ],
          rows: [
            {
              dimensionValues: [{ value: 'Organic Search' }],
              metricValues: [{ value: '120' }, { value: '0.61' }],
            },
          ],
          totals: [
            {
              dimensionValues: [{ value: 'RESERVED_TOTAL' }],
              metricValues: [{ value: '300' }, { value: '0.5' }],
            },
          ],
          rowCount: 4,
          metadata: { timeZone: 'Europe/Paris', currencyCode: 'EUR' },
        }),
    ],
  ])
  const result = await run(googleAnalytics, 'analytics_run_report', ctx, {
    property: 'properties/123456',
    startDate: '28daysAgo',
    metrics: ['sessions', 'engagementRate'],
    dimensions: ['sessionDefaultChannelGroup'],
    orderBy: [{ name: 'sessions' }, { name: 'sessionDefaultChannelGroup', desc: false }],
    limit: 1,
    totals: true,
  })
  assert.deepEqual(result, {
    rows: [{ sessionDefaultChannelGroup: 'Organic Search', sessions: 120, engagementRate: 0.61 }],
    totals: { sessionDefaultChannelGroup: 'RESERVED_TOTAL', sessions: 300, engagementRate: 0.5 },
    rowCount: 4,
    timeZone: 'Europe/Paris',
    currency: 'EUR',
    nextOffset: 1,
  })
  const body = calls[0]!.body as Record<string, unknown>
  assert.deepEqual(body.dateRanges, [{ startDate: '28daysAgo', endDate: 'today', name: 'current' }])
  assert.deepEqual(body.orderBys, [
    { metric: { metricName: 'sessions' }, desc: true },
    { dimension: { dimensionName: 'sessionDefaultChannelGroup' }, desc: false },
  ])
  assert.deepEqual(body.metricAggregations, ['TOTAL'])
})

test('Analytics only reads, and a property id must be one', () => {
  assert.ok(Object.values(googleAnalytics.operations).every((o) => !o.write))
  assert.throws(() =>
    googleAnalytics.operations.analytics_run_report!.input.parse({
      property: 'G-ABC123',
      startDate: 'today',
      metrics: ['sessions'],
    }),
  )
})

test('properties are listed across accounts, ids without their prefix', async () => {
  const { ctx } = fake([
    [
      'https://analyticsadmin.googleapis.com/v1beta/accountSummaries',
      () =>
        ok({
          accountSummaries: [
            {
              account: 'accounts/42',
              displayName: 'Lovarank',
              propertySummaries: [{ property: 'properties/123456', displayName: 'lovarank.com' }],
            },
          ],
        }),
    ],
  ])
  assert.deepEqual(await run(googleAnalytics, 'analytics_list_properties', ctx, {}), {
    accounts: [
      { account: '42', name: 'Lovarank', properties: [{ id: '123456', name: 'lovarank.com' }] },
    ],
  })
})
