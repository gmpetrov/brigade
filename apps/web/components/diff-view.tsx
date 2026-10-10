'use client'
// A pull request's changes, file by file, from GitHub's unified diff hunks.
// Teammates' line comments show under the line they are about.
import { ChevronRight, FileDiff, MessageSquare } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type { DiffFile } from '@/lib/api'
import { cn } from '@/lib/utils'

export type LineComment = { path: string; line: number; body: string; author: string }

type Line =
  | { kind: 'hunk'; text: string }
  | { kind: 'add' | 'del' | 'ctx'; text: string; old: number | null; new: number | null }
  | { kind: 'note'; text: string }

/** Files longer than this start collapsed. */
const OPEN_LINES_MAX = 400

export function parsePatch(patch: string): Line[] {
  const lines: Line[] = []
  let oldLine = 0
  let newLine = 0
  for (const raw of patch.split('\n')) {
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      lines.push({ kind: 'hunk', text: raw })
    } else if (raw.startsWith('+')) {
      lines.push({ kind: 'add', text: raw.slice(1), old: null, new: newLine++ })
    } else if (raw.startsWith('-')) {
      lines.push({ kind: 'del', text: raw.slice(1), old: oldLine++, new: null })
    } else if (raw.startsWith('\\')) {
      lines.push({ kind: 'note', text: raw.slice(2) })
    } else {
      lines.push({ kind: 'ctx', text: raw.slice(1), old: oldLine++, new: newLine++ })
    }
  }
  return lines
}

const statusLabel: Record<string, string> = {
  added: 'added',
  removed: 'deleted',
  renamed: 'renamed',
  modified: '',
  changed: '',
  copied: 'copied',
}

function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="flex-none font-mono text-xs tabular-nums">
      <span className="text-success">+{additions}</span>{' '}
      <span className="text-destructive-text">−{deletions}</span>
    </span>
  )
}

function FileDiffView({ file, comments }: { file: DiffFile; comments: LineComment[] }) {
  const lines = useMemo(() => (file.patch ? parsePatch(file.patch) : []), [file.patch])
  const [open, setOpen] = useState(lines.length <= OPEN_LINES_MAX)
  const byLine = useMemo(() => {
    const map = new Map<number, LineComment[]>()
    for (const c of comments) map.set(c.line, [...(map.get(c.line) ?? []), c])
    return map
  }, [comments])
  const label = statusLabel[file.status] ?? file.status

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="overflow-hidden rounded-lg border bg-card"
    >
      <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-2 border-b bg-secondary/50 px-3 py-2 text-left text-sm data-[state=closed]:border-b-0">
        <ChevronRight
          className="size-4 flex-none text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate font-mono text-xs font-semibold" title={file.path}>
          {file.previousPath && file.previousPath !== file.path
            ? `${file.previousPath} → ${file.path}`
            : file.path}
        </span>
        {comments.length > 0 && (
          <span className="flex flex-none items-center gap-1 text-xs text-muted-foreground">
            <MessageSquare className="size-3.5" aria-hidden />
            {comments.length}
          </span>
        )}
        {label && <span className="flex-none text-xs text-muted-foreground">{label}</span>}
        <Counts additions={file.additions} deletions={file.deletions} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        {lines.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            {file.status === 'renamed' && file.additions + file.deletions === 0
              ? 'Renamed without changes.'
              : 'GitHub shows no diff for this file (binary, or too large).'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse font-mono text-xs leading-5">
              <tbody>
                {lines.map((l, i) => {
                  if (l.kind === 'hunk')
                    return (
                      <tr key={i} className="bg-primary/5 text-muted-foreground">
                        <td colSpan={3} className="px-3 py-0.5 whitespace-pre">
                          {l.text}
                        </td>
                      </tr>
                    )
                  if (l.kind === 'note')
                    return (
                      <tr key={i} className="text-muted-foreground italic">
                        <td colSpan={3} className="px-3 whitespace-pre">
                          {l.text}
                        </td>
                      </tr>
                    )
                  const notes = l.new !== null ? byLine.get(l.new) : undefined
                  return [
                    <tr
                      key={i}
                      className={cn(
                        l.kind === 'add' && 'bg-success/10',
                        l.kind === 'del' && 'bg-destructive/10',
                      )}
                    >
                      <td className="w-10 px-2 text-right text-muted-foreground/70 tabular-nums select-none">
                        {l.old ?? ''}
                      </td>
                      <td className="w-10 px-2 text-right text-muted-foreground/70 tabular-nums select-none">
                        {l.new ?? ''}
                      </td>
                      <td className="pr-4 whitespace-pre">
                        <span
                          aria-hidden
                          className={cn(
                            'inline-block w-4 select-none',
                            l.kind === 'add' && 'text-success',
                            l.kind === 'del' && 'text-destructive-text',
                          )}
                        >
                          {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
                        </span>
                        {l.text}
                      </td>
                    </tr>,
                    ...(notes ?? []).map((c, j) => (
                      <tr key={`${i}:${j}`}>
                        <td colSpan={3} className="border-y bg-background px-3 py-2">
                          <div className="flex max-w-prose flex-col gap-0.5 font-sans text-sm whitespace-pre-wrap">
                            <span className="font-semibold">{c.author}</span>
                            {c.body}
                          </div>
                        </td>
                      </tr>
                    )),
                  ]
                })}
              </tbody>
            </table>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

export function DiffView({
  files,
  cut,
  comments = [],
}: {
  files: DiffFile[]
  cut?: boolean
  comments?: LineComment[]
}) {
  if (files.length === 0)
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <FileDiff className="size-4" aria-hidden /> No files changed.
      </p>
    )
  return (
    <div className="flex flex-col gap-3">
      {files.map((f) => (
        <FileDiffView key={f.path} file={f} comments={comments.filter((c) => c.path === f.path)} />
      ))}
      {cut && (
        <p className="text-sm text-muted-foreground">
          More files changed than Brigade shows. See the rest on GitHub.
        </p>
      )}
    </div>
  )
}
