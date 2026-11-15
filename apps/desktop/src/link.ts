// What a brigade:// link asks. brigade://link?code=…&api=…[&dashboard=…][&workspace=…], from
// "Open in Brigade" in the dashboard; brigade://sign-in?code=…, from the dashboard's page that
// signs the app's windows in; brigade://signed-in?nonce=…[&connected=…][&error=…], from the
// return page of a provider's sign-in the app sent to the browser.
import { allowedDashboard } from './settings.js'

export type Link =
  | { kind: 'signIn'; code: string }
  | { kind: 'providerSignedIn'; nonce: string; connected?: string; error?: string }
  | { kind: 'connect'; code: string; api: string; dashboard?: string; workspace?: string }

/** What a brigade:// link asks, or nothing when it isn't one this app takes. */
export function parseLink(raw: string): Link | undefined {
  let link: URL
  try {
    link = new URL(raw)
  } catch {
    return undefined
  }
  if (link.protocol !== 'brigade:') return undefined
  const query = (key: string) => link.searchParams.get(key) ?? undefined
  if (link.hostname === 'signed-in') {
    const nonce = query('nonce')
    // An account's id and an error's short name, nothing longer.
    const short = (value: string | undefined) =>
      value && /^[\w.:-]{1,200}$/.test(value) ? value : undefined
    const connected = short(query('connected'))
    const error = short(query('error'))
    return nonce
      ? {
          kind: 'providerSignedIn',
          nonce,
          ...(connected && { connected }),
          ...(error && { error }),
        }
      : undefined
  }
  if (link.hostname === 'sign-in') {
    const code = query('code')
    return code ? { kind: 'signIn', code } : undefined
  }
  if (link.hostname !== 'link') return undefined
  const code = query('code')
  const api = query('api')
  if (!code || !api) return undefined
  let apiUrl: URL
  try {
    apiUrl = new URL(api)
  } catch {
    return undefined
  }
  const local = ['localhost', '127.0.0.1'].includes(apiUrl.hostname)
  if (apiUrl.protocol !== 'https:' && !(local && apiUrl.protocol === 'http:')) return undefined
  const dashboard = query('dashboard')
  const workspace = query('workspace')
  return {
    kind: 'connect',
    code,
    api: api.replace(/\/+$/, ''),
    ...(dashboard && allowedDashboard(dashboard) && { dashboard }),
    ...(workspace && { workspace }),
  }
}
