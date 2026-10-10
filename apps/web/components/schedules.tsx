'use client'
import { cronProblem, nextRuns } from '@brigade/contracts'
import cronstrue from 'cronstrue'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { TeammateAvatar, useDashboard } from '@/components/dashboard'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { api, harnessLabel, type Schedule } from '@/lib/api'

/** The browser's timezone: a new schedule's default. */
export const localTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

/** The cron expression in words, e.g. "At 07:00, only on Monday". */
export function describeCron(cron: string) {
  try {
    return cronstrue.toString(cron, { use24HourTimeFormat: true })
  } catch {
    return cron
  }
}

/** A time in the schedule's own timezone, e.g. "Mon 12 Oct, 07:00". */
export function scheduleTime(iso: string | Date, timezone: string) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))
}

/** The short name of a timezone, e.g. "Paris" for Europe/Paris. */
export const zoneName = (timezone: string) =>
  (timezone.split('/').pop() ?? timezone).replace(/_/g, ' ')

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

type Preset = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom'
type When = { preset: Preset; time: string; minute: string; day: string; cron: string }

const PRESETS: { id: Preset; label: string }[] = [
  { id: 'hourly', label: 'Every hour' },
  { id: 'daily', label: 'Every day' },
  { id: 'weekdays', label: 'Weekdays' },
  { id: 'weekly', label: 'Every week' },
  { id: 'custom', label: 'Custom (cron)' },
]

const pad = (n: string) => n.padStart(2, '0')

/** The cron expression a preset writes. */
function toCron(when: When) {
  const [h = '9', m = '0'] = when.time.split(':').map((part) => String(Number(part)))
  switch (when.preset) {
    case 'hourly':
      return `${Number(when.minute) || 0} * * * *`
    case 'daily':
      return `${m} ${h} * * *`
    case 'weekdays':
      return `${m} ${h} * * 1-5`
    case 'weekly':
      return `${m} ${h} * * ${when.day}`
    case 'custom':
      return when.cron.trim()
  }
}

/** The preset a cron expression came from, or custom. */
function fromCron(cron: string): When {
  const base: When = { preset: 'custom', time: '09:00', minute: '0', day: '1', cron }
  const hourly = cron.match(/^(\d{1,2}) \* \* \* \*$/)
  if (hourly) return { ...base, preset: 'hourly', minute: hourly[1]! }
  const timed = cron.match(/^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6])$/)
  if (!timed) return base
  const time = `${pad(timed[2]!)}:${pad(timed[1]!)}`
  if (timed[3] === '*') return { ...base, preset: 'daily', time }
  if (timed[3] === '1-5') return { ...base, preset: 'weekdays', time }
  return { ...base, preset: 'weekly', time, day: timed[3]! }
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string
  htmlFor: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** A new schedule, or changes to one the member owns. */
export function ScheduleDialog({
  open,
  onOpenChange,
  schedule,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Unset: a new schedule. */
  schedule?: Schedule
  onSaved: (schedule: Schedule) => void
}) {
  const { teammates } = useDashboard()
  const [teammateId, setTeammateId] = useState<string>()
  const [title, setTitle] = useState('')
  const [instructions, setInstructions] = useState('')
  const [when, setWhen] = useState<When>(fromCron('0 9 * * 1-5'))
  const [timezone, setTimezone] = useState('UTC')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const zones = useMemo(() => Intl.supportedValuesOf('timeZone'), [])

  useEffect(() => {
    if (!open) return
    setTeammateId(schedule?.teammateId)
    setTitle(schedule?.title ?? '')
    setInstructions(schedule?.instructions ?? '')
    setWhen(fromCron(schedule?.cron ?? '0 9 * * 1-5'))
    setTimezone(schedule?.timezone ?? localTimezone())
    setError(undefined)
  }, [open, schedule])

  const teammate = teammateId ?? teammates[0]?.id
  const cron = toCron(when)
  const problem = cron ? cronProblem(cron, timezone) : 'Enter a cron expression'
  const upcoming = problem ? [] : nextRuns(cron, timezone, 3)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy || problem) return
    setBusy(true)
    setError(undefined)
    try {
      const body = { teammateId: teammate, title, instructions, cron, timezone }
      const saved = schedule
        ? await api<Schedule>(`/schedules/${schedule.id}`, { method: 'PATCH', body })
        : await api<Schedule>('/schedules', { body })
      onOpenChange(false)
      onSaved(saved)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const set = (patch: Partial<When>) => setWhen((w) => ({ ...w, ...patch }))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{schedule ? 'Edit schedule' : 'New schedule'}</DialogTitle>
            <DialogDescription>
              Each run starts a fresh thread with these instructions, on your AI accounts.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Title" htmlFor="schedule-title">
              <Input
                id="schedule-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Weekly PR digest"
                required
                maxLength={200}
                autoFocus
              />
            </Field>
            <Field label="Teammate" htmlFor="schedule-teammate">
              <Select value={teammate} onValueChange={setTeammateId}>
                <SelectTrigger id="schedule-teammate" className="w-full">
                  <SelectValue placeholder="Choose a teammate" />
                </SelectTrigger>
                <SelectContent>
                  {teammates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      <TeammateAvatar teammate={t} className="size-5" />
                      {t.name}
                      <span className="text-xs text-muted-foreground">
                        {harnessLabel(t.harness)}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field
            label="Instructions"
            htmlFor="schedule-instructions"
            hint="Each run starts with no memory of earlier ones: name the inputs, the steps, and where the result goes."
          >
            <Textarea
              id="schedule-instructions"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="List the pull requests merged in acme/web last week and email a short digest to the team."
              rows={5}
              required
              className="max-h-72"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="When" htmlFor="schedule-preset">
              <Select value={when.preset} onValueChange={(v) => set({ preset: v as Preset })}>
                <SelectTrigger id="schedule-preset" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRESETS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {when.preset === 'hourly' && (
              <Field label="Minute past the hour" htmlFor="schedule-minute">
                <Input
                  id="schedule-minute"
                  type="number"
                  min={0}
                  max={59}
                  value={when.minute}
                  onChange={(e) => set({ minute: e.target.value })}
                />
              </Field>
            )}
            {(when.preset === 'daily' || when.preset === 'weekdays') && (
              <Field label="At" htmlFor="schedule-time">
                <Input
                  id="schedule-time"
                  type="time"
                  value={when.time}
                  onChange={(e) => set({ time: e.target.value })}
                  required
                />
              </Field>
            )}
            {when.preset === 'custom' && (
              <Field label="Cron expression" htmlFor="schedule-cron">
                <Input
                  id="schedule-cron"
                  value={when.cron}
                  onChange={(e) => set({ cron: e.target.value })}
                  placeholder="0 7 * * 1"
                  className="font-mono"
                  required
                />
              </Field>
            )}
          </div>
          {when.preset === 'weekly' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="On" htmlFor="schedule-day">
                <Select value={when.day} onValueChange={(day) => set({ day })}>
                  <SelectTrigger id="schedule-day" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DAYS.map((d, i) => (
                      <SelectItem key={d} value={String(i)}>
                        {d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="At" htmlFor="schedule-time">
                <Input
                  id="schedule-time"
                  type="time"
                  value={when.time}
                  onChange={(e) => set({ time: e.target.value })}
                  required
                />
              </Field>
            </div>
          )}
          <Field label="Timezone" htmlFor="schedule-timezone">
            <Input
              id="schedule-timezone"
              list="schedule-timezones"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              required
            />
            <datalist id="schedule-timezones">
              {zones.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
          </Field>

          <div className="rounded-lg bg-secondary/60 px-3 py-2.5 text-sm" aria-live="polite">
            {problem ? (
              <p className="text-destructive-text">{problem}</p>
            ) : (
              <>
                <p className="font-medium">
                  {describeCron(cron)} ({zoneName(timezone)})
                </p>
                <p className="text-muted-foreground">
                  Next: {upcoming.map((d) => scheduleTime(d, timezone)).join(' · ')}
                </p>
              </>
            )}
          </div>

          {error && <p className="text-sm text-destructive-text">{error}</p>}
          <DialogFooter>
            <Button
              type="submit"
              disabled={
                busy || Boolean(problem) || !title.trim() || !instructions.trim() || !teammate
              }
            >
              {busy ? 'Saving…' : schedule ? 'Save changes' : 'Create schedule'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
