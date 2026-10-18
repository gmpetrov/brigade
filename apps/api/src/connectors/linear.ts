import type { ConnectorDefinition } from './types.js'

/**
 * Linear's own MCP server: issues, projects, cycles, documents and comments, as the
 * person who signed in. Linear registers Brigade as a client itself (dynamic client
 * registration), and the person picks the workspace on Linear's consent page.
 */
export const linear: ConnectorDefinition = {
  kind: 'linear',
  label: 'Linear',
  auth: 'mcp',
  operations: {},
  mcp: {
    url: 'https://mcp.linear.app/mcp',
    tools: {},
  },
}
