'use client'
// Send an approved email later: tomorrow or Monday morning, or a day and time picked, up to
// SEND_LATER_MAX_DAYS ahead (Resend holds it until then; it can be cancelled until it leaves).
import { SEND_LATER_MAX_DAYS } from '@brigade/contracts'
import { ChevronDown, Clock } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/** A time of day in the member's own time, `days` from today. */
function at(days: number, hour: number) {
  const date = new Date()
  date.setDate(date.getDate() + days)
  date.setHours(hour, 0, 0, 0)
  return date
}

/** Tomorrow morning and afternoon, and Monday morning unless tomorrow is Monday. */
function quickTimes() {
  const toMonday = (8 - new Date().getDay()) % 7 || 7
  return [
    { label: 'Tomorrow morning', at: at(1, 9) },
    { label: 'Tomorrow afternoon', at: at(1, 14) },
    ...(toMonday > 1 ? [{ label: 'Monday morning', at: at(toMonday, 9) }] : []),
  ]
}

/** A day and time as people read it: "Mon, Nov 2, 9:00 AM". */
export const leavingLabel = (at: Date | string) =>
  new Date(at).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })

/** A Date as datetime-local wants it, in local time. */
const local = (at: Date) => {
  const shifted = new Date(at.getTime() - at.getTimezoneOffset() * 60_000)
  return shifted.toISOString().slice(0, 16)
}

export function SendLaterMenu({
  onPick,
  disabled,
}: {
  /** The time it leaves, as ISO 8601 with its offset. */
  onPick: (sendAt: string) => void
  disabled?: boolean
}) {
  const [picking, setPicking] = useState(false)
  const [value, setValue] = useState(() => local(at(1, 9)))
  const choices = quickTimes()
  const picked = value ? new Date(value) : null
  const max = Date.now() + SEND_LATER_MAX_DAYS * 86_400_000
  const problem = !picked
    ? 'Pick a day and time'
    : picked.getTime() <= Date.now() + 60_000
      ? 'Pick a time in the future'
      : picked.getTime() > max
        ? `Up to ${SEND_LATER_MAX_DAYS} days ahead`
        : null
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" disabled={disabled}>
            <Clock />
            Send later
            <ChevronDown className="opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-56">
          {choices.map((c) => (
            <DropdownMenuItem key={c.label} onSelect={() => onPick(c.at.toISOString())}>
              <span className="flex-1">{c.label}</span>
              <span className="text-xs text-muted-foreground">{leavingLabel(c.at)}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setPicking(true)}>
            Pick a day and time…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={picking} onOpenChange={setPicking}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Send later</DialogTitle>
            <DialogDescription>
              It leaves then, in your time zone. It can be cancelled until it does.
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              if (problem || !picked) return
              setPicking(false)
              onPick(picked.toISOString())
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="send-later-at">Day and time</Label>
              <Input
                id="send-later-at"
                type="datetime-local"
                value={value}
                min={local(new Date())}
                max={local(new Date(max))}
                onChange={(e) => setValue(e.target.value)}
              />
              {problem && value && <p className="text-xs text-muted-foreground">{problem}</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setPicking(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!!problem}>
                {picked && !problem ? `Send ${leavingLabel(picked)}` : 'Send later'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
