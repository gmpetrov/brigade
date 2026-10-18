import { z } from 'zod'
import type { ConnectorDefinition, ConnectorKind, TriggerDefinition } from './types.js'
import { cloudflare } from './cloudflare.js'
import { gmail } from './gmail.js'
import { github } from './github.js'
import { googleCalendar } from './google-calendar.js'
import { googleCloud } from './google-cloud.js'
import { googleDocs, googleDrive, googleSheets } from './google-drive.js'
import { neon } from './neon.js'
import { atlassian } from './atlassian.js'
import { notion } from './notion.js'
import { linear } from './linear.js'
import { stripe } from './stripe.js'
import { supabase } from './supabase.js'

export const connectors: Partial<Record<ConnectorDefinition['kind'], ConnectorDefinition>> = {
  gmail,
  google_calendar: googleCalendar,
  google_drive: googleDrive,
  google_docs: googleDocs,
  google_sheets: googleSheets,
  stripe,
  github,
  cloudflare,
  google_cloud: googleCloud,
  neon,
  supabase,
  atlassian,
  notion,
  linear,
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
        'google_drive',
        'google_docs',
        'google_sheets',
        'stripe',
        'github',
        'cloudflare',
        'google_cloud',
        'neon',
        'supabase',
        'atlassian',
        'notion',
        'linear',
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
 * Gmail, Google Calendar, Drive, Docs and Sheets are five Apps, each with its own Google sign-in.
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
  google_drive: {
    name: 'Google Drive',
    description: 'Search, read, upload, organize and share files in Drive.',
    developer: 'Google',
    category: 'Productivity',
    personal: true,
  },
  google_docs: {
    name: 'Google Docs',
    description: 'Read, write and edit documents.',
    developer: 'Google',
    category: 'Productivity',
    personal: true,
  },
  google_sheets: {
    name: 'Google Sheets',
    description: 'Read and update spreadsheets, add rows and create new ones.',
    developer: 'Google',
    category: 'Productivity',
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
  neon: {
    name: 'Neon',
    description:
      'Manage Neon Postgres projects and branches, and query their databases, with Neon’s MCP server.',
    developer: 'Neon',
    category: 'Developer tools',
    // A Neon sign-in reaches every database of the account: kept to its member's threads.
    personal: true,
  },
  supabase: {
    name: 'Supabase',
    description:
      'Manage Supabase projects, query their databases and deploy Edge Functions, with Supabase’s MCP server.',
    developer: 'Supabase',
    category: 'Developer tools',
    personal: true,
  },
  atlassian: {
    name: 'Atlassian',
    description:
      'Search, create and update Jira issues and Confluence pages, with Atlassian’s Rovo MCP server.',
    developer: 'Atlassian',
    category: 'Productivity',
    // An Atlassian sign-in is someone's own account, with their own access to each site.
    personal: true,
    skills: 'https://github.com/atlassian/atlassian-mcp-server',
  },
  notion: {
    name: 'Notion',
    description: 'Search, read and write your team’s docs and wikis, with Notion’s own MCP server.',
    developer: 'Notion',
    category: 'Productivity',
    // A Notion sign-in reaches what its member can see, private pages included.
    personal: true,
  },
  linear: {
    name: 'Linear',
    description:
      'Find, create and update issues, projects and comments, with Linear’s MCP server. With GitHub, teammates take a ticket and open its pull request.',
    developer: 'Linear',
    category: 'Productivity',
    // A Linear sign-in is someone's own account, kept to their threads until they share it.
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
 * cannot clash with another App's. A tool already named for its server (Notion's
 * notion-search) keeps one prefix: notion_search, not notion_notion-search.
 */
export const mcpToolName = (prefix: string, tool: string) =>
  `${prefix}_${tool.replace(new RegExp(`^${prefix}[-_]`), '')}`.slice(0, 64)

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
