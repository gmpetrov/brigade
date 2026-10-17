import type { ConnectorDefinition } from './types.js'

/**
 * Notion's own MCP server: the workspace's pages, databases and comments, as the member
 * who signed in sees them. Brigade registers itself as a client (dynamic client
 * registration); the person picks the Notion workspace on Notion's consent page. The
 * server offers more tools than these (agents, skills, folders): those it does not mark
 * read-only count as writes.
 */
export const notion: ConnectorDefinition = {
  kind: 'notion',
  label: 'Notion',
  auth: 'mcp',
  operations: {},
  mcp: {
    url: 'https://mcp.notion.com/mcp',
    // One sign-in reaches one Notion workspace: an account shows as its name.
    account: { tool: 'notion-get-self', name: notionAccountName },
    tools: {
      'notion-search': {
        description: 'Search the Notion workspace and its connected sources, or find a member.',
        write: false,
      },
      'notion-fetch': {
        description: 'Read a page, database or data source by its URL or ID.',
        write: false,
      },
      'notion-query-data-sources': {
        description: 'Query a database’s rows, with filters, or run one of its views.',
        write: false,
      },
      'notion-get-comments': { description: 'List the comments on a page.', write: false },
      'notion-get-teams': { description: 'List the workspace’s teamspaces.', write: false },
      'notion-get-users': { description: 'List the workspace’s members.', write: false },
      'notion-get-self': {
        description: 'The Notion user and workspace the sign-in belongs to.',
        write: false,
      },
      'notion-create-pages': {
        description: 'Create pages, or rows in a database, with their content.',
        write: true,
      },
      'notion-update-page': {
        description: 'Change a page’s properties or content.',
        write: true,
      },
      'notion-move-pages': {
        description: 'Move pages or databases under another parent.',
        write: true,
      },
      'notion-duplicate-page': { description: 'Duplicate a page.', write: true },
      'notion-create-database': {
        description: 'Create a database with its properties.',
        write: true,
      },
      'notion-update-data-source': {
        description: 'Change a database’s properties, name or description.',
        write: true,
      },
      'notion-delete-pages': { description: 'Move pages to the trash.', write: true },
      'notion-delete-databases': { description: 'Move databases to the trash.', write: true },
      'notion-create-comment': {
        description: 'Comment on a page or reply in a discussion.',
        write: true,
      },
    },
  },
}

/**
 * The Notion account as a row shows it: the workspace picked on Notion's consent page, as
 * notion-get-self gives it ({ workspace: { name }, user: { email } }), else the member's email.
 */
export function notionAccountName(output: unknown): string | null {
  const self = output as { workspace?: { name?: unknown }; user?: { email?: unknown } } | null
  const found = [self?.workspace?.name, self?.user?.email]
  return (found.find((v) => typeof v === 'string' && v.length > 0) as string | undefined) ?? null
}
