// Google Analytics connector (GA4: Admin API and Data API), on the account's OAuth credential in the vault.
import { z } from 'zod'
import { ConnectorError, json, op, type ConnectorDefinition } from './types.js'

const ADMIN = 'https://analyticsadmin.googleapis.com/v1beta'
const DATA = 'https://analyticsdata.googleapis.com/v1beta'

/** A GA4 property id, as "123456789" or "properties/123456789". */
const property = z
  .string()
  .regex(/^(properties\/)?\d+$/, 'A GA4 property id, such as 123456789')
  .transform((p) => p.replace(/^properties\//, ''))
  .describe('The GA4 property id, e.g. 123456789 (from analytics_list_properties)')
const names = z.array(z.string().min(1).max(200))
const date = z
  .string()
  .regex(
    /^(\d{4}-\d{2}-\d{2}|today|yesterday|\d+daysAgo)$/,
    'YYYY-MM-DD, today, yesterday or NdaysAgo',
  )
const orderBy = z.object({
  name: z.string().max(200).describe('A dimension or metric of the report'),
  desc: z.boolean().default(true),
})
const filter = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    'A GA4 Data API FilterExpression, e.g. {"filter":{"fieldName":"country","stringFilter":{"value":"France"}}}; andGroup, orGroup and notExpression combine them',
  )

type Value = { value?: string }
type Report = {
  dimensionHeaders?: { name: string }[]
  metricHeaders?: { name: string; type?: string }[]
  rows?: { dimensionValues?: Value[]; metricValues?: Value[] }[]
  totals?: { dimensionValues?: Value[]; metricValues?: Value[] }[]
  rowCount?: number
  metadata?: { currencyCode?: string; timeZone?: string; dataLossFromOtherRow?: boolean }
}

const number = (v: string | undefined) => {
  const n = Number(v)
  return v === undefined || Number.isNaN(n) ? (v ?? null) : n
}

/** A report's rows as named fields, metrics as numbers: { country: "France", sessions: 120 }. */
export function reportRows(report: Report) {
  const dimensions = (report.dimensionHeaders ?? []).map((h) => h.name)
  const metrics = (report.metricHeaders ?? []).map((h) => h.name)
  const row = (r: { dimensionValues?: Value[]; metricValues?: Value[] }) => ({
    ...Object.fromEntries(dimensions.map((d, i) => [d, r.dimensionValues?.[i]?.value ?? null])),
    ...Object.fromEntries(metrics.map((m, i) => [m, number(r.metricValues?.[i]?.value)])),
  })
  return {
    rows: (report.rows ?? []).map(row),
    ...(report.totals?.length ? { totals: row(report.totals[0]!) } : {}),
    rowCount: report.rowCount ?? 0,
    ...(report.metadata?.timeZone ? { timeZone: report.metadata.timeZone } : {}),
    ...(report.metadata?.currencyCode ? { currency: report.metadata.currencyCode } : {}),
    ...(report.metadata?.dataLossFromOtherRow
      ? {
          note: 'Some rows were grouped into "(other)": the property has too many distinct values.',
        }
      : {}),
  }
}

/** Order by a metric when the report has one by that name, else by the dimension. */
const orderBys = (order: z.infer<typeof orderBy>[], metrics: string[]) =>
  order.map((o) =>
    metrics.includes(o.name)
      ? { metric: { metricName: o.name }, desc: o.desc }
      : { dimension: { dimensionName: o.name }, desc: o.desc },
  )

async function report(
  fetch: (url: string, init?: RequestInit) => Promise<Response>,
  url: string,
  body: object,
) {
  return reportRows(
    await json<Report>(
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    ),
  )
}

export const googleAnalytics: ConnectorDefinition = {
  kind: 'google_analytics',
  label: 'Google Analytics',
  auth: 'google',
  operations: {
    analytics_list_properties: op({
      description: 'List the Google Analytics (GA4) accounts and properties this account can see.',
      write: false,
      input: z.object({}),
      target: () => 'property list',
      run: async (ctx) => {
        type Summary = {
          account: string
          displayName?: string
          propertySummaries?: { property: string; displayName?: string; propertyType?: string }[]
        }
        const accounts: Summary[] = []
        let pageToken = ''
        do {
          const page = await json<{ accountSummaries?: Summary[]; nextPageToken?: string }>(
            await ctx.fetch(
              `${ADMIN}/accountSummaries?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
            ),
          )
          accounts.push(...(page.accountSummaries ?? []))
          pageToken = page.nextPageToken ?? ''
        } while (pageToken && accounts.length < 1000)
        return {
          accounts: accounts.map((a) => ({
            account: a.account.replace(/^accounts\//, ''),
            name: a.displayName,
            properties: (a.propertySummaries ?? []).map((p) => ({
              id: p.property.replace(/^properties\//, ''),
              name: p.displayName,
            })),
          })),
        }
      },
    }),
    analytics_list_data_streams: op({
      description:
        "A property's data streams: each website's URL and measurement id (G-…), and its apps.",
      write: false,
      input: z.object({ property }),
      target: (i) => `data streams of property ${i.property}`,
      run: async (ctx, i) => {
        const list = await json<{
          dataStreams?: {
            name: string
            type?: string
            displayName?: string
            webStreamData?: { measurementId?: string; defaultUri?: string }
            androidAppStreamData?: { packageName?: string }
            iosAppStreamData?: { bundleId?: string }
          }[]
        }>(await ctx.fetch(`${ADMIN}/properties/${i.property}/dataStreams?pageSize=200`))
        return {
          streams: (list.dataStreams ?? []).map((s) => ({
            id: s.name.split('/').pop(),
            name: s.displayName,
            type: s.type,
            ...(s.webStreamData ?? {}),
            ...(s.androidAppStreamData ?? {}),
            ...(s.iosAppStreamData ?? {}),
          })),
        }
      },
    }),
    analytics_get_metadata: op({
      description:
        "The dimensions and metrics a property's reports can use, by API name, including its custom ones.",
      write: false,
      input: z.object({
        property,
        search: z
          .string()
          .max(100)
          .optional()
          .describe(
            'Only those whose name or category contains this, e.g. "session" or "Ecommerce"',
          ),
      }),
      target: (i) => `report fields of property ${i.property}`,
      run: async (ctx, i) => {
        type Field = {
          apiName: string
          uiName?: string
          category?: string
          customDefinition?: boolean
        }
        const meta = await json<{ dimensions?: Field[]; metrics?: (Field & { type?: string })[] }>(
          await ctx.fetch(`${DATA}/properties/${i.property}/metadata`),
        )
        const term = i.search?.toLowerCase()
        const keep = (f: Field) =>
          !term || [f.apiName, f.uiName, f.category].some((s) => s?.toLowerCase().includes(term))
        const field = (f: Field) => ({
          name: f.apiName,
          label: f.uiName,
          category: f.category,
          ...(f.customDefinition ? { custom: true } : {}),
        })
        return {
          dimensions: (meta.dimensions ?? []).filter(keep).map(field),
          metrics: (meta.metrics ?? []).filter(keep).map((m) => ({ ...field(m), type: m.type })),
        }
      },
    }),
    analytics_run_report: op({
      description:
        'Run a GA4 report: metrics (sessions, activeUsers, screenPageViews, conversions, totalRevenue…) by dimensions (date, pagePath, sessionSource, sessionDefaultChannelGroup, country, deviceCategory…) over date ranges.',
      write: false,
      input: z.object({
        property,
        startDate: date.describe('YYYY-MM-DD, or today, yesterday, 28daysAgo'),
        endDate: date.default('today'),
        compareStartDate: date
          .optional()
          .describe('A second range to compare with; rows then get a dateRange field'),
        compareEndDate: date.optional(),
        metrics: names.min(1).max(10),
        dimensions: names.max(9).default([]),
        dimensionFilter: filter,
        metricFilter: filter,
        orderBy: z.array(orderBy).max(5).default([]),
        limit: z.number().int().min(1).max(10_000).default(100),
        offset: z.number().int().min(0).default(0).describe('For the next page of rows'),
        totals: z.boolean().default(false).describe('Also return the totals of the metrics'),
      }),
      target: (i) =>
        `${i.metrics.join(', ')}${i.dimensions.length ? ` by ${i.dimensions.join(', ')}` : ''} of property ${i.property} from ${i.startDate} to ${i.endDate}`,
      run: async (ctx, i) => {
        if (Boolean(i.compareStartDate) !== Boolean(i.compareEndDate))
          throw new ConnectorError('Give both compareStartDate and compareEndDate')
        const dateRanges = [
          { startDate: i.startDate, endDate: i.endDate, name: 'current' },
          ...(i.compareStartDate
            ? [{ startDate: i.compareStartDate, endDate: i.compareEndDate, name: 'previous' }]
            : []),
        ]
        const result = await report(ctx.fetch, `${DATA}/properties/${i.property}:runReport`, {
          dateRanges,
          metrics: i.metrics.map((name) => ({ name })),
          dimensions: i.dimensions.map((name) => ({ name })),
          ...(i.dimensionFilter ? { dimensionFilter: i.dimensionFilter } : {}),
          ...(i.metricFilter ? { metricFilter: i.metricFilter } : {}),
          ...(i.orderBy.length ? { orderBys: orderBys(i.orderBy, i.metrics) } : {}),
          limit: i.limit,
          offset: i.offset,
          ...(i.totals ? { metricAggregations: ['TOTAL'] } : {}),
        })
        return {
          ...result,
          ...(i.offset + result.rows.length < result.rowCount
            ? { nextOffset: i.offset + result.rows.length }
            : {}),
        }
      },
    }),
    analytics_run_realtime_report: op({
      description:
        'Activity in the last 30 minutes (60 on GA4 360): e.g. activeUsers by unifiedScreenName, country or deviceCategory.',
      write: false,
      input: z.object({
        property,
        metrics: names.min(1).max(10).default(['activeUsers']),
        dimensions: names.max(9).default([]),
        minutesAgo: z
          .number()
          .int()
          .min(1)
          .max(59)
          .optional()
          .describe('Only the last N minutes; default all 30'),
        limit: z.number().int().min(1).max(1000).default(50),
      }),
      target: (i) => `realtime ${i.metrics.join(', ')} of property ${i.property}`,
      run: async (ctx, i) =>
        report(ctx.fetch, `${DATA}/properties/${i.property}:runRealtimeReport`, {
          metrics: i.metrics.map((name) => ({ name })),
          dimensions: i.dimensions.map((name) => ({ name })),
          limit: i.limit,
          ...(i.minutesAgo
            ? { minuteRanges: [{ startMinutesAgo: i.minutesAgo - 1, endMinutesAgo: 0 }] }
            : {}),
        }),
    }),
  },
}
