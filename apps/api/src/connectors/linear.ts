import type { ConnectorDefinition } from './types.js'

/**
 * Linear's own MCP server: issues, projects, cycles, documents and comments, as the
 * person who signed in. Linear registers Brigade as a client itself (dynamic client
 * registration), and the person picks the workspace on Linear's consent page. Its tools
 * come from the server: those it does not mark read-only count as writes.
 */
export const linear: ConnectorDefinition = {
  kind: 'linear',
  label: 'Linear',
  auth: 'mcp',
  operations: {},
  mcp: {
    url: 'https://mcp.linear.app/mcp',
    // One sign-in reaches one Linear workspace: an account shows as its name, as the
    // member's email would show the same for each of their workspaces.
    account: { tool: 'get_workspace', name: linearAccountName },
    tools: {},
  },
}

/** The Linear account as a row shows it: its workspace's name. */
export function linearAccountName(output: unknown): string | null {
  const name = (output as { name?: unknown } | null)?.name
  return typeof name === 'string' && name.length > 0 ? name : null
}
