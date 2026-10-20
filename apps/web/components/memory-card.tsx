'use client'
// A memory file as people see it: its core, which every thread loads, each line
// with the day it was learned or last confirmed; its topics, which threads read
// when their work touches them, folded; and the lines it let go (the archive),
// which can be put back. Editing opens the file in the document editor.
import {
  parseMemoryFile,
  type ArchivedMemoryLine,
  type EditTarget,
  type MemoryFile,
  type MemoryLineInfo,
} from '@brigade/contracts'
import { BookOpen, ChevronRight, RotateCcw, Search } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { timeAgo } from '@/components/dashboard'
import { useDocumentPanel } from '@/components/document-panel'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "19 Oct", with the year when it is not this one. */
function day(iso: string) {
  const d = new Date(iso)
  const label = `${d.getDate()} ${MONTHS[d.getMonth()]}`
  return d.getFullYear() === new Date().getFullYear() ? label : `${label} ${d.getFullYear()}`
}

/** Where a line came from, in a few words. */
function source(info: MemoryLineInfo) {
  if (info.legacy) return `There before ${day(info.at)}, when memory started keeping dates`
  const when = `Learned or confirmed on ${day(info.at)}`
  if (info.by) return `Written by ${info.by} · ${when}`
  return info.threadTitle ? `${when} · from “${info.threadTitle}”` : when
}

function LineDate({ info }: { info: MemoryLineInfo | undefined }) {
  if (!info) return null
  const label = info.legacy ? `before ${day(info.at)}` : day(info.at)
  const className = 'shrink-0 text-xs whitespace-nowrap text-muted-foreground tabular-nums'
  return info.sessionId && !info.legacy ? (
    <Link
      href={`/app/threads/${info.sessionId}`}
      title={source(info)}
      className={`${className} hover:underline`}
    >
      {label}
    </Link>
  ) : (
    <span title={source(info)} className={className}>
      {label}
    </span>
  )
}

function Lines({
  lines,
  info,
}: {
  lines: { text: string; key: string }[]
  info: Record<string, MemoryLineInfo>
}) {
  return (
    <ul className="flex flex-col gap-1.5">
      {lines.map((line) => (
        <li key={line.key} className="flex items-baseline gap-3">
          <span aria-hidden className="text-muted-foreground">
            •
          </span>
          <Markdown text={line.text} className="flex-1 text-sm" />
          <LineDate info={info[line.key]} />
        </li>
      ))}
    </ul>
  )
}

export function MemoryCard({
  title,
  description,
  file,
  target,
  onSaved,
}: {
  title: string
  description: string
  file: MemoryFile
  target: EditTarget
  onSaved: () => Promise<void>
}) {
  const documents = useDocumentPanel()
  const editing = JSON.stringify(documents.current?.target) === JSON.stringify(target)
  const [archive, setArchive] = useState(false)
  const layers = parseMemoryFile(file.text)
  const empty = layers.core.length === 0 && layers.topics.length === 0
  return (
    <Card className="gap-3">
      <div className="flex items-start justify-between gap-4 px-6">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="flex items-center gap-2 text-base font-bold">
            <BookOpen aria-hidden className="size-4 text-muted-foreground" />
            {title}
          </h2>
          <p className="text-sm text-muted-foreground">
            {description}
            {file.updatedAt && ` Updated ${timeAgo(file.updatedAt)}.`}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {file.archived > 0 && file.documentId && (
            <Button variant="ghost" size="sm" onClick={() => setArchive(true)}>
              Removed lines
              <span className="text-muted-foreground tabular-nums">{file.archived}</span>
            </Button>
          )}
          <Button
            variant={editing ? 'default' : 'outline'}
            size="sm"
            aria-pressed={editing}
            onClick={() => {
              if (!editing) {
                documents.open({ target, title: `${title} memory`, subtitle: description })
                return
              }
              documents.close()
              void onSaved()
            }}
          >
            {editing ? 'Done' : 'Edit'}
          </Button>
        </div>
      </div>
      <CardContent className="flex flex-col gap-4">
        {empty ? (
          <p className="text-sm text-muted-foreground">Nothing remembered yet.</p>
        ) : (
          <>
            {layers.core.length > 0 && <Lines lines={layers.core} info={file.lines} />}
            {layers.topics.length > 0 && (
              <div className="flex flex-col divide-y rounded-lg border">
                {layers.topics.map((topic) => {
                  const newest = topic.lines
                    .map((l) => file.lines[l.key])
                    .filter((i): i is MemoryLineInfo => !!i && !i.legacy)
                    .map((i) => i.at)
                    .sort()
                    .at(-1)
                  return (
                    <Collapsible key={topic.name}>
                      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-2.5 text-left">
                        <ChevronRight
                          aria-hidden
                          className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="text-sm font-semibold">{topic.name}</span>
                          {topic.description && (
                            <span className="ml-2 text-sm text-muted-foreground">
                              {topic.description}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                          {topic.lines.length} line{topic.lines.length === 1 ? '' : 's'}
                          {newest && ` · ${day(newest)}`}
                        </span>
                      </CollapsibleTrigger>
                      <CollapsibleContent className="px-4 pb-3 pl-10">
                        <Lines lines={topic.lines} info={file.lines} />
                      </CollapsibleContent>
                    </Collapsible>
                  )
                })}
              </div>
            )}
          </>
        )}
      </CardContent>
      {archive && file.documentId && (
        <MemoryArchive
          title={title}
          documentId={file.documentId}
          onClose={() => setArchive(false)}
          onRestored={onSaved}
        />
      )}
    </Card>
  )
}

/** The lines a memory let go: why, when and by whom, searchable, each one can be put back. */
function MemoryArchive({
  title,
  documentId,
  onClose,
  onRestored,
}: {
  title: string
  documentId: string
  onClose: () => void
  onRestored: () => Promise<void>
}) {
  const [query, setQuery] = useState('')
  const [lines, setLines] = useState<ArchivedMemoryLine[]>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      api<ArchivedMemoryLine[]>(
        `/library/memory/${documentId}/archive?q=${encodeURIComponent(query.trim())}`,
      ).then(
        (found) => live && setLines(found),
        (e: Error) => live && setError(e.message),
      )
    }, 200)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [documentId, query, reload])

  async function restore(line: ArchivedMemoryLine) {
    setBusy(line.id)
    setError(undefined)
    try {
      await api(`/library/memory/${documentId}/archive/${line.id}/restore`, { body: {} })
      setReload((n) => n + 1)
      await onRestored()
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(undefined)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[min(90dvh,48rem)] flex-col gap-4 sm:max-w-2xl">
        <div className="flex flex-col gap-1">
          <DialogTitle className="text-lg font-bold">Lines {title} memory let go</DialogTitle>
          <DialogDescription>
            Replaced, merged, outdated or removed. Teammates no longer load them, but search still
            finds them. Put one back if it still holds.
          </DialogDescription>
        </div>
        <div className="relative">
          <Search
            aria-hidden
            className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search removed lines"
            className="pl-9"
          />
        </div>
        {error && <p className="text-sm text-destructive-text">{error}</p>}
        <div className="-mx-6 min-h-0 flex-1 overflow-y-auto border-t">
          {!lines ? (
            <p className="px-6 py-4 text-sm text-muted-foreground">Loading…</p>
          ) : lines.length === 0 ? (
            <p className="px-6 py-4 text-sm text-muted-foreground">
              {query.trim() ? `Nothing matches “${query.trim()}”.` : 'No line was removed yet.'}
            </p>
          ) : (
            <ul className="divide-y">
              {lines.map((line) => (
                <li key={line.id} className="flex items-start gap-4 px-6 py-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <Markdown text={line.text} className="text-sm" />
                    <span className="text-xs text-muted-foreground">
                      {line.reason}
                      {' · '}
                      {day(line.archivedAt)}
                      {line.archivedBy && ` by ${line.archivedBy}`}
                      {line.topic && ` · was under ${line.topic}`}
                      {line.sessionId && (
                        <>
                          {' · learned in '}
                          <Link href={`/app/threads/${line.sessionId}`} className="hover:underline">
                            {line.threadTitle ?? 'a thread'}
                          </Link>
                        </>
                      )}
                    </span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={Boolean(busy)}
                    onClick={() => void restore(line)}
                  >
                    <RotateCcw aria-hidden />
                    Put back
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
