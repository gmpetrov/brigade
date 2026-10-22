'use client'
// Messages Brigade wrote to a teammate rather than a person (a wake-up, a schedule's run, a
// task comment, a trigger's event, a pull request's nudge), as people read them: a quiet line
// saying what it is, with what the teammate got folded under it, not a person's bubble. What
// the teammate receives stays the same.
import {
  forPeople,
  fromTaskComment,
  mentionsToText,
  scheduledRunNote,
  triggerEvent,
  wakeupNote,
} from '@brigade/contracts'
import { AlarmClock, CalendarClock, ChevronRight, Info, MessageSquare, Zap } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Raw } from '@/components/email-cards'
import { Markdown } from '@/components/markdown'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'

export type BrigadeNote = {
  icon: LucideIcon
  /** What it is, in a few words: "Wake-up set at 22 Oct 2026, 02:27". */
  label: string
  /** What it says, as Markdown: its first line shows beside the label, the whole when open. */
  body: string
  /** A trigger's event as sent, under the body when open. */
  raw?: unknown
}

/**
 * What a message is, when Brigade wrote it rather than a person (fromBrigade: no member
 * sent it, as for a thread a schedule or a trigger started); null for a person's message.
 */
export function brigadeNote(text: string, fromBrigade: boolean): BrigadeNote | null {
  if (!fromBrigade || !text.trim()) return null
  const run = scheduledRunNote(text)
  if (run)
    return {
      icon: CalendarClock,
      label: `Scheduled run of “${run.title}” · due ${run.due}`,
      body: run.instructions,
    }
  const wakeup = wakeupNote(text)
  if (wakeup)
    return {
      icon: AlarmClock,
      label:
        `Wake-up set at ${wakeup.set}` +
        (wakeup.lateMinutes ? ` · ${wakeup.lateMinutes} min late, the computer was offline` : ''),
      body: wakeup.note,
    }
  const comment = fromTaskComment(text)
  if (comment)
    return {
      icon: MessageSquare,
      label: `${comment.from} commented from “${comment.threadTitle}”`,
      body: comment.text,
    }
  const event = triggerEvent(text)
  if (event)
    return {
      icon: Zap,
      label: `Trigger “${event.trigger}” · ${event.definition}`,
      body: event.summary || `${event.type} ${event.id} on ${event.source}`,
      raw: event.payload,
    }
  return { icon: Info, label: 'From Brigade', body: forPeople(text) }
}

const firstLine = (body: string) =>
  mentionsToText(body)
    .split('\n')
    .find((line) => line.trim())
    ?.trim() ?? ''

/** Its first line, for a queued message's preview. */
export const notePreview = (note: BrigadeNote) => firstLine(note.body)

/** A note in the thread: one muted line, open for the whole of it. */
export function BrigadeNoteLine({ note }: { note: BrigadeNote }) {
  const Icon = note.icon
  return (
    <Collapsible className="text-sm text-muted-foreground">
      <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-2 text-left hover:text-foreground">
        <Icon aria-hidden className="size-4 shrink-0" />
        {/* A long title shrinks it, cut short until open, rather than pushing past the column. */}
        <span
          title={note.label}
          className="min-w-0 truncate font-medium group-data-[state=open]:whitespace-normal group-data-[state=open]:wrap-anywhere"
        >
          {note.label}
        </span>
        <span className="min-w-0 flex-1 truncate group-data-[state=open]:hidden">
          {firstLine(note.body)}
        </span>
        <ChevronRight
          aria-hidden
          className="ml-auto size-4 shrink-0 transition-transform group-data-[state=open]:rotate-90"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 flex flex-col gap-3 border-l-2 pl-4 text-foreground">
        <Markdown text={note.body} />
        {note.raw !== undefined && <Raw value={note.raw} />}
      </CollapsibleContent>
    </Collapsible>
  )
}
