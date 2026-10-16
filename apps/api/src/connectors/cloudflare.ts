import type { ConnectorDefinition } from './types.js'

/**
 * Cloudflare's own MCP server: the whole Cloudflare API in a few tools ("code mode":
 * the teammate writes JavaScript that searches the API spec or calls the API). The
 * person picks what the account may do on Cloudflare's consent page.
 */
export const cloudflare: ConnectorDefinition = {
  kind: 'cloudflare',
  label: 'Cloudflare',
  auth: 'mcp',
  operations: {},
  mcp: {
    url: 'https://mcp.cloudflare.com/mcp',
    tools: {
      docs: { description: "Search Cloudflare's developer documentation.", write: false },
      search: {
        description: 'Search the Cloudflare API specification for the endpoints a task needs.',
        write: false,
      },
      execute: {
        description:
          'Call the Cloudflare API with JavaScript: read or change zones, Workers, storage and more.',
        write: true,
      },
      whoami: {
        description: 'The Cloudflare user or account the sign-in belongs to.',
        write: false,
      },
    },
  },
}
