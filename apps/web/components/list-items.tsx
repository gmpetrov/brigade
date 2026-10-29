'use client'
// Lists (docs/lists.md) in the dashboard: a library checklist's lines, handed to teammates.
// A line work is attached to carries an item marker, which the editor renders as the line's
// threads and pull requests; the lines picked in the editor go to a teammate, in one thread
// or a thread each, or to a thread that runs already; a thread shows the items it carries.
import {
  newListItemId,
  plainItemText,
  type ListDetail,
  type ListItemView,
  type ListPull,
  type ListThread,
  type ThreadListItems,
} from '@brigade/contracts'
import { Check, ChevronDown, GitPullRequest, ListChecks } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { useDashboard } from '@/components/dashboard'
import { ThreadStatusIcon } from '@/components/sidebar-threads'
import { useThreadPanel } from '@/components/thread-panel'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { api, useApi, type ThreadSummary } from '@/lib/api'
import { groupOf } from '@/lib/sub-threads'
import { cn } from '@/lib/utils'

/** What a list's views follow: its items, their threads and pull requests, and its file. */
export const LIST_LIVE = [
  'lists.updated',
  'thread.updated',
  'pulls.updated',
  'library.updated',
] as const
/** Without threads to follow: any thread's change would only fetch the same again. */
const QUIET_LIVE = ['lists.updated', 'pulls.updated', 'library.updated'] as const

// ---- In the editor --------------------------------------------------------------------------

const ListItemsContext = createContext<Map<string, ListItemView> | null>(null)

/** The list's items, for the chips its lines show. Null `documentId`: none (memory). */
export function ListItemsProvider({
  documentId,
  children,
}: {
  documentId: string | null
  children: ReactNode
}) {
  const [following, setFollowing] = useState(false)
  const list = useApi<ListDetail>(
    documentId ? `/lists/${documentId}` : null,
    following ? LIST_LIVE : QUIET_LIVE,
  )
  const threaded = !!list.data?.items.some((i) => i.threads.length)
  if (threaded !== following) setFollowing(threaded)
  const items = useMemo(() => new Map((list.data?.items ?? []).map((i) => [i.id, i])), [list.data])
  return <ListItemsContext.Provider value={items}>{children}</ListItemsContext.Provider>
}

/**
 * A line's marker, as the editor shows it: the threads on the line and its pull requests. It
 * says where the line stands (`data-item-state`), which the list's filters read.
 */
export function ItemChips({ id }: { id: string }) {
  const item = useContext(ListItemsContext)?.get(id)
  if (!item || (!item.threads.length && !item.pulls.length))
    return <span data-list-item={id} data-item-state={item?.state ?? 'open'} />
  return (
    <span
      contentEditable={false}
      data-list-item={id}
      data-item-state={item.state}
      className="ml-2 inline-flex flex-wrap items-center gap-1 align-[1px] select-none"
    >
      {item.threads.map((t) => (
        <ThreadChip key={t.id} thread={t} />
      ))}
      {item.pulls.map((p) => (
        <PullChip key={`${p.repository}#${p.number}`} pull={p} />
      ))}
    </span>
  )
}

const initial = (name: string) => name.trim().charAt(0).toUpperCase() || '?'

/** A thread on a line: its state, its teammate, its title; it opens the thread. */
export function ThreadChip({ thread, className }: { thread: ListThread; className?: string }) {
  const router = useRouter()
  const waiting = !thread.stuck && groupOf(thread.status) === 'waiting'
  return (
    <span
      role="link"
      tabIndex={-1}
      title={`${thread.teammate.name} · ${thread.title}`}
      onClick={(e) => {
        e.preventDefault()
        router.push(`/app/threads/${thread.id}`)
      }}
      className={cn(
        'inline-flex h-6 max-w-52 cursor-pointer items-center gap-1.5 rounded-full border bg-card px-2 text-xs font-medium text-foreground hover:bg-accent',
        waiting && 'border-warning/45 bg-warning/10',
        className,
      )}
    >
      <ThreadStatusIcon status={thread.status} stuck={thread.stuck} className="size-2.5" />
      <span className="grid size-4 shrink-0 place-items-center rounded-full bg-primary/15 text-[9.5px] font-extrabold text-primary">
        {initial(thread.teammate.name)}
      </span>
      <span className="truncate">{thread.title}</span>
      {waiting && <span className="shrink-0 text-muted-foreground">· needs you</span>}
    </span>
  )
}

/** A pull request on a line; merged ones in the accent. */
export function PullChip({ pull }: { pull: ListPull }) {
  const merged = pull.state === 'merged'
  return (
    <span
      role="link"
      tabIndex={-1}
      title={`${pull.repository}#${pull.number} · ${pull.state}${pull.closes ? ' · closes this item' : ''}`}
      onClick={(e) => {
        e.preventDefault()
        window.open(pull.url, '_blank', 'noopener')
      }}
      className={cn(
        'inline-flex h-6 cursor-pointer items-center gap-1 rounded-full border bg-card px-2 font-mono text-[11.5px] text-muted-foreground hover:bg-accent',
        merged && 'border-primary/35 text-primary',
        pull.state === 'closed' && 'line-through',
      )}
    >
      <GitPullRequest aria-hidden className="size-3" />#{pull.number}
      {merged && ' merged'}
    </span>
  )
}

// ---- Picking lines --------------------------------------------------------------------------

type Inline = { type: string; text?: string; content?: Inline[]; props?: Record<string, unknown> }
type LineBlock = { id: string; type: string; content?: unknown; props?: Record<string, unknown> }

/** The text a line shows, as the API matches it against the file. */
const textOf = (content: Inline[]): string =>
  content
    .map((c) =>
      c.type === 'text'
        ? (c.text ?? '')
        : c.type === 'link'
          ? textOf(c.content ?? [])
          : c.type === 'mention'
            ? String(c.props?.label ?? '')
            : '',
    )
    .join('')
    .trim()

const markerOf = (content: Inline[]) =>
  content.find((c) => c.type === 'item')?.props?.id as string | undefined

/** Lines picked in the editor, given their ids only once they are handed over. */
export type PickedLines = {
  lines: { text: string; id?: string }[]
  /** Ticked lines in the selection, left out: their work is done. */
  ticked: number
  /** Gives each line without a marker its own, in the document, and returns them all. */
  assign: () => { id: string; text: string }[]
}

type MarkableEditor = {
  getBlock: (id: string) => LineBlock | undefined
  updateBlock: (block: string, update: { content: unknown }) => unknown
}

/** The checklist lines among `blocks`, ready to hand over; null when there are none. */
export function pickLines(editor: MarkableEditor, blocks: LineBlock[]): PickedLines | null {
  const all = blocks.filter(
    (b) => b.type === 'checkListItem' && Array.isArray(b.content) && textOf(b.content as Inline[]),
  )
  // A ticked line is done: nothing to hand over.
  const checks = all.filter((b) => !b.props?.checked)
  if (!checks.length) return null
  const lines = checks.map((b) => ({
    blockId: b.id,
    text: textOf(b.content as Inline[]),
    id: markerOf(b.content as Inline[]),
  }))
  return {
    lines: lines.map(({ text, id }) => ({ text, ...(id ? { id } : {}) })),
    ticked: all.length - checks.length,
    assign: () =>
      lines.map((line) => {
        if (line.id) return { id: line.id, text: line.text }
        const block = editor.getBlock(line.blockId)
        const content = (block?.content as Inline[] | undefined) ?? []
        const found = markerOf(content)
        if (found) return { id: found, text: line.text }
        const id = newListItemId()
        const last = content.at(-1)
        const spaced = last?.type === 'text' && /\s$/.test(last.text ?? '')
        editor.updateBlock(line.blockId, {
          content: [
            ...content,
            ...(spaced ? [] : [{ type: 'text', text: ' ', styles: {} }]),
            { type: 'item', props: { id } },
          ],
        })
        return { id, text: line.text }
      }),
  }
}

// ---- Handing lines over ---------------------------------------------------------------------

type Mode = 'together' | 'each' | 'thread'

/**
 * Hand lines of a list to a teammate: `start` with the lines picked; `dialog` asks how (one
 * thread, a thread each, or a thread that runs already), then opens the thread.
 */
export function useHandOff(
  file: { id: string; path: string } | null,
  teammate: { id: string; name: string } | null,
) {
  const [picked, setPicked] = useState<PickedLines | null>(null)
  const dialog =
    file && picked ? (
      <HandOffDialog
        file={file}
        picked={picked}
        defaultTeammate={teammate}
        onClose={() => setPicked(null)}
      />
    ) : null
  return { start: file ? setPicked : null, dialog }
}

function HandOffDialog({
  file,
  picked,
  defaultTeammate,
  onClose,
}: {
  file: { id: string; path: string }
  picked: PickedLines
  defaultTeammate: { id: string; name: string } | null
  onClose: () => void
}) {
  const { teammates } = useDashboard()
  const { openThread } = useThreadPanel()
  const threads = useApi<ThreadSummary[]>('/threads')
  const [teammateId, setTeammateId] = useState(defaultTeammate?.id ?? teammates[0]?.id ?? '')
  const count = picked.lines.length
  const [mode, setMode] = useState<Mode>('together')
  const [threadId, setThreadId] = useState('')
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const teammate = teammates.find((t) => t.id === teammateId)
  const recent = (threads.data ?? []).slice(0, 30)

  const submit = async () => {
    setSending(true)
    setError(undefined)
    try {
      const items = picked.assign()
      if (mode === 'thread') {
        await api(`/lists/${file.id}/link`, { body: { sessionId: threadId, items } })
        openThread(threadId)
      } else {
        const { threadIds } = await api<{ threadIds: string[] }>(`/lists/${file.id}/hand-off`, {
          body: { teammateId, items, mode, ...(note.trim() ? { note: note.trim() } : {}) },
        })
        if (threadIds[0]) openThread(threadIds[0])
      }
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setSending(false)
    }
  }

  const shown = picked.lines.slice(0, 5)
  return (
    <Dialog open onOpenChange={(open) => !open && !sending && onClose()}>
      {/* One column no wider than the dialog: a long line is cut, never widening it. */}
      <DialogContent className="grid-cols-1 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {count === 1 ? 'Hand this item over' : `Hand ${count} items over`}
          </DialogTitle>
          <DialogDescription>
            Their lines show the thread working on them, and get ticked as the work lands.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex min-w-0 flex-col gap-1 rounded-lg bg-muted px-3 py-2 text-sm">
          {shown.map((l, i) => (
            <li key={i} className="min-w-0 truncate" title={plainItemText(l.text)}>
              {plainItemText(l.text)}
            </li>
          ))}
          {count > shown.length && (
            <li className="text-muted-foreground">and {count - shown.length} more</li>
          )}
        </ul>
        {picked.ticked > 0 && (
          <p className="-mt-2 text-[13px] text-muted-foreground">
            {picked.ticked === 1
              ? '1 ticked line left out: it is done.'
              : `${picked.ticked} ticked lines left out: they are done.`}
          </p>
        )}
        <RadioGroup value={mode} onValueChange={(v) => setMode(v as Mode)} className="gap-3">
          <ModeOption value="together" title={count > 1 ? 'One thread' : 'A new thread'}>
            {count > 1
              ? `${teammate?.name ?? 'The teammate'} works on them together and ticks each when done.`
              : `${teammate?.name ?? 'The teammate'} works on it and ticks it when done.`}
          </ModeOption>
          {count > 1 && (
            <ModeOption value="each" title="One thread each">
              {count} threads, side by side in the sidebar.
            </ModeOption>
          )}
          <ModeOption value="thread" title="A thread that runs already">
            Its teammate is told at its next turn.
          </ModeOption>
        </RadioGroup>
        {mode === 'thread' ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="hand-off-thread">Thread</Label>
            <Select value={threadId} onValueChange={setThreadId}>
              <SelectTrigger id="hand-off-thread" className="w-full">
                <SelectValue placeholder="Pick a thread" />
              </SelectTrigger>
              <SelectContent>
                {recent.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    <span className="truncate">
                      {t.title} · {t.teammate.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="hand-off-teammate">Teammate</Label>
              <Select value={teammateId} onValueChange={setTeammateId}>
                <SelectTrigger id="hand-off-teammate" className="w-full">
                  <SelectValue placeholder="Pick a teammate" />
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
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="hand-off-note">
                Note <span className="font-normal text-muted-foreground">optional</span>
              </Label>
              <Textarea
                id="hand-off-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Start with the cheapest one."
                rows={2}
              />
            </div>
          </>
        )}
        {error && <p className="text-sm text-destructive-text">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={sending}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={sending || (mode === 'thread' ? !threadId : !teammateId)}
          >
            {mode === 'thread' ? 'Add to thread' : `Hand to ${teammate?.name ?? 'teammate'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ModeOption({
  value,
  title,
  children,
}: {
  value: Mode
  title: string
  children: ReactNode
}) {
  return (
    <Label
      htmlFor={`hand-off-${value}`}
      className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent"
    >
      <RadioGroupItem id={`hand-off-${value}`} value={value} className="mt-0.5" />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-semibold">{title}</span>
        <span className="text-[13px] text-muted-foreground">{children}</span>
      </span>
    </Label>
  )
}

// ---- In a thread ----------------------------------------------------------------------------

/** The items a thread carries, at its top: ticked as the work lands, each tickable here too. */
export function ThreadItemsCard({ threadId, className }: { threadId: string; className?: string }) {
  const items = useApi<ThreadListItems>(`/lists/threads/${threadId}`, QUIET_LIVE)
  const [open, setOpen] = useState(true)
  const [busy, setBusy] = useState<string>()
  const list = items.data ?? []
  if (!list.length) return null
  const lists = [...new Map(list.map((i) => [i.documentId, i])).values()]
  const done = list.filter((i) => i.done).length
  const toggle = async (id: string, value: boolean) => {
    setBusy(id)
    try {
      await api(`/lists/items/${id}/done`, { method: 'PUT', body: { done: value } })
      await items.reload()
    } catch (e) {
      window.alert((e as Error).message)
    } finally {
      setBusy(undefined)
    }
  }
  return (
    <section
      aria-label="Working on"
      className={cn('mb-4 rounded-2xl border bg-card shadow-sm', className)}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[13px]"
      >
        <ListChecks aria-hidden className="size-4 shrink-0" />
        <span className="font-semibold">Working on</span>
        <span className="min-w-0 truncate text-muted-foreground">
          · {list.length} {list.length === 1 ? 'item' : 'items'} in{' '}
          {lists.map((l, i) => (
            <span key={l.documentId}>
              {i > 0 && ', '}
              <Link
                href={`/app/lists/${l.documentId}`}
                onClick={(e) => e.stopPropagation()}
                className="font-semibold text-foreground hover:underline"
              >
                {l.listTitle}
              </Link>
            </span>
          ))}
        </span>
        <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
          {done}/{list.length}
        </span>
        <ChevronDown
          aria-hidden
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform',
            !open && '-rotate-90',
          )}
        />
      </button>
      {open && (
        <ul className="flex flex-col border-t px-2 py-1.5">
          {list.map((item) => (
            <li key={item.id} className="flex items-start gap-2.5 rounded-lg px-2 py-1.5">
              <button
                type="button"
                role="checkbox"
                aria-checked={item.done}
                aria-label={item.done ? 'Untick' : 'Tick'}
                disabled={busy === item.id || item.missing}
                onClick={() => void toggle(item.id, !item.done)}
                className={cn(
                  'mt-0.5 grid size-4 shrink-0 place-items-center rounded-[5px] border-[1.5px] border-foreground/45 bg-card',
                  item.done && 'border-primary bg-primary text-primary-foreground',
                )}
              >
                {item.done && <Check aria-hidden className="size-3" strokeWidth={3} />}
              </button>
              <span className="min-w-0 flex-1 text-sm leading-snug">
                <span className={cn(item.done && 'text-muted-foreground')}>
                  {plainItemText(item.text)}
                </span>
                {(item.missing || item.doneBy) && (
                  <span className="block text-xs text-muted-foreground italic">
                    {item.missing
                      ? 'No longer in its list: its line or its marker was removed'
                      : `Ticked by ${item.doneBy!.name}`}
                  </span>
                )}
              </span>
              {item.pulls.length > 0 && (
                <span className="flex shrink-0 gap-1">
                  {item.pulls.map((p) => (
                    <PullChip key={`${p.repository}#${p.number}`} pull={p} />
                  ))}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
