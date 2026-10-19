// Google Search Console connector (Search Console API), on the account's OAuth credential in the vault.
import { z } from 'zod'
import { json, op, type ConnectorDefinition } from './types.js'

const API = 'https://searchconsole.googleapis.com/webmasters/v3'
const INSPECT = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect'

const siteUrl = z
  .string()
  .min(1)
  .max(500)
  .describe(
    'The property as Search Console names it: "https://example.com/" for a URL-prefix property, "sc-domain:example.com" for a Domain property',
  )
const date = z.iso.date().describe('YYYY-MM-DD, in Pacific Time as Search Console counts days')
const dimension = z.enum(['query', 'page', 'country', 'device', 'searchAppearance', 'date', 'hour'])

const site = (url: string, suffix = '') => `${API}/sites/${encodeURIComponent(url)}${suffix}`

type Row = { keys?: string[]; clicks: number; impressions: number; ctr: number; position: number }
type Sitemap = {
  path: string
  lastSubmitted?: string
  lastDownloaded?: string
  isPending?: boolean
  isSitemapsIndex?: boolean
  type?: string
  warnings?: string
  errors?: string
  contents?: { type: string; submitted?: string; indexed?: string }[]
}

/** A row as named fields: { query: "…", page: "…", clicks, impressions, ctr, position }. */
export const searchRow = (dimensions: readonly string[], row: Row) => ({
  ...Object.fromEntries(dimensions.map((d, i) => [d, row.keys?.[i]])),
  clicks: row.clicks,
  impressions: row.impressions,
  ctr: Math.round(row.ctr * 10_000) / 10_000,
  position: Math.round(row.position * 10) / 10,
})

export const googleSearchConsole: ConnectorDefinition = {
  kind: 'google_search_console',
  label: 'Google Search Console',
  auth: 'google',
  operations: {
    search_console_list_sites: op({
      description:
        'List the Search Console properties this account can see, with its permission on each.',
      write: false,
      input: z.object({}),
      target: () => 'site list',
      run: async (ctx) => {
        const list = await json<{ siteEntry?: { siteUrl: string; permissionLevel: string }[] }>(
          await ctx.fetch(`${API}/sites`),
        )
        return {
          sites: (list.siteEntry ?? []).map((s) => ({
            siteUrl: s.siteUrl,
            permission: s.permissionLevel,
          })),
        }
      },
    }),
    search_console_query: op({
      description:
        'Search performance (clicks, impressions, CTR, average position) for a property over a date range, grouped by query, page, country, device, search appearance, date or hour. Data lags 2 to 3 days; recent days need dataState "all".',
      write: false,
      input: z.object({
        siteUrl,
        startDate: date,
        endDate: date,
        dimensions: z.array(dimension).max(4).default([]).describe('Group by these, in order'),
        type: z
          .enum(['web', 'image', 'video', 'news', 'discover', 'googleNews'])
          .default('web')
          .describe('Which search results'),
        filters: z
          .array(
            z.object({
              dimension: z.enum(['query', 'page', 'country', 'device', 'searchAppearance']),
              operator: z
                .enum([
                  'equals',
                  'notEquals',
                  'contains',
                  'notContains',
                  'includingRegex',
                  'excludingRegex',
                ])
                .default('equals'),
              expression: z
                .string()
                .max(4096)
                .describe(
                  'Country as ISO 3166-1 alpha-3 (fra); device as DESKTOP, MOBILE or TABLET',
                ),
            }),
          )
          .max(10)
          .default([])
          .describe('All must match'),
        aggregationType: z
          .enum(['auto', 'byPage', 'byProperty'])
          .default('auto')
          .describe('byPage counts each page apart; byProperty counts a result once per property'),
        dataState: z
          .enum(['final', 'all', 'hourly_all'])
          .default('final')
          .describe('final: settled data only. all: include fresh data. hourly_all: with hour'),
        rowLimit: z.number().int().min(1).max(5000).default(100),
        startRow: z.number().int().min(0).default(0).describe('For the next page of rows'),
      }),
      target: (i) =>
        `${i.type} performance of ${i.siteUrl} from ${i.startDate} to ${i.endDate}${i.dimensions.length ? ` by ${i.dimensions.join(', ')}` : ''}`,
      run: async (ctx, i) => {
        const result = await json<{ rows?: Row[]; responseAggregationType?: string }>(
          await ctx.fetch(site(i.siteUrl, '/searchAnalytics/query'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              startDate: i.startDate,
              endDate: i.endDate,
              dimensions: i.dimensions,
              type: i.type,
              aggregationType: i.aggregationType,
              dataState: i.dataState,
              rowLimit: i.rowLimit,
              startRow: i.startRow,
              ...(i.filters.length ? { dimensionFilterGroups: [{ filters: i.filters }] } : {}),
            }),
          }),
        )
        const rows = (result.rows ?? []).map((r) => searchRow(i.dimensions, r))
        return {
          rows,
          aggregation: result.responseAggregationType,
          ...(rows.length === i.rowLimit ? { nextStartRow: i.startRow + rows.length } : {}),
        }
      },
    }),
    search_console_inspect_url: op({
      description:
        "Google's index status of one URL of a property: whether it is indexed, why not, the last crawl, the canonical Google chose, mobile usability and rich results.",
      write: false,
      input: z.object({
        siteUrl,
        url: z.url().max(2000).describe('The full URL, inside the property'),
        languageCode: z.string().max(20).default('en-US').describe('For the messages'),
      }),
      target: (i) => `index status of ${i.url}`,
      run: async (ctx, i) => {
        const result = await json<{ inspectionResult?: unknown }>(
          await ctx.fetch(INSPECT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              inspectionUrl: i.url,
              siteUrl: i.siteUrl,
              languageCode: i.languageCode,
            }),
          }),
        )
        return result.inspectionResult ?? {}
      },
    }),
    search_console_list_sitemaps: op({
      description:
        'List the sitemaps submitted for a property, with when Google last read each, its errors and how many URLs it holds.',
      write: false,
      input: z.object({ siteUrl }),
      target: (i) => `sitemaps of ${i.siteUrl}`,
      run: async (ctx, i) => {
        const list = await json<{ sitemap?: Sitemap[] }>(
          await ctx.fetch(site(i.siteUrl, '/sitemaps')),
        )
        return { sitemaps: list.sitemap ?? [] }
      },
    }),
    search_console_submit_sitemap: op({
      description: 'Submit a sitemap for a property, or ask Google to read it again.',
      write: true,
      input: z.object({
        siteUrl,
        sitemapUrl: z.url().max(2000).describe('e.g. https://example.com/sitemap.xml'),
      }),
      target: (i) => `sitemap ${i.sitemapUrl} of ${i.siteUrl}`,
      run: async (ctx, i) => {
        await json(
          await ctx.fetch(site(i.siteUrl, `/sitemaps/${encodeURIComponent(i.sitemapUrl)}`), {
            method: 'PUT',
          }),
        )
        return { submitted: i.sitemapUrl }
      },
    }),
    search_console_delete_sitemap: op({
      description:
        "Remove a sitemap from a property's list. Google keeps the URLs it already knows.",
      write: true,
      input: z.object({ siteUrl, sitemapUrl: z.url().max(2000) }),
      target: (i) => `sitemap ${i.sitemapUrl} of ${i.siteUrl}`,
      run: async (ctx, i) => {
        await json(
          await ctx.fetch(site(i.siteUrl, `/sitemaps/${encodeURIComponent(i.sitemapUrl)}`), {
            method: 'DELETE',
          }),
        )
        return { deleted: i.sitemapUrl }
      },
    }),
    search_console_add_site: op({
      description:
        'Add a property to this account. It stays unverified until its owner verifies it in Search Console (a DNS record, an HTML file or a meta tag); until then it shows no data.',
      write: true,
      input: z.object({ siteUrl }),
      target: (i) => `property ${i.siteUrl}`,
      run: async (ctx, i) => {
        await json(await ctx.fetch(site(i.siteUrl), { method: 'PUT' }))
        return {
          added: i.siteUrl,
          verify: `https://search.google.com/search-console/ownership?resource_id=${encodeURIComponent(i.siteUrl)}`,
        }
      },
    }),
  },
}
