import { z } from 'zod'
import type { ConnectorDefinition, ConnectorKind, TriggerDefinition } from './types.js'
import { cloudflare } from './cloudflare.js'
import { gmail } from './gmail.js'
import { github } from './github.js'
import { googleCalendar } from './google-calendar.js'
import { googleAnalytics } from './google-analytics.js'
import { googleCloud } from './google-cloud.js'
import { googleSearchConsole } from './google-search-console.js'
import { stripe } from './stripe.js'

export const connectors: Partial<Record<ConnectorDefinition['kind'], ConnectorDefinition>> = {
  gmail,
  google_calendar: googleCalendar,
  google_search_console: googleSearchConsole,
  google_analytics: googleAnalytics,
  stripe,
  github,
  cloudflare,
  google_cloud: googleCloud,
}

/**
 * A custom app's one trigger: any event posted to the trigger's own URL. The
 * app is not a connector (nothing to call), so it is defined here.
 */
const customApp: Record<string, TriggerDefinition> = {
  received: {
    label: 'Event received',
    description: 'The app posts an event to the URL.',
    events: ['received'],
    describe: ({ type, payload }) => ({
      title:
        typeof payload === 'object' && payload && 'type' in payload ? String(payload.type) : type,
      summary: '',
    }),
  },
}

/** The events that can start threads on a kind of connection. */
export const triggersOf = (kind: ConnectorKind): Record<string, TriggerDefinition> =>
  kind === 'webhook' ? customApp : (connectors[kind]?.triggers ?? {})

/** The catalog as the dashboard shows it. */
export const triggerCatalog = () =>
  Object.fromEntries(
    (
      [
        'gmail',
        'google_calendar',
        'google_search_console',
        'google_analytics',
        'stripe',
        'github',
        'cloudflare',
        'google_cloud',
        'mcp',
        'webhook',
      ] as const
    ).map((kind) => [
      kind,
      Object.entries(triggersOf(kind)).map(([event, t]) => ({
        event,
        label: t.label,
        description: t.description,
        options: t.options ?? [],
      })),
    ]),
  )

/**
 * The built-in Apps, as the dashboard shows them. One App asks for one consent:
 * Gmail, Google Calendar, Search Console and Analytics are Apps of their own, each with
 * its own Google sign-in.
 * personal: an account someone connects is theirs by default (reach mine).
 */
export const appCatalog: Record<
  ConnectorKind,
  {
    name: string
    description: string
    developer: string | null
    category: string
    personal: boolean
    /** A GitHub repository of skills that comes with the App, imported with its first account. */
    skills?: string
  }
> = {
  gmail: {
    name: 'Gmail',
    description: 'Search, read, draft and send email.',
    developer: 'Google',
    category: 'Productivity',
    personal: true,
  },
  google_calendar: {
    name: 'Google Calendar',
    description: 'Search events and schedule meetings.',
    developer: 'Google',
    category: 'Productivity',
    personal: true,
  },
  google_search_console: {
    name: 'Google Search Console',
    description:
      'Search clicks, impressions and positions by query and page, index status of URLs, and sitemaps.',
    developer: 'Google',
    category: 'Marketing',
    personal: true,
  },
  google_analytics: {
    name: 'Google Analytics',
    description: 'GA4 reports on traffic, sources, pages and conversions, and realtime activity.',
    developer: 'Google',
    category: 'Marketing',
    personal: true,
  },
  stripe: {
    name: 'Stripe',
    description: 'Look up customers, payments, invoices and subscriptions, and issue refunds.',
    developer: 'Stripe',
    category: 'Finance',
    personal: false,
  },
  github: {
    name: 'GitHub',
    description: 'Repositories, issues and pull requests. Teammates also push code to them.',
    developer: 'GitHub',
    category: 'Developer tools',
    personal: false,
  },
  cloudflare: {
    name: 'Cloudflare',
    description:
      'Build, test and deploy on Cloudflare, with the Cloudflare MCP server and its platform skills.',
    developer: 'Cloudflare',
    category: 'Developer tools',
    personal: false,
    skills: 'https://github.com/cloudflare/skills',
  },
  google_cloud: {
    name: 'Google Cloud',
    description:
      'Run gcloud and bq commands on your Google Cloud projects, with Google’s Cloud CLI MCP server.',
    developer: 'Google',
    category: 'Developer tools',
    // A Google sign-in is someone's own account, as for Gmail.
    personal: true,
  },
  mcp: {
    name: 'MCP server',
    description:
      'Any MCP server, by its URL. Sign in with the provider or paste a key; teammates get its tools.',
    developer: null,
    category: 'Custom',
    // A sign-in is someone's own account: kept to their threads until they open it to every thread.
    personal: true,
  },
  webhook: {
    name: 'Custom app',
    description: 'Any app or service that can send a webhook. Each event starts a thread.',
    developer: null,
    category: 'Custom',
    personal: false,
  },
}

/**
 * An MCP server's tool as teammates call it: the App's kind first (or, for a server
 * added by its URL, its prefix), so `search` on Cloudflare is cloudflare_search and
 * cannot clash with another App's.
 */
export const mcpToolName = (prefix: string, tool: string) => `${prefix}_${tool}`.slice(0, 64)

/** Every tool of a kind, for the App's tool switches. An MCP server's are the ones Brigade knows. */
export const toolCatalog = (kind: ConnectorKind) => {
  const mcp = connectors[kind]?.mcp
  if (mcp)
    return Object.entries(mcp.tools).map(([name, t]) => ({
      name: mcpToolName(kind, name),
      description: t.description,
      write: t.write,
    }))
  return Object.entries(connectors[kind]?.operations ?? {}).map(([name, o]) => ({
    name,
    description: o.description,
    write: o.write,
  }))
}

/**
 * The operations a teammate may see for a grant: reads always, writes only with
 * read_write, and none the App turned off.
 */
export function operationSpecs(
  kind: ConnectorDefinition['kind'],
  scope: 'read' | 'read_write',
  disabled: readonly string[] = [],
) {
  const connector = connectors[kind]
  if (!connector) return []
  return Object.entries(connector.operations)
    .filter(([name, o]) => (scope === 'read_write' || !o.write) && !disabled.includes(name))
    .map(([name, o]) => ({
      name,
      description: o.description,
      write: o.write,
      inputSchema: z.toJSONSchema(o.input, { io: 'input' }) as Record<string, unknown>,
      ...(o.files ? { filesField: o.files } : {}),
    }))
}

export type { ConnectorDefinition }
