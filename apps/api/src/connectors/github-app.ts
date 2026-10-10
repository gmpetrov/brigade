// GitHub App for connections. A customer installs the app on their account or
// organization and picks the repositories; the vault keeps only the
// installation's id. Each call mints a short-lived installation token here.
import { createSign } from 'node:crypto'
import { env } from '../config.js'

export const GITHUB_API = 'https://api.github.com'
export const githubHeaders = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'Brigade',
}

export type GitHubCredential = { installationId: number }

export class GitHubInstallationGone extends Error {}

export const githubConfigured = () =>
  Boolean(
    env.GITHUB_APP_ID &&
    env.GITHUB_APP_SLUG &&
    env.GITHUB_APP_CLIENT_ID &&
    env.GITHUB_APP_CLIENT_SECRET &&
    env.GITHUB_APP_PRIVATE_KEY,
  )

export const githubCallbackUri = () => `${env.API_URL}/api/connections/oauth/github/callback`

/** Where a person installs the app and picks repositories. GitHub then sends them to the setup URL. */
export const githubInstallUrl = () =>
  `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`

/** After the install: the person signs in to GitHub, so Brigade can check they reach the installation. */
export const githubAuthorizeUrl = (state: string) =>
  `https://github.com/login/oauth/authorize?${new URLSearchParams({
    client_id: env.GITHUB_APP_CLIENT_ID!,
    redirect_uri: githubCallbackUri(),
    state,
  })}`

/** The private key as PEM: pasted with \n escapes, or base64 of the .pem file. */
function privateKey() {
  const raw = env.GITHUB_APP_PRIVATE_KEY!.trim()
  return raw.includes('BEGIN') ? raw.replace(/\\n/g, '\n') : Buffer.from(raw, 'base64').toString()
}

const base64url = (data: string | Buffer) => Buffer.from(data).toString('base64url')

/** The app's own JWT (RS256, ten minutes at most), to act as the app rather than an installation. */
function appJwt() {
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID }),
  )}`
  const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey())
  return `${unsigned}.${base64url(signature)}`
}

async function asApp<T>(path: string, init: RequestInit = {}) {
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: { ...githubHeaders, authorization: `Bearer ${appJwt()}` },
  })
  if (response.status === 404 || response.status === 403) throw new GitHubInstallationGone()
  if (!response.ok) throw new Error(`GitHub refused the app (${response.status})`)
  return (await response.json()) as T
}

// Installation tokens last an hour. Kept in this process only, never in the vault or the database.
const tokens = new Map<number, { token: string; expiresAt: number }>()

export async function installationToken(installationId: number, fresh = false) {
  const cached = tokens.get(installationId)
  if (!fresh && cached && cached.expiresAt > Date.now() + 5 * 60_000) return cached.token
  const minted = await asApp<{ token: string; expires_at: string }>(
    `/app/installations/${installationId}/access_tokens`,
    { method: 'POST' },
  ).catch((error) => {
    tokens.delete(installationId)
    throw error
  })
  tokens.set(installationId, { token: minted.token, expiresAt: Date.parse(minted.expires_at) })
  return minted.token
}

type Installation = {
  id: number
  account: { login: string; type: string } | null
  repository_selection: 'all' | 'selected'
  html_url: string
}

/**
 * The installation, once GitHub confirms that the person who just installed it
 * can reach it: an installation id in a redirect URL proves nothing on its own.
 * The person's token is used for this one check and revoked.
 */
export async function verifiedInstallation(code: string, installationId: number) {
  const exchange = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_APP_CLIENT_ID,
      client_secret: env.GITHUB_APP_CLIENT_SECRET,
      code,
      redirect_uri: githubCallbackUri(),
    }),
  })
  const { access_token: userToken, error_description } = (await exchange.json()) as {
    access_token?: string
    error_description?: string
  }
  if (!userToken) throw new Error(`GitHub sign-in failed: ${error_description ?? exchange.status}`)
  try {
    for (let page = 1; page <= 10; page++) {
      const response = await fetch(`${GITHUB_API}/user/installations?per_page=100&page=${page}`, {
        headers: { ...githubHeaders, authorization: `Bearer ${userToken}` },
      })
      if (!response.ok) throw new Error(`GitHub refused the installation list (${response.status})`)
      const { installations } = (await response.json()) as { installations: Installation[] }
      const found = installations.find((i) => i.id === installationId)
      if (found) return found
      if (installations.length < 100) break
    }
    return null
  } finally {
    await fetch(`${GITHUB_API}/applications/${env.GITHUB_APP_CLIENT_ID}/token`, {
      method: 'DELETE',
      headers: {
        ...githubHeaders,
        authorization: `Basic ${Buffer.from(`${env.GITHUB_APP_CLIENT_ID}:${env.GITHUB_APP_CLIENT_SECRET}`).toString('base64')}`,
      },
      body: JSON.stringify({ access_token: userToken }),
    }).catch(() => undefined)
  }
}

/** Which account a connection is, and which repositories it reaches. Never a token. */
export const githubAccount = (installation: Installation) =>
  `${installation.account?.login ?? `installation ${installation.id}`} (${
    installation.repository_selection === 'all' ? 'all repositories' : 'selected repositories'
  })`
