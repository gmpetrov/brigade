import type { ConnectorDefinition } from './types.js'

/**
 * Google Cloud through Google's Cloud CLI MCP server: any gcloud or bq command, run by
 * Google as the account that signed in. Google registers no clients, so the sign-in goes
 * through Brigade's own (GOOGLE_MCP_CLIENT_ID). Each call names a project that must have
 * the Cloud CLI Execution API (cloudcli.googleapis.com) enabled.
 */
export const googleCloud: ConnectorDefinition = {
  kind: 'google_cloud',
  label: 'Google Cloud',
  auth: 'mcp',
  operations: {},
  mcp: {
    url: 'https://cloudcli.googleapis.com/mcp',
    tools: {
      run_gcloud_command: {
        description:
          'Run a gcloud command: read or change projects, Compute, GKE, Cloud Run, IAM and more.',
        write: true,
      },
      run_bq_command: {
        description: 'Run a bq command: query BigQuery, and manage its datasets and tables.',
        write: true,
      },
    },
  },
}
