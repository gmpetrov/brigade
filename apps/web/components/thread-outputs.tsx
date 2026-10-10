'use client'
// What a thread made, beside it: files its teammates wrote or named, library
// documents, images, pull requests, emails and schedules. Read from the event
// log, newest first; a file made again keeps one row.
import type { SequencedEvent } from '@brigade/contracts'
import {
  CalendarClock,
  FileText,
  GitPullRequest,
  Image as ImageIcon,
  Library,
  Mail,
} from 'lucide-react'
import Link from 'next/link'
import { useMemo, useState } from 'react'
import { relativeFile, type OpenFile } from '@/components/file-links'
import { pullHref } from '@/lib/api'

export type ThreadOutput = {
  key: string
  kind: 'file' | 'library' | 'image' | 'pull' | 'email' | 'schedule'
  label: string
  detail?: string
  at: string
  /** Opens beside the thread. */
  file?: { path: string; teammateId?: string }
  href?: string
}

/** Rows shown before "Show all". */
const SHOWN = 6

/**
 * Files a message names that are something made to hand over, not code it
 * read: a script can write a PDF without a write tool the runner sees.
 */
const DELIVERABLE =
  /\.(?:pdf|docx?|xlsx?|pptx?|odt|ods|odp|csv|zip|png|jpe?g|gif|webp|svg|mp3|mp4|wav)$/i

/** Code a teammate wrote to make something (a script that renders a PDF), not the thing itself. */
const CODE =
  /\.(?:py|ipynb|[cm]?[jt]sx?|sh|bash|zsh|rb|go|rs|java|kt|swift|php|c|cc|cpp|h|hpp|cs|sql|css|scss|lock)$/i

const json = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value ?? ''))

/** The bare tool name, without an MCP server's `mcp__server__` prefix. */
const bare = (toolName: string) => toolName.replace(/^mcp__.+?__/, '')

const name = (path: string) => path.split('/').pop() ?? path

function namedFiles(text: string) {
  const found = new Set<string>()
  for (const [, code] of text.matchAll(/`([^`\n]+)`/g)) found.add(code!.trim())
  for (const [, href] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const path = relativeFile(href)
    if (path) found.add(path)
  }
  return [...found]
    .map((p) => p.replace(/:\d+(:\d+)?$/, ''))
    .filter((p) => DELIVERABLE.test(p) && !/^(?:\.\/)?attachments\//.test(p) && !/\s/.test(p))
}

export function useThreadOutputs(events: SequencedEvent[]) {
  return useMemo(() => {
    const byKey = new Map<string, ThreadOutput>()
    // Re-adding moves it to the end: the latest version's time and place.
    const add = (output: ThreadOutput) => {
      byKey.delete(output.key)
      byKey.set(output.key, output)
    }
    const named = (text: string, at: string, teammateId: string | undefined) => {
      for (const path of namedFiles(text)) {
        // Named again after it was made: not a new version.
        if (byKey.has(`file:${path}`)) continue
        add({
          key: `file:${path}`,
          kind: /\.(?:png|jpe?g|gif|webp|svg)$/i.test(path) ? 'image' : 'file',
          label: name(path),
          detail: path,
          at,
          file: { path, teammateId },
        })
      }
    }
    // Messages still streaming. One cut off when the computer stopped never gets
    // its message.done, so what it named counts when its turn ends.
    const streaming = new Map<string, { text: string; at: string; teammateId?: string }>()
    const flush = () => {
      for (const m of streaming.values()) named(m.text, m.at, m.teammateId)
      streaming.clear()
    }
    const calls = new Map<string, { toolName: string; input: unknown }>()
    for (const { event: e } of events) {
      switch (e.type) {
        case 'file.changed':
          if (CODE.test(e.path)) break
          add({
            key: `file:${e.path}`,
            kind: 'file',
            label: name(e.path),
            detail: e.path,
            at: e.at,
            file: { path: e.path, teammateId: e.teammateId },
          })
          break
        case 'image.generated':
          add({
            key: `file:${e.path}`,
            kind: 'image',
            label: name(e.path),
            detail: e.prompt ?? e.path,
            at: e.at,
            file: { path: e.path, teammateId: e.teammateId },
          })
          break
        case 'message.delta': {
          const m = streaming.get(e.id)
          if (m) m.text += e.text
          else streaming.set(e.id, { text: e.text, at: e.at, teammateId: e.teammateId })
          break
        }
        case 'message.done':
          streaming.delete(e.id)
          named(e.text, e.at, e.teammateId)
          break
        case 'turn.completed':
          flush()
          break
        case 'tool.started':
          calls.set(`${e.teammateId ?? ''}:${e.toolCallId}`, {
            toolName: e.toolName,
            input: e.input,
          })
          break
        case 'tool.finished': {
          const id = `${e.teammateId ?? ''}:${e.toolCallId}`
          const call = calls.get(id)
          calls.delete(id)
          if (!call || e.isError) break
          const input = (call.input ?? {}) as Record<string, unknown>
          const tool = bare(call.toolName)
          if (tool === 'save_to_library' && typeof input.path === 'string') {
            add({
              key: `library:${input.path}`,
              kind: 'library',
              label: name(input.path),
              detail: `Library · ${input.path}`,
              at: e.at,
              file: { path: input.path },
            })
          } else if (tool === 'github_create_pull_request') {
            const found = json(e.output).match(
              /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/,
            )
            if (!found) break
            const repository = found[1]!.toLowerCase()
            const number = Number(found[2])
            add({
              key: `pull:${repository}#${number}`,
              kind: 'pull',
              label: typeof input.title === 'string' ? input.title : `Pull request #${number}`,
              detail: `${repository}#${number}`,
              at: e.at,
              href: pullHref(repository, number),
            })
          } else if (/^(?:gmail_)?(?:send|send_message|create_draft|reply|forward)$/.test(tool)) {
            if (!/gmail|mail/i.test(call.toolName)) break
            const to = Array.isArray(input.to) ? input.to.join(', ') : input.to
            const subject = typeof input.subject === 'string' ? input.subject : undefined
            const draft = /draft/.test(tool)
            add({
              key: `email:${id}`,
              kind: 'email',
              label: subject ?? (draft ? 'Email draft' : 'Email'),
              detail: [draft ? 'Draft, not sent' : 'Sent', typeof to === 'string' ? to : '']
                .filter(Boolean)
                .join(' · '),
              at: e.at,
            })
          } else if (tool === 'create_schedule' && typeof input.title === 'string') {
            add({
              key: `schedule:${input.title}`,
              kind: 'schedule',
              label: input.title,
              detail: typeof input.cron === 'string' ? `Schedule · ${input.cron}` : 'Schedule',
              at: e.at,
              href: '/app/automations',
            })
          }
          break
        }
      }
    }
    flush()
    return [...byKey.values()].reverse()
  }, [events])
}

const ICONS = {
  file: FileText,
  library: Library,
  image: ImageIcon,
  pull: GitPullRequest,
  email: Mail,
  schedule: CalendarClock,
} satisfies Record<ThreadOutput['kind'], unknown>

const time = (at: string) =>
  new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

export function ThreadOutputs({ outputs, onOpen }: { outputs: ThreadOutput[]; onOpen: OpenFile }) {
  const [all, setAll] = useState(false)
  const shown = all ? outputs : outputs.slice(0, SHOWN)
  return (
    <div className="flex flex-col gap-1">
      <ul className="flex flex-col">
        {shown.map((output) => {
          const Icon = ICONS[output.kind]
          const body = (
            <>
              <Icon className="size-4 flex-none text-muted-foreground" aria-hidden />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{output.label}</span>
                {output.detail && (
                  <span className="truncate text-xs text-muted-foreground">{output.detail}</span>
                )}
              </span>
              <time dateTime={output.at} className="flex-none text-xs text-muted-foreground">
                {time(output.at)}
              </time>
            </>
          )
          const row = 'flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left'
          return (
            <li key={output.key}>
              {output.file ? (
                <button
                  type="button"
                  className={`${row} hover:bg-secondary/60`}
                  title={output.file.path}
                  onClick={() => onOpen(output.file!)}
                >
                  {body}
                </button>
              ) : output.href ? (
                <Link href={output.href} className={`${row} hover:bg-secondary/60`}>
                  {body}
                </Link>
              ) : (
                <div className={row}>{body}</div>
              )}
            </li>
          )
        })}
      </ul>
      {outputs.length > SHOWN && (
        <button
          type="button"
          className="self-start px-2 text-xs font-medium text-primary hover:underline"
          onClick={() => setAll(!all)}
        >
          {all ? 'Show fewer' : `Show all ${outputs.length}`}
        </button>
      )}
    </div>
  )
}
