import { organizationsName, type ConnectorDefinition } from './types.js'

/**
 * Neon's own MCP server: projects, branches and SQL on their Postgres databases. It
 * registers Brigade as a client itself, and the person picks the organization and
 * whether Brigade may change things on Neon's consent page. Its other tools (computes,
 * snapshots, query tuning…) come from the server, each marked read-only or not.
 */
export const neon: ConnectorDefinition = {
  kind: 'neon',
  label: 'Neon',
  auth: 'mcp',
  operations: {},
  mcp: {
    url: 'https://mcp.neon.tech/mcp',
    // No whoami: an account shows as its organization.
    account: { tool: 'list_organizations', name: organizationsName },
    tools: {
      list_projects: { description: 'List the Neon projects of the account.', write: false },
      describe_project: { description: 'Look up a Neon project by its id.', write: false },
      create_project: { description: 'Create a Neon project.', write: true },
      delete_project: { description: 'Delete a Neon project and all its data.', write: true },
      list_branches: { description: 'List the branches of a project.', write: false },
      describe_branch: {
        description: 'The databases, schemas, tables and views on a branch.',
        write: false,
      },
      create_branch: { description: 'Create a branch of a project.', write: true },
      delete_branch: { description: 'Delete a branch.', write: true },
      get_database_tables: { description: 'List the tables of a database.', write: false },
      describe_table_schema: {
        description: 'The columns, types and constraints of a table.',
        write: false,
      },
      run_sql: { description: 'Run one SQL statement on a database, read or write.', write: true },
      run_sql_transaction: {
        description: 'Run several SQL statements in one transaction.',
        write: true,
      },
      get_connection_string: {
        description: 'A connection string for a database, with its password.',
        write: false,
      },
      prepare_database_migration: {
        description: 'Try a schema migration on a temporary branch first.',
        write: true,
      },
      complete_database_migration: {
        description: 'Apply a tried migration to its branch.',
        write: true,
      },
      search: { description: "Search Neon's documentation.", write: false },
    },
  },
}
