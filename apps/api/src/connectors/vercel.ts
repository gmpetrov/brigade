import type { ConnectorDefinition } from './types.js'

/**
 * Vercel's own MCP server: teams, projects and deployments, their build and runtime logs, and
 * Vercel's docs, as the person who signed in. Vercel refuses to register Brigade as a client
 * (its dynamic client registration accepts only redirect URIs it approved), but it reads
 * Brigade's client ID metadata document instead (mcp.ts). Its tools come from the server: those
 * it does not mark read-only count as writes.
 */
export const vercel: ConnectorDefinition = {
  kind: 'vercel',
  label: 'Vercel',
  auth: 'mcp',
  operations: {},
  mcp: {
    url: 'https://mcp.vercel.com',
    tools: {},
  },
}
