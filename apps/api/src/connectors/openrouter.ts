import type { ConnectorDefinition } from './types.js'

const read = (description: string) => ({ description, write: false })
const write = (description: string) => ({ description, write: true })

/**
 * OpenRouter's own MCP server: its live model catalog, prices, rankings and benchmarks, the
 * account's credits, generations, presets and batches, and requests to any model (text,
 * images, speech, transcription). OpenRouter registers Brigade as a client itself (dynamic
 * client registration); on its consent page the person approves a key for this connection
 * alone, with a spend cap ($10 by default). The key lasts 7 days and comes with no refresh
 * token, so the account then asks to reconnect. What runs a model spends the account's
 * credits, so it counts as a write, as the server marks it.
 */
export const openrouter: ConnectorDefinition = {
  kind: 'openrouter',
  label: 'OpenRouter',
  auth: 'mcp',
  operations: {},
  mcp: {
    url: 'https://mcp.openrouter.ai/mcp',
    // The token is an OpenRouter API key, and no tool says whose: the key's own route tells a
    // personal account from an organization's, though without a name or email (those need a
    // management key).
    account: { url: 'https://openrouter.ai/api/v1/key', name: openrouterAccountName },
    tools: {
      'send-message': write('Send a message to a model and get its reply, billed to the account.'),
      'generate-image': write('Generate an image from a prompt, billed to the account.'),
      'generate-speech': write('Turn text into speech, billed to the account.'),
      'transcribe-audio': write('Transcribe an audio file, billed to the account.'),
      'send-batch': write('Send many requests as one batch, billed to the account.'),
      'get-batch': read('A batch’s status and, once done, its results.'),
      'list-batches': read('List the batches sent from the key’s workspace.'),
      'list-models': read('Search the model catalog by price, context, modality and benchmarks.'),
      'get-model': read('Read a model’s full details.'),
      'list-model-endpoints': read('The providers serving a model: price, latency, data policy.'),
      'get-endpoint-uptime-history': read(
        'Each provider’s hourly uptime for a model, over 72 hours.',
      ),
      'list-providers': read('List the providers requests can be routed to.'),
      'list-daily-model-rankings': read('The most used and trending models by tokens.'),
      'list-app-rankings': read('The apps sending the most traffic to OpenRouter.'),
      'list-benchmarks': read('Quality scores from Artificial Analysis and Design Arena.'),
      'list-task-classifications': read(
        'What OpenRouter traffic is used for, with the top models.',
      ),
      'get-credits': read('The account’s remaining credits.'),
      'get-generation': read('A generation’s cost, tokens and provider.'),
      'list-presets': read('List the saved presets: model, system prompt and settings.'),
      'get-preset': read('Read a saved preset.'),
      'send-feedback': write('Report a problem with one of the account’s generations.'),
      'search-docs': read('Search the OpenRouter docs.'),
      'spawn-ori-eval': read('Instructions for running a model eval with Ori.'),
      'install-ori-harness': read('Instructions for installing the Ori harness.'),
      ping: read('Check the connection.'),
    },
  },
}

/**
 * The OpenRouter account as a row shows it: personal, or an organization's. GET /api/v1/key
 * answers { data: { label, limit, usage, expires_at, creator_user_id, organization_id,
 * workspace_id, ... } }, with organization_id null for a person's own account. Its names are
 * only for management keys.
 */
export function openrouterAccountName(output: unknown): string | null {
  const key = (output as { data?: { organization_id?: unknown } } | null)?.data
  if (!key || !('organization_id' in key)) return null
  return key.organization_id ? 'Organization account' : 'Personal account'
}
