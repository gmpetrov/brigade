import { organizationsName, type ConnectorDefinition } from './types.js'

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
    // An account shows as the site(s) picked on Atlassian's consent page, as one member's
    // email would show the same for each site. The server's tools give a site's URL only;
    // Atlassian's accessible-resources takes the same token and gives its name.
    account: {
      url: 'https://api.atlassian.com/oauth/token/accessible-resources',
      name: organizationsName,
    },
    tools: {},
  },
}
