// Remote MCP servers (Streamable HTTP, or the older HTTP+SSE) as connectors. The API
// signs in with the server's own OAuth (MCP authorization: protected resource metadata,
// then dynamic client registration, a client ID metadata document, Brigade's own client
// where the provider registers none (Google), or a client the member registered; PKCE),
// or sends the key a member pasted, keeps the tokens in the vault, and calls the server's
// tools for teammates. Tokens never leave the API.
import { createHash, randomBytes } from 'node:crypto'
import { env } from '../config.js'
import { prisma } from '../db.js'
import { mcpOutput } from './mcp-output.js'
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

/** A client Brigade signs in as: registered, a metadata document's URL, or the member's own. */
export type McpOAuthClient = { clientId: string; clientSecret?: string | null }

export const mcpRedirectUri = () => `${env.API_URL}/api/connections/oauth/mcp/callback`

/**
 * Brigade's client ID metadata document: its URL is the client ID, for authorization
 * servers that read one instead of registering clients. Only over HTTPS.
 */
export const mcpClientDocumentUrl = () => `${env.API_URL}/api/mcp/client.json`
export const mcpClientDocument = () => ({
  client_id: mcpClientDocumentUrl(),
  client_name: 'Brigade',
  client_uri: env.WEB_URL[0],
  redirect_uris: [mcpRedirectUri()],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
})

const PROTOCOL = '2025-06-18'
/** Metadata, sign-in and first requests: a server that takes longer is not answering. */
const TIMEOUT_MS = 30_000
/** A tool call may run a while (Cloudflare's execute); one past this is given up. */
const CALL_MS = 5 * 60_000

type AuthServer = {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  revocation_endpoint?: string
  scopes_supported?: string[]
  client_id_metadata_document_supported?: boolean
}

// ---------------------------------------------------------------------------
// Where a member's URL may lead
// ---------------------------------------------------------------------------

/** A private, loopback or link-local address: the API's own network, never a member's server. */
export function privateAddress(host: string) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal')) return true
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    )
  }
  if (h.includes(':'))
    return (
      h === '::' || h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || /^::ffff:/.test(h)
    )
  return false
}

/** On a local Brigade, servers on this machine may be added too. */
const localBrigade = () => /^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(env.API_URL)

/**
 * A URL a member gave, or one a server's metadata names: HTTPS on a public host (plain
 * HTTP and local hosts only on a local Brigade). Its name must not resolve to a private
 * address either, where the platform can tell.
 */
export async function publicUrl(raw: string) {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Not a URL')
  }
  if (localBrigade() && (url.protocol === 'http:' || url.protocol === 'https:')) return url
  if (url.protocol !== 'https:') throw new Error('The address must start with https://')
  if (url.username || url.password) throw new Error('Put the key in its own field, not in the URL')
  if (privateAddress(url.hostname)) throw new Error(`${url.hostname} is not a public address`)
  // Where the platform resolves names (Node); a name it cannot find fails at the fetch.
  const dns = await import('node:dns/promises').catch(() => null)
  const found = await dns?.lookup(url.hostname, { all: true }).catch(() => null)
  if (found?.some((a) => privateAddress(a.address)))
    throw new Error(`${url.hostname} is not a public address`)
  return url
}

const timed = (init: RequestInit = {}): RequestInit => ({
  ...init,
  signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS),
})

async function getJson<T>(url: string): Promise<T | null> {
  if (!(await publicUrl(url).catch(() => null))) return null
  const response = await fetch(url, timed({ headers: { accept: 'application/json' } })).catch(
    () => null,
  )
  return response?.ok ? ((await response.json().catch(() => null)) as T | null) : null
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

type ResourceMetadata = {
  resource?: string
  resource_name?: string
  authorization_servers?: string[]
  scopes_supported?: string[]
}

/** The 401 an unauthorised request gets, for the challenge naming the server's metadata. */
async function challengeOf(server: Pick<McpServer, 'url' | 'transport'>) {
  const probe = await fetch(
    server.url,
    timed(
      server.transport === 'sse'
        ? { headers: { accept: 'text/event-stream' } }
        : {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
          },
    ),
  ).catch(() => null)
  await probe?.body?.cancel().catch(() => undefined)
  return probe?.headers.get('www-authenticate') ?? ''
}

/**
 * Where the server signs people in: its protected resource metadata (named by its
 * 401's WWW-Authenticate, else at the well-known path), then that authorization
 * server's metadata. Null when the server has no OAuth.
 */
async function findAuthServer(server: Pick<McpServer, 'url' | 'transport'>, challenge?: string) {
  const url = new URL(server.url)
  challenge ??= await challengeOf(server)
  const named = challenge.match(/resource_metadata="([^"]+)"/)?.[1]
  const resourceMetadata =
    (named ? await getJson<ResourceMetadata>(new URL(named, url).href) : null) ??
    (await getJson<ResourceMetadata>(
      `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`,
    )) ??
    (await getJson<ResourceMetadata>(`${url.origin}/.well-known/oauth-protected-resource`))
  const issuer = resourceMetadata?.authorization_servers?.[0] ?? url.origin
  const issuerUrl = new URL(issuer)
  const path = issuerUrl.pathname.replace(/\/$/, '')
  // RFC 8414 puts the issuer's path after the well-known part; many servers serve it after.
  const authServer =
    (path
      ? await getJson<AuthServer>(
          `${issuerUrl.origin}/.well-known/oauth-authorization-server${path}`,
        )
      : null) ??
    (await getJson<AuthServer>(
      `${issuerUrl.origin}${path}/.well-known/oauth-authorization-server`,
    )) ??
    (path
      ? await getJson<AuthServer>(`${issuerUrl.origin}/.well-known/openid-configuration${path}`)
      : null) ??
    (await getJson<AuthServer>(`${issuerUrl.origin}${path}/.well-known/openid-configuration`))
  if (!authServer?.authorization_endpoint || !authServer.token_endpoint) return null
  // The scopes the server asks for in its challenge, else those its resource lists.
  const scopes =
    challenge.match(/scope="([^"]+)"/)?.[1]?.split(' ') ?? resourceMetadata?.scopes_supported ?? []
  return {
    authServer,
    resource: resourceMetadata?.resource ?? server.url,
    scopes,
    name: resourceMetadata?.resource_name,
  }
}

async function discover(server: McpServer) {
  const found = await findAuthServer(server)
  if (!found) throw new Error(`${new URL(server.url).host} does not say how to sign in`)
  return found
}

/** Google signs in to its MCP servers, but registers no clients: Brigade brings its own. */
const isGoogle = (authServer: AuthServer) =>
  authServer.issuer.replace(/\/$/, '') === 'https://accounts.google.com'
const googleClient = (): McpOAuthClient | null =>
  env.GOOGLE_MCP_CLIENT_ID && env.GOOGLE_MCP_CLIENT_SECRET
    ? { clientId: env.GOOGLE_MCP_CLIENT_ID, clientSecret: env.GOOGLE_MCP_CLIENT_SECRET }
    : null

/** Whether Brigade can be a client of this authorization server with nothing from the member. */
const registersItself = (authServer: AuthServer) =>
  Boolean(
    authServer.registration_endpoint ||
    (authServer.client_id_metadata_document_supported && env.API_URL.startsWith('https://')) ||
    (isGoogle(authServer) && googleClient()),
  )

/**
 * Brigade as a client of this authorization server: the member's own client when they
 * gave one; else Brigade's Google client for Google; else registered once (dynamic client
 * registration) and reused; else its client ID metadata document.
 */
async function client(authServer: AuthServer, own?: McpOAuthClient): Promise<McpOAuthClient> {
  if (own) return own
  const google = isGoogle(authServer) ? googleClient() : null
  if (google) return google
  const redirectUri = mcpRedirectUri()
  const known = await prisma.mcpClient.findUnique({
    where: { issuer_redirectUri: { issuer: authServer.issuer, redirectUri } },
  })
  if (known) return known
  if (!authServer.registration_endpoint) {
    if (registersItself(authServer)) return { clientId: mcpClientDocumentUrl() }
    throw new Error(`${authServer.issuer} does not let Brigade register as a client`)
  }
  const response = await fetch(
    authServer.registration_endpoint,
    timed({
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
    }),
  )
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
export async function mcpAuthUrl(
  server: McpServer,
  state: string,
  verifier: string,
  own?: McpOAuthClient,
) {
  const { authServer, resource, scopes } = await discover(server)
  const { clientId } = await client(authServer, own)
  const supported = authServer.scopes_supported ?? []
  // A refresh token too, where the server needs asking for one; and who signed in, to show
  // the account by its email, where the server offers it.
  const scope = [
    ...new Set([
      ...scopes,
      ...(supported.includes('offline_access') ? ['offline_access'] : []),
      // Google's OAuth metadata lists no scopes, but it gives the email too.
      ...((supported.includes('openid') && supported.includes('email')) || isGoogle(authServer)
        ? ['openid', 'email']
        : []),
    ]),
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
    // Google gives a refresh token only when asked this way, not for offline_access.
    ...(isGoogle(authServer) ? { access_type: 'offline', prompt: 'consent' } : {}),
  })
  return `${authServer.authorization_endpoint}?${params}`
}

async function tokenRequest(
  endpoint: string,
  auth: { clientId: string; clientSecret?: string | null },
  body: Record<string, string>,
) {
  const response = await fetch(
    endpoint,
    timed({
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        client_id: auth.clientId,
        ...(auth.clientSecret ? { client_secret: auth.clientSecret } : {}),
        ...body,
      }),
    }),
  )
  const data = (await response.json().catch(() => ({}))) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    id_token?: string
    error?: string
    error_description?: string
  }
  if (!response.ok || !data.access_token)
    throw new Error(`Sign-in failed: ${data.error_description ?? data.error ?? response.status}`)
  return {
    tokens: {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? null,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    },
    idToken: data.id_token,
  }
}

/**
 * The email in an ID token, to show which account signed in. Shown only, never trusted
 * for anything else, so its signature is not checked.
 */
export function idTokenEmail(idToken: string | undefined) {
  const payload = idToken?.split('.')[1]
  if (!payload) return null
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { email?: unknown }
    return typeof claims.email === 'string' ? claims.email : null
  } catch {
    return null
  }
}

/** The code the provider sent back, for tokens, and the email it signed in with, if it says. */
export async function exchangeMcpCode(
  server: McpServer,
  code: string,
  verifier: string,
  own?: McpOAuthClient,
): Promise<{ credential: McpCredential; email: string | null }> {
  const { authServer, resource } = await discover(server)
  const registered = await client(authServer, own)
  const { tokens, idToken } = await tokenRequest(authServer.token_endpoint, registered, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: mcpRedirectUri(),
    resource,
  })
  return {
    credential: {
      ...tokens,
      clientId: registered.clientId,
      ...(registered.clientSecret ? { clientSecret: registered.clientSecret } : {}),
      tokenEndpoint: authServer.token_endpoint,
      ...(authServer.revocation_endpoint
        ? { revocationEndpoint: authServer.revocation_endpoint }
        : {}),
      resource,
    },
    email: idTokenEmail(idToken),
  }
}

export async function refreshMcp(credential: McpCredential): Promise<McpCredential> {
  if (!credential.refreshToken) throw new Error('The sign-in expired; reconnect the account')
  const { tokens } = await tokenRequest(credential.tokenEndpoint, credential, {
    grant_type: 'refresh_token',
    refresh_token: credential.refreshToken,
    resource: credential.resource,
  })
  return { ...credential, ...tokens, refreshToken: tokens.refreshToken ?? credential.refreshToken }
}

export async function revokeMcp(credential: McpCredential) {
  if (!credential.revocationEndpoint) return
  await fetch(
    credential.revocationEndpoint,
    timed({
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: credential.clientId,
        ...(credential.clientSecret ? { client_secret: credential.clientSecret } : {}),
        token: credential.refreshToken ?? credential.accessToken,
      }),
    }),
  ).catch(() => undefined)
}

// ---------------------------------------------------------------------------
// JSON-RPC over Streamable HTTP, or over the older HTTP+SSE
// ---------------------------------------------------------------------------

type Fetch = (url: string, init?: RequestInit) => Promise<Response>
type RpcResponse = { id?: number; result?: unknown; error?: { message?: string } }
type Session = {
  request: (method: string, params: unknown) => Promise<unknown>
  close: () => void
}

/** The events of a text/event-stream body as they arrive. */
async function* events(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let end: RegExpExecArray | null
      while ((end = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, end.index)
        buffer = buffer.slice(end.index + end[0].length)
        const lines = block.split(/\r?\n/)
        yield {
          event:
            lines
              .find((l) => l.startsWith('event:'))
              ?.slice(6)
              .trim() ?? 'message',
          data: lines
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart())
            .join('\n'),
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/** The JSON-RPC answer to request `id` in a body, if that is what it holds. */
function rpcAnswer(text: string, id: number): RpcResponse | undefined {
  try {
    const message = JSON.parse(text) as RpcResponse | null
    return message?.id === id && ('result' in message || 'error' in message) ? message : undefined
  } catch {
    return undefined
  }
}

/** A server's answer: a JSON body, or the matching message of an event stream. */
async function readRpc(response: Response, id: number): Promise<RpcResponse> {
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    // Why it was refused, when the server says (Google: a scope missing, an API not enabled).
    // Without its scheme: redact() would take the word after "Bearer" for a token.
    const challenge = response.headers.get('www-authenticate')?.replace(/^Bearer\s+/i, '')
    const status = `${response.status}${challenge ? ` (${challenge})` : ''}`
    // Google's servers answer with an error status and the JSON-RPC answer anyway (tools/list
    // on a 401 or 403): the answer is what counts.
    const message = rpcAnswer(text, id)
    if (message) {
      console.warn(redact(`MCP server answered ${status}; using its answer`))
      return message
    }
    throw new Error(redact(`${status}: ${text.slice(0, 300)}`))
  }
  if ((response.headers.get('content-type') ?? '').includes('text/event-stream') && response.body) {
    for await (const { data } of events(response.body)) {
      if (!data) continue
      const message = JSON.parse(data) as RpcResponse
      if (message.id === id) {
        await response.body.cancel().catch(() => undefined)
        return message
      }
    }
    throw new Error('The server closed the stream without an answer')
  }
  return JSON.parse(await response.text()) as RpcResponse
}

const initialize = {
  protocolVersion: PROTOCOL,
  capabilities: {},
  clientInfo: { name: 'Brigade', version: '1' },
}

/** A Streamable HTTP session: each request is a POST, its answer in the response. */
async function streamableSession(fetch: Fetch, url: string): Promise<Session & { info: unknown }> {
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
      signal: AbortSignal.timeout(method === 'tools/call' ? CALL_MS : TIMEOUT_MS),
    })
    sessionId ??= response.headers.get('mcp-session-id') ?? undefined
    const message = await readRpc(response, id)
    if (message.error) throw new Error(redact(message.error.message ?? 'The server refused'))
    return message.result
  }
  const info = await request('initialize', initialize)
  await fetch(
    url,
    timed({
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    }),
  ).then((r) => r.body?.cancel())
  return { request, close: () => undefined, info }
}

/**
 * An HTTP+SSE session (the transport before Streamable HTTP): a GET opens an event
 * stream whose first event names where to POST; every answer comes back on the stream.
 */
async function sseSession(fetch: Fetch, url: string): Promise<Session & { info: unknown }> {
  const controller = new AbortController()
  const close = () => controller.abort()
  // A server that never names its endpoint is given up on.
  const giveUp = setTimeout(close, TIMEOUT_MS)
  const stream = await fetch(url, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  })
  if (!stream.ok || !stream.body) {
    close()
    throw new Error(redact(`${stream.status}: the server did not open its event stream`))
  }
  // Read by hand: leaving a for await would close the stream the answers come on.
  const incoming = events(stream.body)
  const waiting = new Map<number, (message: RpcResponse) => void>()
  let endpoint: string | undefined
  for (let next = await incoming.next(); !next.done; next = await incoming.next())
    if (next.value.event === 'endpoint') {
      endpoint = new URL(next.value.data, url).href
      break
    }
  clearTimeout(giveUp)
  if (!endpoint || new URL(endpoint).origin !== new URL(url).origin) {
    close()
    throw new Error('The server did not say where to send requests')
  }
  // Answers, as they arrive, to the request waiting for each.
  void (async () => {
    try {
      for (let next = await incoming.next(); !next.done; next = await incoming.next()) {
        if (!next.value.data) continue
        const message = JSON.parse(next.value.data) as RpcResponse
        if (typeof message.id === 'number') waiting.get(message.id)?.(message)
      }
    } catch {
      // closed
    }
  })()
  let next = 1
  const post = (body: object) =>
    fetch(
      endpoint!,
      timed({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', ...body }),
      }),
    )
  const request = async (method: string, params: unknown) => {
    const id = next++
    const answer = new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('The server did not answer in time')),
        method === 'tools/call' ? CALL_MS : TIMEOUT_MS,
      )
      waiting.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
    }).finally(() => waiting.delete(id))
    // Awaited below, after the POST; a timeout before then is not an unhandled rejection.
    answer.catch(() => undefined)
    const sent = await post({ id, method, params })
    await sent.body?.cancel().catch(() => undefined)
    if (!sent.ok) throw new Error(redact(`${sent.status}: the server refused the request`))
    const message = await answer
    if (message.error) throw new Error(redact(message.error.message ?? 'The server refused'))
    return message.result
  }
  try {
    const info = await request('initialize', initialize)
    await post({ method: 'notifications/initialized' }).then((r) => r.body?.cancel())
    return { request, close, info }
  } catch (error) {
    close()
    throw error
  }
}

const session = (fetch: Fetch, server: Pick<McpServer, 'url' | 'transport'>) =>
  server.transport === 'sse' ? sseSession(fetch, server.url) : streamableSession(fetch, server.url)

async function listed(request: Session['request']) {
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

/** Every tool the server offers this account, page by page. */
export async function listMcpTools(
  fetch: Fetch,
  server: Pick<McpServer, 'url' | 'transport'>,
): Promise<McpTool[]> {
  const { request, close } = await session(fetch, server)
  try {
    return await listed(request)
  } finally {
    close()
  }
}

/** Call one tool. Its text comes back as the output; an error result throws. */
export async function callMcpTool(
  fetch: Fetch,
  server: Pick<McpServer, 'url' | 'transport'>,
  name: string,
  args: unknown,
) {
  const { request, close } = await session(fetch, server)
  try {
    const result = (await request('tools/call', { name, arguments: args ?? {} })) as Parameters<
      typeof mcpOutput
    >[0]
    const { output, text } = mcpOutput(result)
    if (result.isError) throw new Error(redact(text || 'The tool failed'))
    return output
  } finally {
    close()
  }
}

/** Whether a tool changes something: Brigade's list first, then the server's hint. */
export const mcpWrites = (server: McpServer, tool: McpTool) =>
  server.tools[tool.name]?.write ?? tool.annotations?.readOnlyHint !== true

// ---------------------------------------------------------------------------
// What a URL is, before anyone signs in
// ---------------------------------------------------------------------------

/**
 * How an account signs in to a server, as the member sees it. oauth: Brigade opens the
 * provider's sign-in. oauth_client: the same, once the member gives a client they
 * registered there (the server registers none). api_key: a key the member pastes.
 * none: nothing to sign in to.
 */
export type McpSignIn = 'oauth' | 'oauth_client' | 'api_key' | 'none'

export type McpInspection = {
  url: string
  transport: 'streamable' | 'sse'
  signIn: McpSignIn
  /** The server's own name when it gives one, else one made from its host. */
  name: string
  description: string | null
  /** Images to show for it, best first: the server's own icon, then its site's. */
  icons: string[]
  /** The tools, when the server lists them before anyone signs in. */
  tools: { name: string; description: string; write: boolean }[] | null
}

type ServerInfo = {
  serverInfo?: {
    name?: string
    title?: string
    icons?: { src?: string }[]
    websiteUrl?: string
  }
  instructions?: string
}

/** A readable name from a host: mcp.nevo.md → Nevo, api.acme-tools.com → Acme Tools. */
export function nameFromHost(host: string) {
  // An address is its own name.
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host
  // Google's servers are each a service of googleapis.com: bigquery.googleapis.com → Google Bigquery.
  const google = host.match(/^([^.]+)\.googleapis\.com$/)?.[1]
  if (google) return `Google ${google[0]!.toUpperCase()}${google.slice(1)}`
  const parts = host
    .split('.')
    .filter((p) => !['mcp', 'api', 'www', 'server', 'remote'].includes(p))
  const main = (parts.length > 1 ? parts.at(-2) : parts[0]) ?? host
  return main
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ')
}

/** The site's icons: on the server's host, then on the domain above it. */
function siteIcons(url: URL) {
  const hosts = [url.host]
  const parts = url.hostname.split('.')
  if (parts.length > 2 && !/^[\d.]+$/.test(url.hostname)) hosts.push(parts.slice(-2).join('.'))
  return hosts.map((h) => `${url.protocol}//${h}/favicon.ico`)
}

/** What a server is and how its accounts sign in, from requests that need no account. */
export async function inspectMcp(raw: string): Promise<McpInspection> {
  const url = await publicUrl(raw.trim())
  const href = url.href
  const plain: Fetch = (u, init) => fetch(u, init)
  const fallback = {
    url: href,
    name: nameFromHost(url.hostname),
    description: null,
    icons: siteIcons(url),
    tools: null,
  }

  // Streamable HTTP first: an initialize either works (nothing to sign in to) or is refused.
  const probe = await fetch(
    href,
    timed({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: initialize }),
    }),
  ).catch(() => {
    throw new Error(`${url.host} did not answer`)
  })
  const refused = probe.status === 401 || probe.status === 403
  let transport: McpInspection['transport'] = 'streamable'
  let challenge = probe.headers.get('www-authenticate') ?? ''
  await probe.body?.cancel().catch(() => undefined)

  if (!probe.ok && !refused) {
    // Not Streamable HTTP: the older transport answers a GET with an event stream.
    const stream = await fetch(href, timed({ headers: { accept: 'text/event-stream' } })).catch(
      () => null,
    )
    const sse =
      stream &&
      (stream.status === 401 ||
        stream.status === 403 ||
        (stream.ok && (stream.headers.get('content-type') ?? '').includes('text/event-stream')))
    challenge = stream?.headers.get('www-authenticate') ?? challenge
    // What the server says instead, when it says it in JSON (a moved endpoint, say).
    const said = sse
      ? undefined
      : await stream
          ?.json()
          .then((b) => {
            const message = (b as { message?: unknown } | null)?.message
            return typeof message === 'string' ? message.slice(0, 200) : undefined
          })
          .catch(() => undefined)
    await stream?.body?.cancel().catch(() => undefined)
    if (!sse)
      throw new Error(
        `${url.host} does not answer as an MCP server at this address${said ? `: ${said}` : ''}`,
      )
    transport = 'sse'
    if (stream.ok) return open({ ...fallback, transport }, plain)
  } else if (probe.ok) {
    return open({ ...fallback, transport }, plain)
  }

  // Refused: the server's OAuth, if it has one, else a key.
  const oauth = await findAuthServer({ url: href, transport }, challenge)
  if (!oauth) return { ...fallback, transport, signIn: 'api_key' }
  return {
    ...fallback,
    transport,
    name: oauth.name || fallback.name,
    signIn: registersItself(oauth.authServer) ? 'oauth' : 'oauth_client',
  }
}

/**
 * A server that answers without an account. Google's list their tools to anyone but
 * want a sign-in to call one: their OAuth metadata says so, and they sign in like any other.
 */
async function open(base: Omit<McpInspection, 'signIn'>, fetch: Fetch): Promise<McpInspection> {
  const [found, oauth] = await Promise.all([described(base, fetch), findAuthServer(base, '')])
  if (!oauth) return found
  return {
    ...found,
    name: oauth.name || base.name,
    signIn: registersItself(oauth.authServer) ? 'oauth' : 'oauth_client',
  }
}

/** A server that needs no sign-in: its own name, description, icon and tools. */
async function described(
  base: Omit<McpInspection, 'signIn'>,
  fetch: Fetch,
): Promise<McpInspection> {
  const { request, close, info } = await session(fetch, base)
  try {
    const { serverInfo, instructions } = (info ?? {}) as ServerInfo
    const icon = serverInfo?.icons?.find((i) => i.src?.startsWith('https://'))?.src
    const tools = await listed(request).catch(() => null)
    return {
      ...base,
      signIn: 'none',
      name: serverInfo?.title || serverInfo?.name || base.name,
      description: instructions?.split('\n')[0]?.slice(0, 200) || null,
      icons: [...(icon ? [icon] : []), ...base.icons],
      tools:
        tools?.map((t) => ({
          name: t.name,
          description: t.description ?? t.name,
          write: t.annotations?.readOnlyHint !== true,
        })) ?? null,
    }
  } finally {
    close()
  }
}

/** The server's name and icon once an account has signed in, for servers that hide them before. */
export async function mcpServerInfo(fetch: Fetch, server: Pick<McpServer, 'url' | 'transport'>) {
  const { close, info } = await session(fetch, server)
  close()
  const { serverInfo } = (info ?? {}) as ServerInfo
  return {
    name: serverInfo?.title || serverInfo?.name || null,
    icon: serverInfo?.icons?.find((i) => i.src?.startsWith('https://'))?.src ?? null,
  }
}
