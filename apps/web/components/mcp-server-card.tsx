'use client'
import { useEffect, useRef, useState } from 'react'
import { ProviderTile } from '@/components/provider-logo'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api, type App, type Connection, type McpInspection } from '@/lib/api'
import { openSignIn } from '@/lib/sign-in-window'

type Connected = { appId: string; connectionId: string }

/** What a server asks for, in a few words under its name. */
const SIGN_IN: Record<McpInspection['signIn'], string> = {
  oauth: 'signs in with its provider',
  oauth_client: 'signs in with an OAuth client you register',
  api_key: 'asks for an API key',
  none: 'no sign-in needed',
}

/**
 * An MCP server by its URL, as one card wherever it is added (the Apps page, a
 * teammate's ticket): paste the URL, Brigade says what the server is, and the card
 * asks only for what its sign-in needs. Given an App, it adds another account to it.
 */
export function McpServerCard({
  url: givenUrl,
  app,
  connections,
  reload,
  onInspected,
  onConnected,
  action,
}: {
  /** The server a teammate named: shown, not typed. */
  url?: string
  /** An App already added: another account of it, the way it signs in. */
  app?: App
  connections: Connection[]
  reload: () => Promise<unknown>
  onInspected?: (inspection: McpInspection) => void
  onConnected: (connected: Connected) => void
  /** The button's words, e.g. "Connect and give Riley access". */
  action?: string
}) {
  const [url, setUrl] = useState(givenUrl ?? '')
  const [inspection, setInspection] = useState<McpInspection>()
  const [inspecting, setInspecting] = useState(false)
  const [error, setError] = useState<string>()
  const [name, setName] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [header, setHeader] = useState<string>()
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [busy, setBusy] = useState(false)
  // A server that registers no OAuth client, signed in to with a token instead (GitHub's).
  const [byToken, setByToken] = useState(false)
  // Signing in in a window of its own: the App and how many accounts it had before.
  const [waiting, setWaiting] = useState<{ appId: string; before: string[]; since: number }>()

  // Look the server up a moment after its URL is typed or pasted.
  const asked = useRef('')
  useEffect(() => {
    if (app) return
    // Another server: a sign-in still open for the last one no longer counts.
    setWaiting(undefined)
    const typed = url.trim()
    if (!/^https?:\/\/[^/\s]+\.?[^/\s]*/.test(typed)) {
      setInspection(undefined)
      setError(undefined)
      return
    }
    const timer = setTimeout(async () => {
      asked.current = typed
      setInspecting(true)
      setError(undefined)
      try {
        const found = await api<McpInspection>('/connections/mcp/inspect', { body: { url: typed } })
        if (asked.current !== typed) return
        setInspection(found)
        setName(found.app?.name ?? found.name)
        onInspected?.(found)
      } catch (e) {
        if (asked.current !== typed) return
        setInspection(undefined)
        setError((e as Error).message)
      } finally {
        if (asked.current === typed) setInspecting(false)
      }
    }, 400)
    return () => clearTimeout(timer)
  }, [url, app])

  // Once the new account shows up, it is connected.
  useEffect(() => {
    if (!waiting) return
    const added = connections.find(
      (c) => c.appId === waiting.appId && c.status !== 'removed' && !waiting.before.includes(c.id),
    )
    if (added) {
      setWaiting(undefined)
      onConnected({ appId: waiting.appId, connectionId: added.id })
      return
    }
    const timer = setInterval(() => {
      if (Date.now() - waiting.since > 10 * 60_000) setWaiting(undefined)
      else void reload()
    }, 2000)
    return () => clearInterval(timer)
  }, [waiting, connections])

  const existing = app ?? (inspection?.app ? { id: inspection.app.id } : undefined)
  // An App already added keeps the OAuth client it was given: its next accounts just sign in.
  const found: McpInspection['signIn'] | undefined =
    app?.mcp?.auth ??
    (existing && inspection?.signIn === 'oauth_client' ? 'oauth' : inspection?.signIn)
  const signIn = found === 'oauth_client' && byToken ? 'api_key' : found
  const shownName = app?.name ?? (name.trim() || inspection?.name || 'MCP server')
  const host = (() => {
    try {
      return new URL(app?.mcp?.url ?? inspection?.url ?? url).host
    } catch {
      return ''
    }
  })()
  const tools = app?.mcp?.tools ?? inspection?.tools ?? null
  const icons = app?.mcp?.icons ?? inspection?.icons ?? []

  async function connect() {
    if (!signIn) return
    setError(undefined)
    setBusy(true)
    const body = {
      ...(existing ? { appId: existing.id } : { url: inspection!.url, name: name.trim() }),
      ...(signIn === 'api_key' ? { apiKey, ...(header ? { header } : {}) } : {}),
      ...(signIn === 'oauth_client' ? { clientId, ...(clientSecret ? { clientSecret } : {}) } : {}),
    }
    try {
      if (signIn === 'oauth' || signIn === 'oauth_client') {
        let appId = ''
        const inWindow = await openSignIn(async (returnTo) => {
          const started = await api<{ url: string; appId: string }>('/connections/mcp/server', {
            body: { ...body, ...(returnTo ? { returnTo } : {}) },
          })
          appId = started.appId
          return started.url
        })
        if (inWindow)
          setWaiting({
            appId,
            before: connections.filter((c) => c.appId === appId).map((c) => c.id),
            since: Date.now(),
          })
      } else {
        const done = await api<{ id: string; appId: string }>('/connections/mcp/server', { body })
        await reload()
        onConnected({ appId: done.appId, connectionId: done.id })
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const ready =
    !!signIn &&
    // Still enabled while a sign-in tab is open: closed by mistake, it opens again.
    !busy &&
    (signIn !== 'api_key' || apiKey.trim().length > 0) &&
    (signIn !== 'oauth_client' || clientId.trim().length > 0)
  const button =
    action ??
    (signIn === 'oauth' || signIn === 'oauth_client' ? `Sign in to ${shownName}` : 'Connect')

  return (
    <div className="flex flex-col gap-3">
      {!app &&
        (givenUrl ? (
          <p className="truncate font-mono text-xs text-muted-foreground">{givenUrl}</p>
        ) : (
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://mcp.example.com/mcp"
            aria-label="MCP server URL"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            className="bg-card font-mono text-sm"
          />
        ))}
      {inspecting && !inspection && (
        <p className="text-sm text-muted-foreground">Looking at {host || 'the server'}…</p>
      )}

      {(app || inspection) && signIn && (
        <div className="flex flex-col gap-3 rounded-lg border bg-card p-3">
          <div className="flex items-center gap-3">
            <ProviderTile kind="mcp" icons={icons} small />
            <div className="flex min-w-0 flex-1 flex-col">
              {existing ? (
                <span className="truncate font-semibold">{shownName}</span>
              ) : (
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  aria-label="Name"
                  maxLength={80}
                  className="-mx-1 rounded px-1 font-semibold outline-none hover:bg-muted focus-visible:bg-muted"
                />
              )}
              <span className="truncate text-xs text-muted-foreground">
                {[
                  host,
                  tools ? `${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}` : null,
                  tools && tools.length > 0 && tools.every((t) => !t.write) ? 'read only' : null,
                  existing && !app ? 'already added' : SIGN_IN[found ?? signIn],
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </div>
          </div>

          {signIn === 'api_key' && (
            <div className="flex flex-col gap-1.5">
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={byToken ? 'Paste a token' : 'Paste your API key'}
                aria-label={`${shownName} API key`}
                autoComplete="off"
                className="font-mono text-sm"
              />
              {!existing &&
                (header === undefined ? (
                  <button
                    type="button"
                    onClick={() => setHeader('')}
                    className="self-start text-xs text-muted-foreground hover:text-foreground"
                  >
                    Sent as a Bearer token · Use another header
                  </button>
                ) : (
                  <Input
                    value={header}
                    onChange={(e) => setHeader(e.target.value)}
                    placeholder="Header, e.g. X-API-Key"
                    aria-label="Header the key is sent in"
                    autoComplete="off"
                    className="font-mono text-sm"
                  />
                ))}
            </div>
          )}

          {found === 'oauth_client' && (
            <button
              type="button"
              onClick={() => setByToken(!byToken)}
              className="self-start text-xs text-muted-foreground hover:text-foreground"
            >
              {byToken ? 'Use an OAuth client instead' : 'Use a token instead'}
            </button>
          )}

          {signIn === 'oauth_client' && (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs text-muted-foreground">
                {shownName} doesn&apos;t let apps register by themselves. Register one with its
                provider, with this redirect URL:
              </p>
              <code className="select-all break-all rounded bg-muted px-2 py-1 font-mono text-xs">
                {inspection?.redirectUri}
              </code>
              <Input
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="Client ID"
                aria-label="Client ID"
                autoComplete="off"
                className="font-mono text-sm"
              />
              <Input
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder="Client secret, if it has one"
                aria-label="Client secret"
                autoComplete="off"
                className="font-mono text-sm"
              />
            </div>
          )}

          <Button disabled={!ready} onClick={() => void connect()}>
            {busy ? 'Connecting…' : button}
          </Button>
          {waiting && (
            <p className="text-sm text-muted-foreground">
              Finish signing in in the tab that opened. The account shows here once it is connected.
            </p>
          )}
        </div>
      )}
      {error && <p className="text-sm text-destructive-text">{error}</p>}
    </div>
  )
}
