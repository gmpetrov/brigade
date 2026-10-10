'use client'
import { CalendarClock, MoreHorizontal, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { isAdmin, StatusBadge, TeammateAvatar, timeAgo, useDashboard } from '@/components/dashboard'
import { describeCron, ScheduleDialog, scheduleTime, zoneName } from '@/components/schedules'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api, useApi, type Schedule } from '@/lib/api'
import { useLive } from '@/lib/use-live'

function ScheduleRow({
  schedule,
  onEdit,
  onChanged,
}: {
  schedule: Schedule
  onEdit: () => void
  onChanged: () => void
}) {
  const { me } = useDashboard()
  const [error, setError] = useState<string>()
  const [note, setNote] = useState<string>()
  const [confirm, setConfirm] = useState(false)
  const owner = schedule.ownerMemberId === me.memberId
  const manager = owner || isAdmin(me)
  const active = !schedule.pausedAt

  async function act(path: string, init: { method?: string; body?: unknown } = {}) {
    setError(undefined)
    setNote(undefined)
    try {
      const result = await api<{ threadId?: string }>(`/schedules/${schedule.id}${path}`, {
        method: 'POST',
        body: {},
        ...init,
      })
      if (path === '/run') setNote('Started')
      onChanged()
      return result
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <li className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-semibold">{schedule.title}</span>
          {!active && <StatusBadge status="paused" />}
          {schedule.lastError && <StatusBadge status="failed" label="couldn't start" />}
        </div>
        <p className="text-sm">
          {describeCron(schedule.cron)}{' '}
          <span className="text-muted-foreground">({zoneName(schedule.timezone)})</span>
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <TeammateAvatar teammate={schedule.teammate} className="size-4" />
            <span className="font-medium text-foreground">{schedule.teammate.name}</span>
          </span>
          <span>
            on {owner ? 'your' : `${schedule.owner.user.name}'s`} accounts
            {schedule.createdByTeammate && `, set up by ${schedule.createdByTeammate.name}`}
          </span>
          {active && schedule.nextRunAt && (
            <span>Next {scheduleTime(schedule.nextRunAt, schedule.timezone)}</span>
          )}
          {schedule.lastRun && (
            <Link href={`/app/threads/${schedule.lastRun.id}`} className="hover:underline">
              Last run {timeAgo(schedule.lastRun.createdAt)} · {schedule.lastRun.status}
            </Link>
          )}
        </div>
        {schedule.lastError && (
          <p className="text-xs text-destructive-text">{schedule.lastError}</p>
        )}
        {error && <p className="text-xs text-destructive-text">{error}</p>}
        {note && <p className="text-xs text-success">{note}</p>}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {confirm ? (
          <>
            <span className="text-sm text-muted-foreground">Delete? Its threads stay.</span>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => void act('', { method: 'DELETE', body: undefined })}
            >
              Delete
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
              Keep it
            </Button>
          </>
        ) : (
          <>
            <Switch
              checked={active}
              disabled={!manager}
              onCheckedChange={(on) => void act(on ? '/resume' : '/pause')}
              aria-label={active ? 'Pause schedule' : 'Resume schedule'}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!manager}
              onClick={() => void act('/run')}
            >
              <Play aria-hidden />
              Run now
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label="More" disabled={!manager}>
                  <MoreHorizontal aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={!owner} onSelect={onEdit}>
                  <Pencil aria-hidden />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setConfirm(true)}>
                  <Trash2 aria-hidden />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>
    </li>
  )
}

/** Automations: schedules that prompt a teammate at set times. */
export default function Automations() {
  const schedules = useApi<Schedule[]>('/schedules')
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null)
  const reload = schedules.reload
  // A run's thread changing status changes the row's last run.
  useLive((message) => {
    if (message.type === 'schedule.updated' || message.type === 'thread.updated') void reload()
  })

  const list = schedules.data ?? []
  const active = list.filter((s) => !s.pausedAt).length

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-extrabold tracking-tight">Automations</h1>
          <p className="max-w-prose text-muted-foreground">
            Work your teammates do on a schedule, each run in a fresh thread. Ask a teammate in a
            thread, or add one yourself.
          </p>
        </div>
        <Button onClick={() => setEditing('new')}>
          <Plus aria-hidden />
          New schedule
        </Button>
      </header>

      <section aria-labelledby="schedules" className="flex flex-col gap-3">
        <h2 id="schedules" className="flex items-center gap-2 text-sm font-bold">
          <CalendarClock className="size-4 text-muted-foreground" aria-hidden />
          Schedules
          {schedules.data && (
            <span className="font-mono text-xs font-normal text-muted-foreground">
              {active} active{list.length > active && ` · ${list.length - active} paused`}
            </span>
          )}
        </h2>
        {!schedules.data ? (
          <Skeleton className="h-24 w-full" />
        ) : list.length === 0 ? (
          <p className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
            No schedules yet. Try &ldquo;Every weekday at 9:00, summarize yesterday&rsquo;s new
            issues&rdquo;.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {list.map((s) => (
              <ScheduleRow
                key={s.id}
                schedule={s}
                onEdit={() => setEditing(s)}
                onChanged={() => void reload()}
              />
            ))}
          </ul>
        )}
        {schedules.error && (
          <p className="text-sm text-destructive-text">{schedules.error.message}</p>
        )}
      </section>

      <ScheduleDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        schedule={editing && editing !== 'new' ? editing : undefined}
        onSaved={() => void reload()}
      />
    </div>
  )
}
