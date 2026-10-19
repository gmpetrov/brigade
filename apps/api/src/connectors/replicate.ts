import type { ConnectorDefinition } from './types.js'

const read = (description: string) => ({ description, write: false })
const write = (description: string) => ({ description, write: true })

/**
 * Replicate's own MCP server: its HTTP API as tools, to find, compare and run models, and to
 * manage deployments, models and trainings. Replicate registers Brigade as a client itself
 * (dynamic client registration); on its consent page the person pastes a Replicate API token,
 * which the server keeps and uses for them. Predictions and trainings run on that account's
 * billing, so they count as writes.
 */
export const replicate: ConnectorDefinition = {
  kind: 'replicate',
  label: 'Replicate',
  auth: 'mcp',
  operations: {},
  mcp: {
    url: 'https://mcp.replicate.com/mcp',
    // The token's user or organization, by its username.
    account: { tool: 'get_account', name: replicateAccountName },
    tools: {
      search: read('Search models, collections and docs.'),
      search_docs: read('Search the docs on using Replicate’s API.'),
      get_account: read('The user or organization the token belongs to.'),
      list_models: read('List the public models.'),
      get_models: read('Read a model: its description, latest version and input schema.'),
      get_models_readme: read('A model’s README.'),
      list_models_examples: read('A model’s example predictions.'),
      list_models_versions: read('List a model’s versions.'),
      get_models_versions: read('Read a model version and its input schema.'),
      list_collections: read('List the curated collections of models.'),
      get_collections: read('Read a collection and its models.'),
      list_hardware: read('List the hardware models can run on.'),
      create_predictions: write('Run a model version, billed to the account.'),
      create_models_predictions: write('Run an official model, billed to the account.'),
      create_deployments_predictions: write('Run a deployment, billed to the account.'),
      list_predictions: read('List the predictions run.'),
      get_predictions: read('Read a prediction: its status, input and output.'),
      cancel_predictions: write('Cancel a running prediction.'),
      list_deployments: read('List the deployments.'),
      get_deployments: read('Read a deployment and its configuration.'),
      create_deployments: write('Create a deployment.'),
      update_deployments: write('Change a deployment’s version, hardware or instances.'),
      create_models: write('Create a model.'),
      update_models: write('Change a model’s details.'),
      list_trainings: read('List the trainings.'),
      get_trainings: read('Read a training: its status and output.'),
      create_trainings: write('Fine-tune a model, billed to the account.'),
      cancel_trainings: write('Cancel a running training.'),
      // A secret: not for a read-only grant.
      get_default_webhooks_secret: write('The signing secret of the account’s webhooks.'),
    },
  },
}

/**
 * The Replicate account as a row shows it: its username. get_account answers Replicate's
 * GET /v1/account, { type: 'user' | 'organization', username, name, github_url, avatar_url }.
 */
export function replicateAccountName(output: unknown): string | null {
  const username = (output as { username?: unknown } | null)?.username
  return typeof username === 'string' && username.length > 0 ? username : null
}
