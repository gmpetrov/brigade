'use client'
import { useState } from 'react'
import { useDashboard } from '@/components/dashboard'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api, type Connection, type Trigger, type TriggerCatalog } from '@/lib/api'

/** How each vendor's events reach Brigade, as the panel says it. */
function deliveryNote(kind: Connection['kind'], mode: 'push' | 'poll') {
  if (kind === 'stripe') return 'Stripe sends these events to Brigade as they happen.'
  if (kind === 'github') return "GitHub sends these events through Brigade's GitHub App."
  if (kind === 'google_calendar')
    return 'Google Calendar tells Brigade about changes as they happen.'
  if (kind === 'gmail')
    return mode === 'push'
      ? 'Gmail tells Brigade about new mail as it arrives.'
      : 'Brigade checks the inbox every minute: Gmail push (Pub/Sub) is not configured on this server.'
  return null
}

/** "repository acme/web · branch main", from a trigger's options and the catalog's labels. */
function optionsSummary(trigger: Trigger, kinds: TriggerCatalog['catalog'][Connection['kind']]) {
  const options = kinds.find((k) => k.event === trigger.event)?.options ?? []
  return options
    .filter((o) => trigger.options[o.name])
    .map((o) => `${o.label.toLowerCase()} ${trigger.options[o.name]}`)
    .join(' · ')
}

/** A connection's triggers: events from its catalog that start threads for a teammate. */
export function ConnectionTriggers({
  connection,
  triggers,
  catalog,
  reload,
  editable,
}: {
  connection: Connection
  triggers: Trigger[]
  catalog: TriggerCatalog | undefined
  reload: () => Promise<unknown>
  editable: boolean
}) {
  const { teammates } = useDashboard()
  const kinds = catalog?.catalog[connection.kind] ?? []
  const info = catalog?.kinds[connection.kind]
  const custom = connection.kind === 'webhook'
  const [adding, setAdding] = useState(false)
  const [event, setEvent] = useState<string>()
  const [label, setLabel] = useState('')
  const [created, setCreated] = useState<{ url: string; signingSecret?: string }>()
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const chosen = kinds.find((k) => k.event === (event ?? kinds[0]?.event))
  const idFor = (field: string) => `trigger-${connection.id}-${field}`
  const failure = connection.subscriptions.find((s) => s.error)

  function start() {
    setAdding(true)
    setEvent(kinds[0]?.event)
    setLabel(custom ? '' : (kinds[0]?.label ?? ''))
  }

  async function create(form: FormData) {
    if (!chosen) return
    setError(undefined)
    setSaving(true)
    try {
      const options = Object.fromEntries(
        chosen.options.map((o) => [o.name, String(form.get(`option-${o.name}`) ?? '')]),
      )
      const result = await api<{ url: string | null; signingSecret?: string }>('/triggers', {
        body: {
          connectionId: connection.id,
          teammateId: String(form.get('teammateId')),
          label,
          event: chosen.event,
          options,
          ...(custom ? { verification: String(form.get('verification')) } : {}),
        },
      })
      setCreated(result.url ? { url: result.url, signingSecret: result.signingSecret } : undefined)
      setAdding(false)
      await reload()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function remove(trigger: Trigger) {
    if (
      !confirm(
        custom
          ? `Delete "${trigger.label}"? Its URL stops working.`
          : `Delete "${trigger.label}"? It stops starting threads.`,
      )
    )
      return
    await api(`/triggers/${trigger.id}`, { method: 'DELETE' }).catch((e) =>
      setError((e as Error).message),
    )
    await reload()
  }

  const note = info && triggers.length > 0 ? deliveryNote(connection.kind, info.delivery) : null

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {custom
          ? 'Each event the app posts to a URL below starts a thread for its teammate, with the payload as the first message.'
          : `Pick what should start a thread. Each time it happens, a new thread starts for the teammate, with the event as the first message.`}{' '}
        It runs on the accounts of the admin who set it up. An event can ask for anything, so grant
        the teammate only what it needs, or set it to ask a person before changes.
      </p>
      {failure ? (
        <p className="text-sm text-destructive-text">Events may not be arriving: {failure.error}</p>
      ) : (
        note && <p className="text-sm text-muted-foreground">{note}</p>
      )}
      {created && (
        <div className="flex flex-col gap-2 rounded-lg bg-muted p-4 text-sm">
          <div>
            URL: <code className="font-mono text-xs break-all">{created.url}</code>
          </div>
          {created.signingSecret && (
            <div className="flex flex-col gap-1">
              <div>
                Signing secret (shown once):{' '}
                <code className="font-mono text-xs break-all">{created.signingSecret}</code>
              </div>
              <div className="text-muted-foreground">
                The app signs each body with HMAC-SHA256 and sends{' '}
                <code className="font-mono text-xs">X-Brigade-Signature: sha256=&lt;hex&gt;</code>.
                An <code className="font-mono text-xs">id</code> field in the JSON body keeps a
                retried event from starting a second thread.
              </div>
            </div>
          )}
        </div>
      )}
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      {triggers.length > 0 && (
        <div className="flex flex-col divide-y rounded-lg border">
          {triggers.map((t) => {
            const kind = kinds.find((k) => k.event === t.event)
            const summary = optionsSummary(t, kinds)
            return (
              <div key={t.id} className="flex flex-wrap items-center gap-3 p-3">
                <div className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">
                  <div className="text-sm">
                    <span className="font-semibold">{t.label}</span>{' '}
                    <span className="text-muted-foreground">→ {t.teammate.name}</span>
                  </div>
                  {custom ? (
                    <code className="font-mono text-xs break-all text-muted-foreground">
                      {t.url}
                    </code>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {kind?.label ?? t.event}
                      {summary && ` · ${summary}`}
                    </span>
                  )}
                </div>
                {custom && (
                  <StatusBadge
                    status={t.verification ?? 'none'}
                    tone={t.verification === 'hmac' ? 'success' : 'warning'}
                    label={t.verification === 'hmac' ? 'signed' : 'unsigned'}
                  />
                )}
                {editable && (
                  <Button variant="danger" size="sm" onClick={() => void remove(t)}>
                    Delete
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      )}
      {info?.unavailable && <p className="text-sm text-muted-foreground">{info.unavailable}</p>}
      {editable &&
        !info?.unavailable &&
        kinds.length > 0 &&
        (adding && chosen ? (
          <form action={create} className="flex flex-col gap-4 rounded-lg border bg-muted/50 p-4">
            {!custom && (
              <div className="flex flex-col gap-2">
                <Label htmlFor={idFor('event')}>When</Label>
                <Select
                  value={chosen.event}
                  onValueChange={(value) => {
                    const next = kinds.find((k) => k.event === value)
                    // Keep a name the admin typed; follow the event otherwise.
                    if (!label || label === chosen.label) setLabel(next?.label ?? '')
                    setEvent(value)
                  }}
                >
                  <SelectTrigger id={idFor('event')} className="w-full bg-card">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {kinds.map((k) => (
                      <SelectItem key={k.event} value={k.event}>
                        {k.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-sm text-muted-foreground">{chosen.description}</p>
              </div>
            )}
            {chosen.options.map((o) => (
              <div key={`${chosen.event}-${o.name}`} className="flex flex-col gap-2">
                <Label htmlFor={idFor(o.name)}>
                  {o.label}
                  {!o.required && ' (optional)'}
                </Label>
                <Input
                  id={idFor(o.name)}
                  name={`option-${o.name}`}
                  placeholder={o.placeholder}
                  required={o.required}
                  className="bg-card font-mono"
                />
                {o.help && <p className="text-sm text-muted-foreground">{o.help}</p>}
              </div>
            ))}
            <div className="flex flex-col gap-2">
              <Label htmlFor={idFor('teammate')}>Starts a thread for</Label>
              <Select name="teammateId" required defaultValue={teammates[0]?.id}>
                <SelectTrigger id={idFor('teammate')} className="w-full bg-card">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {teammates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={idFor('label')}>Name</Label>
              <Input
                id={idFor('label')}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                required
                maxLength={80}
                className="bg-card"
                placeholder={custom ? 'New support request' : chosen.label}
              />
            </div>
            {custom && (
              <div className="flex flex-col gap-2">
                <Label htmlFor={idFor('verification')}>Verify the sender with</Label>
                <Select name="verification" defaultValue="hmac">
                  <SelectTrigger id={idFor('verification')} className="w-full bg-card">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="hmac">A signing secret Brigade generates</SelectItem>
                    <SelectItem value="none">Nothing (the URL alone)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button disabled={saving}>
                {saving ? 'Subscribing…' : custom ? 'Create webhook' : 'Create trigger'}
              </Button>
            </div>
          </form>
        ) : (
          <div>
            <Button variant="outline" size="sm" onClick={start}>
              {custom ? 'Add a webhook' : 'Add a trigger'}
            </Button>
          </div>
        ))}
    </div>
  )
}
