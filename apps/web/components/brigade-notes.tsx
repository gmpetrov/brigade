'use client'
// Messages Brigade wrote to a teammate rather than a person (a wake-up, a schedule's run, a
// message or brief from another thread, a trigger's event, a pull request's nudge), as people
// read them: a quiet line saying what it is, with what the teammate got folded under it, not a
// person's bubble. What the teammate receives stays the same.
import {
  chiefAnswerNote,
  chiefOverruledNote,
  documentFileId,
  isChiefPassBrief,
  forPeople,
  fromStartedThreadBrief,
  fromTaskBrief,
  fromThreadComment,
  handOffParts,
  mentionsToText,
  resolveConflictsNote,
  scheduledRunNote,
  triggerEvent,
  wakeupNote,
} from '@brigade/contracts'
import {
  AlarmClock,
  CalendarClock,
  ChevronRight,
  Crown,
  FileText,
  GitMerge,
  Info,
  ListTodo,
  MessageSquare,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { MediaPreview } from '@/components/attachments'
import { Raw } from '@/components/email-cards'
import { Markdown } from '@/components/markdown'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Hint } from '@/components/ui/tooltip'
import { documentFileUrl } from '@/lib/api'
import { LIBRARY_IMAGE_FILE } from '@/lib/played-files'

export type BrigadeNote = {
  icon: LucideIcon
  /** What it is, in a few words: "Wake-up set at 22 Oct 2026, 02:27". */
  label: string
  /** What it says, as Markdown: its first line shows beside the label, the whole when open. */
  body: string
  /** A trigger's event as sent, under the body when open. */
  raw?: unknown
  /** An answer Chief gave in the person's name (docs/chief-answers.md): its decision. */
  chief?: { decisionId: string }
  /** Files of the library's documents that went with it (a hand-off's), under the body when open. */
  files?: { id: string; name: string }[]
}

/**
 * What a message is, when Brigade wrote it rather than a person (fromBrigade: no member
 * sent it, as for a thread a schedule or a trigger started); null for a person's message.
 */
export function brigadeNote(text: string, fromBrigade: boolean): BrigadeNote | null {
  if (!fromBrigade || !text.trim()) return null
  const answer = chiefAnswerNote(text)
  if (answer)
    return {
      icon: Crown,
      label: `Chief answered for you · “${answer.answer}”`,
      body: answer.reason + (answer.basis ? `\n\nBy your rule: ${answer.basis}` : ''),
      chief: { decisionId: answer.decisionId },
    }
  const overruled = chiefOverruledNote(text)
  if (overruled)
    return {
      icon: Crown,
      label: `You marked Chief’s answer as wrong · “${overruled.answer}”`,
      body: 'Its teammate was told to stop what it started on it and undo what it can.',
    }
  if (isChiefPassBrief(text))
    return { icon: Crown, label: 'What waited on you, as Chief read it', body: text }
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
  const comment = fromThreadComment(text)
  if (comment)
    return {
      icon: MessageSquare,
      label: `${comment.from} commented from “${comment.threadTitle}”`,
      body: comment.text,
    }
  const started = fromStartedThreadBrief(text)
  if (started)
    return {
      icon: ListTodo,
      label: `${started.from} started this thread from “${started.threadTitle}”`,
      body: started.text,
    }
  // An old task thread's brief, from the Tasks board's days.
  const brief = fromTaskBrief(text)
  if (brief)
    return {
      icon: ListTodo,
      label: `${brief.from} started this task from “${brief.threadTitle}”`,
      body: brief.text,
    }
  const resolve = resolveConflictsNote(text)
  if (resolve)
    return {
      icon: GitMerge,
      label: `Resolve the conflicts of #${resolve.number} with ${resolve.base}, then merge`,
      body: text,
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

/**
 * Lines of a list a person handed over (handOffMessage), with no note of theirs: what they handed
 * over and from where, rather than the request it is worded as for the teammate.
 */
export function handOffNote(text: string): BrigadeNote | null {
  const handOff = handOffParts(text)
  if (!handOff) return null
  const count = handOff.items.length
  // The files that went with the lines: in the library, beside the list (documentFilePath).
  const files = (handOff.files ?? []).flatMap((path) => {
    const id = documentFileId(path)
    return id ? [{ id, name: path.split('/').pop() ?? path }] : []
  })
  return {
    icon: ListTodo,
    label: `Handed over ${count} ${count > 1 ? 'items' : 'item'} of ${handOff.file.path.split('/').pop()}`,
    body: handOff.items.map((item) => `- ${item}`).join('\n'),
    ...(files.length ? { files } : {}),
  }
}

const firstLine = (body: string) =>
  mentionsToText(body)
    .split('\n')
    .find((line) => line.trim())
    ?.trim()
    .replace(/^[-*] +/, '') ?? ''

/** Its first line, for a queued message's preview. */
export const notePreview = (note: BrigadeNote) => firstLine(note.body)

/** A note in the thread: one muted line, open for the whole of it, with what can be done about it. */
export function BrigadeNoteLine({ note, action }: { note: BrigadeNote; action?: React.ReactNode }) {
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
        {note.files && <NoteFiles files={note.files} />}
        {note.raw !== undefined && <Raw value={note.raw} />}
        {action}
      </CollapsibleContent>
    </Collapsible>
  )
}

/** The files that went with a note: images as small pictures that open larger, others by name. */
function NoteFiles({ files }: { files: NonNullable<BrigadeNote['files']> }) {
  const [open, setOpen] = useState<{ name: string; src: string }>()
  return (
    <span className="flex flex-wrap items-start gap-2">
      {files.map((f) => {
        const src = documentFileUrl(`asset:${f.id}`)
        return LIBRARY_IMAGE_FILE.test(f.name) ? (
          <Hint key={f.id} label={`Preview ${f.name}`}>
            <button
              type="button"
              aria-label={`Preview ${f.name}`}
              onClick={() => setOpen({ name: f.name, src })}
              className="block h-20 cursor-zoom-in overflow-hidden rounded-lg border bg-muted/40"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- a document's file through the API */}
              <img src={src} alt={f.name} loading="lazy" className="block h-full w-auto" />
            </button>
          </Hint>
        ) : (
          <a
            key={f.id}
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex max-w-64 items-center gap-1.5 rounded-lg border px-2 py-1 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <FileText aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">{f.name}</span>
          </a>
        )
      })}
      <MediaPreview
        media={open ? { ...open, kind: 'image' } : undefined}
        onClose={() => setOpen(undefined)}
        unavailable="This file can’t be shown: it is no longer in its document."
      />
    </span>
  )
}
