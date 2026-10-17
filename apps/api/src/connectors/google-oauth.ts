// Google OAuth for connections. Tokens go straight into the vault.
import { env } from '../config.js'

/** The Apps that sign in with Brigade's Google client. */
export type GoogleKind =
  'gmail' | 'google_calendar' | 'google_drive' | 'google_docs' | 'google_sheets'

export const GOOGLE_SCOPES: Record<GoogleKind, string[]> = {
  gmail: [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.send',
  ],
  google_calendar: [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    'https://www.googleapis.com/auth/calendar.freebusy',
  ],
  // Every file the account can open, to search, read and edit them.
  google_drive: ['https://www.googleapis.com/auth/drive'],
  // Documents and spreadsheets by id, and drive.file to create them in My Drive.
  google_docs: [
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/drive.file',
  ],
  google_sheets: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.file',
  ],
}

export const isGoogleKind = (kind: string): kind is GoogleKind => kind in GOOGLE_SCOPES

export type GoogleCredential = {
  accessToken: string
  refreshToken: string | null
  expiresAt: number
}

export const googleConfigured = () => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
/** The second Google client, for Google's MCP servers (the Google Cloud App). */
export const googleMcpConfigured = () =>
  Boolean(env.GOOGLE_MCP_CLIENT_ID && env.GOOGLE_MCP_CLIENT_SECRET)
export const googleRedirectUri = () => `${env.API_URL}/api/connections/oauth/google/callback`

export function googleAuthUrl(kind: GoogleKind, state: string) {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: googleRedirectUri(),
    response_type: 'code',
    scope: GOOGLE_SCOPES[kind].join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`
}

async function tokenRequest(
  body: Record<string, string>,
): Promise<GoogleCredential & { scope?: string }> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      ...body,
    }),
  })
  const data = (await response.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    error_description?: string
    error?: string
  }
  if (!response.ok || !data.access_token)
    throw new Error(
      `Google sign-in failed: ${data.error_description ?? data.error ?? response.status}`,
    )
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  }
}

export const exchangeGoogleCode = (code: string) =>
  tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: googleRedirectUri() })

export async function refreshGoogle(credential: GoogleCredential): Promise<GoogleCredential> {
  if (!credential.refreshToken)
    throw new Error('The Google connection has no refresh token; reconnect it')
  const next = await tokenRequest({
    refresh_token: credential.refreshToken,
    grant_type: 'refresh_token',
  })
  return { ...next, refreshToken: next.refreshToken ?? credential.refreshToken }
}

export async function revokeGoogle(credential: GoogleCredential) {
  await fetch(
    `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(credential.refreshToken ?? credential.accessToken)}`,
    { method: 'POST' },
  ).catch(() => undefined)
}

/** The account a credential belongs to, to show which one a connection is. Never the credential. */
export async function googleAccount(kind: GoogleKind, accessToken: string) {
  const headers = { authorization: `Bearer ${accessToken}` }
  if (kind === 'gmail') {
    const profile = (await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers,
    }).then((r) => r.json())) as { emailAddress?: string }
    return profile.emailAddress ?? null
  }
  // Drive's account holder, which every Drive scope reads, drive.file included.
  if (kind === 'google_drive' || kind === 'google_docs' || kind === 'google_sheets') {
    const about = (await fetch(
      'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)',
      {
        headers,
      },
    ).then((r) => r.json())) as { user?: { emailAddress?: string } }
    return about.user?.emailAddress ?? null
  }
  // The primary calendar's id is the account's address.
  const primary = (await fetch(
    'https://www.googleapis.com/calendar/v3/users/me/calendarList/primary',
    { headers },
  ).then((r) => r.json())) as { id?: string }
  return primary.id ?? null
}
