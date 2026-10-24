import type { ConnectorDefinition } from './types.js'

/** Ahrefs' own MCP server. WIP: tools and account name come from a real sign-in. */
export const ahrefs: ConnectorDefinition = {
  kind: 'ahrefs',
  label: 'Ahrefs',
  auth: 'mcp',
  operations: {},
  mcp: {
    url: 'https://api.ahrefs.com/mcp/mcp',
    tools: {},
  },
}
