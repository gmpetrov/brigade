// Remote MCP servers (Streamable HTTP) as connectors. The API signs in with the
// server's own OAuth (MCP authorization: protected resource metadata, dynamic
// client registration, PKCE), keeps the tokens in the vault, and calls the
// server's tools for teammates. Tokens never leave the API.
import { createHash, randomBytes } from 'node:crypto'
import { env } from '../config.js'
import { prisma } from '../db.js'
import { redact, type McpServer } from './types.js'

/** An MCP account's tokens and the client they were issued to. Kept in the vault. */
export type McpCredential = {
  accessToken: string
  refreshToken: string | null
  expiresAt: number
  clientId: string
  clientSecret?: string
  tokenEndpoint: string
  revocationEndpoint?: string
  /** The protected resource the tokens are for (RFC 8707). */
  resource: string
}

/** One tool as the server describes it. */
export type McpTool = {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean }
}

export const mcpRedirectUri = () => `${env.API_URL}/api/connections/oauth/mcp/callback`

const PROTOCOL = '2025-06-18'

type AuthServer = {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  revocation_endpoint?: string
  scopes_supported?: string[]
}

async function getJson<T>(url: string): Promise<T | null> {
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  return response.ok ? ((await response.json()) as T) : null
}

/**
 * Where the server signs people in: its protected resource metadata (named by its
 * 401's WWW-Authenticate, else at the well-known path), then that authorization
 * server's metadata.
 */
async function discover(server: McpServer) {
  const url = new URL(server.url)
  const probe = await fetch(server.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
  }).catch(() => null)
  const challenge = probe?.headers.get('www-authenticate') ?? ''
  const named = challenge.match(/resource_metadata="([^"]+)"/)?.[1]
  const resourceMetadata =
    (named
      ? await getJson<{
          resource?: string
          authorization_servers?: string[]
          scopes_supported?: string[]
        }>(named)
      : null) ??
    (await getJson(`${url.origin}/.well-known/oauth-protected-resource${url.pathname}`)) ??
    (await getJson(`${url.origin}/.well-known/oauth-protected-resource`))
  const issuer = resourceMetadata?.authorization_servers?.[0] ?? url.origin
  const base = issuer.replace(/\/$/, '')
  const authServer =
    (await getJson<AuthServer>(`${base}/.well-known/oauth-authorization-server`)) ??
    (await getJson<AuthServer>(`${base}/.well-known/openid-configuration`))
  if (!authServer) throw new Error(`${url.host} does not say how to sign in`)
  // The scopes the server asks for in its challenge, else those its resource lists.
  const scopes =
    challenge.match(/scope="([^"]+)"/)?.[1]?.split(' ') ?? resourceMetadata?.scopes_supported ?? []
  return { authServer, resource: resourceMetadata?.resource ?? server.url, scopes }
}

/** Brigade as a client of this authorization server: registered once, then reused. */
async function client(authServer: AuthServer) {
  const redirectUri = mcpRedirectUri()
  const known = await prisma.mcpClient.findUnique({
    where: { issuer_redirectUri: { issuer: authServer.issuer, redirectUri } },
  })
  if (known) return known
  if (!authServer.registration_endpoint)
    throw new Error(`${authServer.issuer} does not let Brigade register as a client`)
  const response = await fetch(authServer.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Brigade',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // A public client: PKCE protects the code, and there is no secret to keep.
      token_endpoint_auth_method: 'none',
    }),
  })
  const data = (await response.json().catch(() => ({}))) as {
    client_id?: string
    client_secret?: string
    error_description?: string
  }
  if (!response.ok || !data.client_id)
    throw new Error(
      `Registering with ${authServer.issuer} failed: ${data.error_description ?? response.status}`,
    )
  return prisma.mcpClient.upsert({
    where: { issuer_redirectUri: { issuer: authServer.issuer, redirectUri } },
    create: {
      issuer: authServer.issuer,
      redirectUri,
      clientId: data.client_id,
      clientSecret: data.client_secret ?? null,
    },
    update: {},
  })
}

/** A PKCE verifier, kept with the sign-in's state until the callback. */
export const pkceVerifier = () => randomBytes(32).toString('base64url')
const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url')

/** The page where the person signs in to the server's provider and picks what Brigade may do. */
export async function mcpAuthUrl(server: McpServer, state: string, verifier: string) {
  const { authServer, resource, scopes } = await discover(server)
  const { clientId } = await client(authServer)
  // A refresh token too, where the server needs asking for one.
  const scope = [
    ...scopes,
    ...(authServer.scopes_supported?.includes('offline_access') ? ['offline_access'] : []),
  ].join(' ')
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: mcpRedirectUri(),
    state,
    code_challenge: s256(verifier),
    code_challenge_method: 'S256',
    resource,
    ...(scope ? { scope } : {}),
  })
  return `${authServer.authorization_endpoint}?${params}`
}

async function tokenRequest(
  endpoint: string,
  auth: { clientId: string; clientSecret?: string | null },
  body: Record<string, string>,
) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      client_id: auth.clientId,
      ...(auth.clientSecret ? { client_secret: auth.clientSecret } : {}),
      ...body,
    }),
  })
  const data = (await response.json().catch(() => ({}))) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  }
  if (!response.ok || !data.access_token)
    throw new Error(`Sign-in failed: ${data.error_description ?? data.error ?? response.status}`)
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  }
}

/** The code the provider sent back, for tokens. */
export async function exchangeMcpCode(
  server: McpServer,
  code: string,
  verifier: string,
): Promise<McpCredential> {
  const { authServer, resource } = await discover(server)
  const registered = await client(authServer)
  const tokens = await tokenRequest(authServer.token_endpoint, registered, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: mcpRedirectUri(),
    resource,
  })
  return {
    ...tokens,
    clientId: registered.clientId,
    ...(registered.clientSecret ? { clientSecret: registered.clientSecret } : {}),
    tokenEndpoint: authServer.token_endpoint,
    ...(authServer.revocation_endpoint
      ? { revocationEndpoint: authServer.revocation_endpoint }
      : {}),
    resource,
  }
}

export async function refreshMcp(credential: McpCredential): Promise<McpCredential> {
  if (!credential.refreshToken) throw new Error('The sign-in expired; reconnect the account')
  const tokens = await tokenRequest(credential.tokenEndpoint, credential, {
    grant_type: 'refresh_token',
    refresh_token: credential.refreshToken,
    resource: credential.resource,
  })
  return { ...credential, ...tokens, refreshToken: tokens.refreshToken ?? credential.refreshToken }
}

export async function revokeMcp(credential: McpCredential) {
  if (!credential.revocationEndpoint) return
  await fetch(credential.revocationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: credential.clientId,
      token: credential.refreshToken ?? credential.accessToken,
    }),
  }).catch(() => undefined)
}

// ---------------------------------------------------------------------------
// JSON-RPC over Streamable HTTP
// ---------------------------------------------------------------------------

type Fetch = (url: string, init?: RequestInit) => Promise<Response>
type RpcResponse = { id?: number; result?: unknown; error?: { message?: string } }

/** A server's answer: a JSON body, or the matching message of an event stream. */
async function readRpc(response: Response, id: number): Promise<RpcResponse> {
  const text = await response.text()
  if (!response.ok) throw new Error(redact(`${response.status}: ${text.slice(0, 300)}`))
  if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (!data) continue
      const message = JSON.parse(data) as RpcResponse
      if (message.id === id) return message
    }
    throw new Error('The server closed the stream without an answer')
  }
  return JSON.parse(text) as RpcResponse
}

/** A session with the server: initialize, then requests in it. */
async function session(fetch: Fetch, url: string) {
  let next = 1
  let sessionId: string | undefined
  const headers = () => ({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': PROTOCOL,
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
  })
  const request = async (method: string, params: unknown) => {
    const id = next++
    const response = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    })
    sessionId ??= response.headers.get('mcp-session-id') ?? undefined
    const message = await readRpc(response, id)
    if (message.error) throw new Error(redact(message.error.message ?? 'The server refused'))
    return message.result
  }
  await request('initialize', {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: { name: 'Brigade', version: '1' },
  })
  await fetch(url, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  }).then((r) => r.body?.cancel())
  return request
}

/** Every tool the server offers this account, page by page. */
export async function listMcpTools(fetch: Fetch, url: string): Promise<McpTool[]> {
  const request = await session(fetch, url)
  const tools: McpTool[] = []
  let cursor: string | undefined
  do {
    const page = (await request('tools/list', cursor ? { cursor } : {})) as {
      tools?: McpTool[]
      nextCursor?: string
    }
    tools.push(...(page.tools ?? []))
    cursor = page.nextCursor
  } while (cursor && tools.length < 500)
  return tools
}

/** Call one tool. Its text comes back as the output; an error result throws. */
export async function callMcpTool(fetch: Fetch, url: string, name: string, args: unknown) {
  const request = await session(fetch, url)
  const result = (await request('tools/call', { name, arguments: args ?? {} })) as {
    content?: { type: string; text?: string }[]
    structuredContent?: unknown
    isError?: boolean
  }
  const text = (result.content ?? [])
    .map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type}]`))
    .join('\n')
  if (result.isError) throw new Error(redact(text || 'The tool failed'))
  return result.structuredContent ?? text
}

/** Whether a tool changes something: Brigade's list first, then the server's hint. */
export const mcpWrites = (server: McpServer, tool: McpTool) =>
  server.tools[tool.name]?.write ?? tool.annotations?.readOnlyHint !== true
