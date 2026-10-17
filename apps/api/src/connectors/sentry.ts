import type { ConnectorDefinition } from './types.js'

/**
 * Sentry's own MCP server: production errors, traces, logs and releases of every
 * organization the person belongs to. It registers Brigade as a client itself; the
 * person picks what the account may do on Sentry's consent page. Its less common
 * tools sit behind search_sentry_tools and execute_sentry_tool, whoami among them.
 */
export const sentry: ConnectorDefinition = {
  kind: 'sentry',
  label: 'Sentry',
  auth: 'mcp',
  operations: {},
  mcp: {
    url: 'https://mcp.sentry.dev/mcp',
    whoami: { tool: 'execute_sentry_tool', arguments: { name: 'whoami', arguments: {} } },
    tools: {
      find_organizations: {
        description: 'The Sentry organizations the account belongs to.',
        write: false,
      },
      find_projects: { description: "An organization's Sentry projects.", write: false },
      search_issues: {
        description: 'Find grouped issues: unresolved errors, regressions, by project or release.',
        write: false,
      },
      get_sentry_resource: {
        description:
          'Read an issue, event, trace or other Sentry page by its URL or ID, with its stack trace.',
        write: false,
      },
      search_errors: {
        description: 'Search error events and count them, for trends and statistics.',
        write: false,
      },
      search_logs: { description: 'Search the logs Sentry keeps.', write: false },
      search_traces: { description: 'Search traces and spans, for slow requests.', write: false },
      search_sentry_tools: {
        description: "Find Sentry's other tools, such as releases, monitors and dashboards.",
        write: false,
      },
      update_issue: {
        description: 'Resolve, ignore, reopen or assign an issue.',
        write: true,
      },
      analyze_issue_with_seer: {
        description: "Ask Seer, Sentry's AI, for an issue's root cause and a fix.",
        write: true,
      },
      execute_sentry_tool: {
        description: 'Run one of the other tools search_sentry_tools found.',
        write: true,
      },
    },
  },
}
