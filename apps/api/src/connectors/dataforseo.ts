import type { ConnectorDefinition } from './types.js'

const read = (description: string) => ({ description, write: false })
const write = (description: string) => ({ description, write: true })

/**
 * DataForSEO's own MCP server: its docs, and one tool that calls any route of its API (SERP,
 * keywords, Labs, backlinks, on-page, AI optimization, business data, domain analytics).
 * DataForSEO registers Brigade as a client itself (dynamic client registration), for the
 * authorization code alone: it grants no refresh token, so once a token expires the account
 * asks to reconnect. Its API bills each request to the account's balance, so the request tool
 * counts as a write, as the server marks it.
 */
export const dataforseo: ConnectorDefinition = {
  kind: 'dataforseo',
  label: 'DataForSEO',
  auth: 'mcp',
  operations: {},
  mcp: {
    url: 'https://mcp.dataforseo.com/v3/mcp',
    // No tool says whose the token is; its API takes the same token, and its free user_data
    // route names the account's login.
    account: {
      url: 'https://api.dataforseo.com/v3/appendix/user_data',
      name: dataforseoAccountName,
    },
    target: dataforseoTarget,
    tools: {
      docs_index: read('The index of DataForSEO’s API docs, or one section of it.'),
      docs_list_sections: read('List the sections of DataForSEO’s API docs.'),
      docs_search: read('Read a page of DataForSEO’s API docs.'),
      api_request: write('Call a DataForSEO API route, billed to the account’s balance.'),
    },
  },
}

/** An API call as approvals and the log show it: its method and route, then its tasks. */
export function dataforseoTarget(tool: string, input: Record<string, unknown>) {
  if (tool !== 'api_request') return null
  const route = typeof input.path === 'string' ? input.path : input.url
  if (typeof input.method !== 'string' || typeof route !== 'string') return null
  const data = input.data === undefined ? '' : ` ${JSON.stringify(input.data)}`
  const text = `${input.method} ${route}${data}`
  return text.length > 280 ? `${text.slice(0, 280)}…` : text
}

/**
 * The DataForSEO account as a row shows it: its login. GET /v3/appendix/user_data answers
 * { status_code, tasks: [{ status_code, result: [{ login, timezone, rates, money, price }] }] },
 * with status_code 20000 when it went through.
 */
export function dataforseoAccountName(output: unknown): string | null {
  const task = (output as { tasks?: { result?: { login?: unknown }[] | null }[] } | null)
    ?.tasks?.[0]
  const login = task?.result?.[0]?.login
  return typeof login === 'string' && login.length > 0 ? login : null
}
