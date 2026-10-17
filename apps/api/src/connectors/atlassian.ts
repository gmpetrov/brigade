import type { ConnectorDefinition } from './types.js'

/**
 * Jira and Confluence through Atlassian's Rovo MCP server (v2). It registers Brigade as a
 * client itself, and shows its most used tools plus a few to find and run the others. The
 * sign-in asks only for Jira, Confluence and search, not every Atlassian product it serves.
 */
export const atlassian: ConnectorDefinition = {
  kind: 'atlassian',
  label: 'Atlassian',
  auth: 'mcp',
  operations: {},
  mcp: {
    url: 'https://mcp.atlassian.com/v2/mcp',
    scopes: [
      'read:me',
      'read:account',
      'email',
      'offline_access',
      'read:jira:agent-interface',
      'search:jira:agent-interface',
      'write:jira:agent-interface',
      'read:confluence:agent-interface',
      'search:confluence:agent-interface',
      'write:confluence:agent-interface',
      'search:rovo:agent-interface',
    ],
    // An account shows as the email of who signed in.
    account: {
      tool: 'atlassianUserInfo',
      name: (o) => {
        const who = o as { email?: unknown; name?: unknown } | null
        return typeof who?.email === 'string'
          ? who.email
          : typeof who?.name === 'string'
            ? who.name
            : null
      },
    },
    tools: {},
  },
}
