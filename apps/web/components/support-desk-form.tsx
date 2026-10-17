'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

export type SupportDesk = 'intercom' | 'zendesk'
export const isSupportDesk = (kind: string): kind is SupportDesk =>
  kind === 'intercom' || kind === 'zendesk'

const link = 'underline underline-offset-2 hover:text-foreground'

/**
 * Connect Intercom or Zendesk with a token pasted once: on the App's sheet, or right in a
 * teammate's ticket. The API checks it with the vendor before keeping it in the vault.
 */
export function SupportDeskForm({
  kind,
  action = 'Connect',
  compact,
  onConnected,
}: {
  kind: SupportDesk
  action?: string
  /** In a ticket: tighter, on the card's background. */
  compact?: boolean
  onConnected: (connectionId: string) => void
}) {
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  // The subdomain, for the link to the account's API token page.
  const [subdomain, setSubdomain] = useState('')
  const host = subdomain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split(/[/.]/)[0]

  async function submit(form: FormData) {
    setError(undefined)
    setBusy(true)
    try {
      const field = (name: string) => String(form.get(name) ?? '')
      const { id } = await api<{ id: string }>('/connections/support-desk', {
        body:
          kind === 'intercom'
            ? { kind, apiKey: field('apiKey') }
            : {
                kind,
                subdomain: field('subdomain'),
                email: field('email'),
                apiKey: field('apiKey'),
              },
      })
      onConnected(id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const input = cn('bg-card', compact && 'h-8')
  return (
    <form action={submit} className={cn('flex flex-col', compact ? 'gap-3' : 'gap-4 px-4 py-4')}>
      {kind === 'intercom' ? (
        <p className="text-sm text-muted-foreground">
          In Intercom&apos;s{' '}
          <a
            href="https://app.intercom.com/a/apps/_/developer-hub"
            target="_blank"
            rel="noreferrer"
            className={link}
          >
            Developer Hub
          </a>
          , create an app (any name, e.g. Brigade), open its Authentication page and copy the access
          token. Replies go out in the name of the admin who created it. The token is encrypted in
          Brigade at once and never shown again.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          In Zendesk&apos;s Admin Center, under{' '}
          {host ? (
            <a
              href={`https://${host}.zendesk.com/admin/apps-integrations/apis/api-tokens`}
              target="_blank"
              rel="noreferrer"
              className={link}
            >
              Apps and integrations › API tokens
            </a>
          ) : (
            'Apps and integrations › API tokens'
          )}
          , add a token and copy it. Replies go out in the name of the agent whose email you give.
          The token is encrypted in Brigade at once and never shown again.
        </p>
      )}
      {kind === 'zendesk' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="zendesk-subdomain">Subdomain</Label>
            <Input
              id="zendesk-subdomain"
              name="subdomain"
              placeholder="acme.zendesk.com"
              autoComplete="off"
              value={subdomain}
              onChange={(e) => setSubdomain(e.target.value)}
              className={input}
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="zendesk-email">Agent email</Label>
            <Input
              id="zendesk-email"
              name="email"
              type="email"
              placeholder="you@acme.com"
              autoComplete="email"
              className={input}
              required
            />
          </div>
        </div>
      )}
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${kind}-token`}>
          {kind === 'intercom' ? 'Access token' : 'API token'}
        </Label>
        <Input
          id={`${kind}-token`}
          name="apiKey"
          type="password"
          autoComplete="off"
          className={cn(input, 'font-mono')}
          required
        />
      </div>
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      <div className={cn('flex', !compact && 'justify-end')}>
        <Button size={compact ? 'sm' : 'default'} disabled={busy}>
          {action}
        </Button>
      </div>
    </form>
  )
}
