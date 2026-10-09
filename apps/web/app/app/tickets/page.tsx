'use client'
import { Inbox } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { useDashboard } from '@/components/dashboard'
import { TicketRow } from '@/components/ticket-row'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { api, useApi, type Ticket } from '@/lib/api'
import { cn } from '@/lib/utils'

const TYPES: { value: Ticket['type'] | ''; label: string }[] = [
  { value: '', label: 'All kinds' },
  { value: 'approval', label: 'Approvals' },
  { value: 'cap', label: 'Reached caps' },
  { value: 'sign_in', label: 'Expired logins' },
  { value: 'usage_limit', label: 'Out of usage' },
  { value: 'question', label: 'Questions' },
]

/** One inbox per workspace of everything waiting on a person. */
export default function Tickets() {
  const { me } = useDashboard()
  const [all, setAll] = useState(false)
  const [type, setType] = useState<Ticket['type'] | ''>('')
  const tickets = useApi<Ticket[]>(`/tickets${all ? '?status=all' : ''}`)
  const [error, setError] = useState<string>()

  async function resolve(id: string, approved: boolean) {
    setError(undefined)
    try {
      await api(`/tickets/${id}/resolve`, { body: { approved } })
    } catch (e) {
      setError((e as Error).message)
    }
    await tickets.reload()
  }

  const shown = (tickets.data ?? []).filter((t) => !type || t.type === type)

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-extrabold tracking-tight">Tickets</h1>
        <p className="text-muted-foreground">
          Approvals, questions and limits your teammates need a person for.
        </p>
      </header>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div role="group" aria-label="Kind" className="flex flex-1 flex-wrap gap-2">
          {TYPES.map((t) => {
            const on = type === t.value
            return (
              <button
                key={t.value}
                type="button"
                aria-pressed={on}
                onClick={() => setType(t.value)}
                className={cn(
                  'inline-flex h-8 items-center rounded-full border px-3.5 text-sm font-semibold transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  on
                    ? 'border-transparent bg-foreground text-background'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                )}
              >
                {t.label}
              </button>
            )
          })}
        </div>
        <div className="flex items-center gap-2">
          <Switch id="show-resolved" checked={all} onCheckedChange={setAll} />
          <Label htmlFor="show-resolved" className="font-normal text-muted-foreground">
            Show resolved
          </Label>
        </div>
      </div>
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      {tickets.data && shown.length === 0 && (
        <section className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-card px-6 py-16 text-center">
          <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/15 text-primary">
            <Inbox className="size-6" aria-hidden />
          </span>
          <h2 className="text-lg font-bold">Nothing is waiting on you.</h2>
          <p className="max-w-md text-sm text-muted-foreground">
            When a teammate needs an approval, asks a question or hits a cap, it lands here.
          </p>
          <Button asChild variant="outline" className="mt-1">
            <Link href="/app">Back to threads</Link>
          </Button>
        </section>
      )}
      {shown.length > 0 && (
        <Card className="gap-0 overflow-hidden py-0">
          <ul className="divide-y">
            {shown.map((t) => (
              <TicketRow key={t.id} ticket={t} me={me} onResolve={resolve} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}
