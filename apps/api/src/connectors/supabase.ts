import { organizationsName, type ConnectorDefinition } from './types.js'

/**
 * Supabase's own MCP server: projects, their Postgres databases, Edge Functions and logs.
 * It registers Brigade as a client itself, and the person picks the organization on
 * Supabase's consent page. Its other tools (branches, storage, secrets…) come from the
 * server, each marked read-only or not.
 */
export const supabase: ConnectorDefinition = {
  kind: 'supabase',
  label: 'Supabase',
  auth: 'mcp',
  operations: {},
  mcp: {
    url: 'https://mcp.supabase.com/mcp',
    // No whoami: an account shows as its organization.
    account: { tool: 'list_organizations', name: organizationsName },
    tools: {
      list_organizations: {
        description: 'List the organizations the account belongs to.',
        write: false,
      },
      list_projects: { description: 'List the Supabase projects of the account.', write: false },
      get_project: { description: 'Look up a project, with its status.', write: false },
      create_project: {
        description: 'Create a Supabase project, which may cost money.',
        write: true,
      },
      pause_project: { description: 'Pause a project.', write: true },
      restore_project: { description: 'Restore a paused project.', write: true },
      list_tables: { description: 'List the tables of a project’s database.', write: false },
      list_migrations: { description: 'List the migrations applied to a database.', write: false },
      apply_migration: { description: 'Apply a schema migration to a database.', write: true },
      execute_sql: { description: 'Run SQL on a project’s database, read or write.', write: true },
      query_logs: { description: 'Read a project’s logs, by service.', write: false },
      get_advisors: {
        description: 'Security and performance advice on a project’s database.',
        write: false,
      },
      list_edge_functions: { description: 'List a project’s Edge Functions.', write: false },
      deploy_edge_function: { description: 'Deploy an Edge Function.', write: true },
      generate_typescript_types: {
        description: 'TypeScript types for a project’s database schema.',
        write: false,
      },
      search_docs: { description: "Search Supabase's documentation.", write: false },
    },
  },
}
