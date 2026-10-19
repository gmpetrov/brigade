import type { ConnectorDefinition } from './types.js'

const read = (description: string) => ({ description, write: false })
const write = (description: string) => ({ description, write: true })

/**
 * OpenRouter's own MCP server: its live model catalog, prices, rankings and benchmarks, the
 * account's credits and generations, and test messages to any model. OpenRouter registers
 * Brigade as a client itself (dynamic client registration); on its consent page the person
 * approves a key for this connection alone, with a spend cap ($10 by default). The key lasts
 * 7 days and comes with no refresh token, so the account then asks to reconnect. Messages and
 * images spend the account's credits, so they count as writes.
 */
export const openrouter: ConnectorDefinition = {
  kind: 'openrouter',
  label: 'OpenRouter',
  auth: 'mcp',
  operations: {},
  mcp: {
    url: 'https://mcp.openrouter.ai/mcp',
    // The token is an OpenRouter API key: the key's own route says which one it is.
    account: { url: 'https://openrouter.ai/api/v1/key', name: openrouterAccountName },
    tools: {
      'send-message': write('Send a message to a model and get its reply, billed to the account.'),
      'generate-image': write('Generate an image from a prompt, billed to the account.'),
      'list-models': read('Search the model catalog by price, context, modality and benchmarks.'),
      'get-model': read('Read a model’s full details.'),
      'list-model-endpoints': read('The providers serving a model: price, latency, data policy.'),
      'list-providers': read('List the providers requests can be routed to.'),
      'list-daily-model-rankings': read('The most used and trending models by tokens.'),
      'list-app-rankings': read('The apps sending the most traffic to OpenRouter.'),
      'get-credits': read('The account’s remaining credits.'),
      'get-generation': read('A generation’s cost, tokens and provider.'),
      'list-benchmarks': read('Quality scores from Artificial Analysis and Design Arena.'),
      'list-task-classifications': read('What OpenRouter traffic is used for, with the top models.'),
      'search-docs': read('Search the OpenRouter docs.'),
      'send-feedback': write('Report a problem with one of the account’s generations.'),
      'spawn-ori-eval': read('Instructions for running a model eval with Ori.'),
      'install-ori-harness': read('Instructions for installing the Ori harness.'),
      ping: read('Check the connection.'),
    },
  },
}

/** The OpenRouter account as a row shows it. TODO: from a real reply. */
export function openrouterAccountName(output: unknown): string | null {
  void output
  return null
}
