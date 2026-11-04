'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api, type Connection } from '@/lib/api'

/**
 * Apps whose accounts may also sign in with a key the member pastes, beside the provider's
 * OAuth: what the key is and where to make one.
 */
export const KEY_SIGN_IN: Partial<
  Record<Connection['kind'], { key: string; article: string; help: string }>
> = {
  revenuecat: {
    key: 'secret API v2 key',
    article: 'a',
    help: 'Make one in RevenueCat under Project settings → API keys → New secret API key, with API version V2. Give it read access only, or read and write for the areas teammates may change.',
  },
}

/** Paste an App's key: checked by the API against its server, then the account shows. */
export function AppKeyForm({
  kind,
  name,
  reconnect,
  action,
  onConnected,
  onCancel,
}: {
  kind: Connection['kind']
  name: string
  /** The account getting the new key. */
  reconnect?: string
  action?: string
  onConnected: (connectionId: string) => void
  onCancel?: () => void
}) {
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const sign = KEY_SIGN_IN[kind]

  async function submit() {
    setBusy(true)
    setError(undefined)
    try {
      const { id } = await api<{ id: string }>('/connections/mcp/key', {
        body: { kind, apiKey: apiKey.trim(), ...(reconnect ? { reconnect } : {}) },
      })
      setApiKey('')
      onConnected(id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      className="flex flex-col gap-2"
    >
      {sign && <p className="text-sm text-muted-foreground">{sign.help}</p>}
      <Input
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder={`Paste your ${sign?.key ?? 'API key'}`}
        aria-label={`${name} ${sign?.key ?? 'API key'}`}
        autoComplete="off"
        className="bg-card font-mono text-sm"
      />
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button size="sm" disabled={busy || apiKey.trim().length === 0}>
          {busy ? 'Checking…' : (action ?? (reconnect ? 'Reconnect' : 'Connect'))}
        </Button>
      </div>
    </form>
  )
}
