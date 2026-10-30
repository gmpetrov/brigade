'use client'
// The code panel beside a thread's preview: the files open as tabs, the one in front
// in the code editor, and left of it the tree of the working folder the preview runs from, so
// what is saved here shows in the preview. Its state is the thread's
// (lib/code-tabs.ts); tabs keep their editors while another is in front, for undo.
// Beside the tree, Changes: the files changed on the branch (or since the last commit),
// which the editor shows against it, each to revert. Without a preview, the same panel
// opens on its own beside the thread (components/changes-panel.tsx).
import { Crosshair, FileCode2, PanelLeft, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CodeChanges } from '@/components/code-changes'
import { CodeFile } from '@/components/code-file'
import { CodeTree } from '@/components/code-tree'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import {
  baseByPath,
  comparedTo,
  mixedBases,
  statusByPath,
  useCodeChanges,
} from '@/lib/code-changes'
import { draftKey, setDraft, useDraftKeys } from '@/lib/code-drafts'
import {
  closeCodeTab,
  openCodeTab,
  setCodePanel,
  tabKey,
  useCodePanel,
  type CodeTab,
} from '@/lib/code-tabs'
import { cn } from '@/lib/utils'
import { Hint } from '@/components/ui/tooltip'

/** Narrower than this, the tree lays over the editor instead of beside it. */
const TREE_BESIDE_MIN = 560

export function CodeWorkspace({
  threadId,
  teammateId,
  teammateName,
  mayEdit,
  cwd,
  shown = true,
  picking,
  onPick,
  inPreview = true,
  onClose,
  actions,
  className,
}: {
  threadId: string
  /** The teammate whose copy the preview runs: its tree shows. */
  teammateId: string
  teammateName: (id: string) => string
  mayEdit: boolean
  /** The preview's folder, relative to the working folder: open in the tree at first. */
  cwd?: string
  /** On screen (a phone shows the preview or the code): only then are files watched. */
  shown?: boolean
  /** Picking an element in the page to open its code. */
  picking?: boolean
  onPick?: () => void
  /** Beside the preview, whose copy it shows; else on its own beside the thread. */
  inPreview?: boolean
  /** Its ×: the code panel closes beside the preview, unless this does something else. */
  onClose?: () => void
  /** Before its ×: the panel's own buttons, when it is one. */
  actions?: ReactNode
  className?: string
}) {
  const state = useCodePanel(threadId)
  const drafts = useDraftKeys()
  const root = useRef<HTMLDivElement>(null)
  const [wide, setWide] = useState(true)
  const changes = useCodeChanges(threadId, teammateId, shown)
  const statuses = statusByPath(changes.data)
  const bases = baseByPath(changes.data)
  const changed = changes.data?.changes.length ?? 0
  const against = comparedTo(changes.data)
  const [reverting, setReverting] = useState(false)
  const [revertError, setRevertError] = useState<string>()
  /** Files reverted, by path: a count each open one reads its file again at. */
  const [reverted, setReverted] = useState<Record<string, number>>({})

  useEffect(() => {
    const el = root.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) =>
      setWide((entry?.contentRect.width ?? 0) >= TREE_BESIDE_MIN),
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const active = state.tabs.find((t) => tabKey(t) === state.active)
  // A file brought in front (picked in the page, opened from a message), or the panel
  // found narrow: over the editor, the tree makes way for the file.
  useEffect(() => {
    if (!wide && state.active) setCodePanel(threadId, { tree: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- when the tab in front, or the width, changes
  }, [state.active, wide])
  const tree = state.tree || state.tabs.length === 0
  const showChanges = state.side === 'changes' && !changes.unsupported
  const open = (file: { path: string; line?: number }) => {
    openCodeTab(threadId, { teammateId, ...file })
    // Over the editor, the tree makes way for the file.
    if (!wide) setCodePanel(threadId, { tree: false })
  }
  /**
   * Puts files back as Changes compares them to, once asked: new ones are deleted, and
   * their tabs close; open ones show the file as it is then, unsaved edits dropped.
   * Why not, if it failed.
   */
  const revert = async (paths: string[]) => {
    const files = paths.map((path) => ({
      path,
      status: statuses.get(path) ?? 'M',
      base: bases.get(path),
    }))
    // Each file as its own repository compares it: one word when they all share it.
    const one = comparedTo({ base: files[0]?.base })
    const shared = files.every((f) => f.base === files[0]?.base)
    const name = (path: string) => path.split('/').pop()
    const fresh = files.filter((f) => f.status === 'A').length
    const question =
      files.length === 1
        ? files[0]!.status === 'A'
          ? `Delete ${name(files[0]!.path)}? It is new ${one.since}.`
          : files[0]!.status === 'D'
            ? `Restore ${name(files[0]!.path)} ${one.as}?`
            : `Revert ${name(files[0]!.path)} to ${one.to}? Its changes are lost.`
        : `Revert ${files.length} files to ${
            shared ? one.to : 'their default branch, or their last commit without one'
          }? Their changes are lost${
            fresh
              ? `, and ${fresh === 1 ? 'the new file is' : `${fresh} new files are`} deleted`
              : ''
          }.`
    if (!window.confirm(question)) return
    setReverting(true)
    setRevertError(undefined)
    try {
      await api(`/threads/${threadId}/code/revert`, { body: { teammateId, paths } })
    } catch (e) {
      setRevertError((e as Error).message)
      return (e as Error).message
    } finally {
      setReverting(false)
      changes.refresh()
    }
    for (const f of files) {
      setDraft(draftKey(threadId, teammateId, f.path), undefined)
      if (f.status === 'A') closeCodeTab(threadId, tabKey({ teammateId, path: f.path }))
    }
    setReverted((was) => {
      const next = { ...was }
      for (const f of files) next[f.path] = (next[f.path] ?? 0) + 1
      return next
    })
  }

  const close = (tab: CodeTab) => {
    const key = draftKey(threadId, tab.teammateId, tab.path)
    if (drafts.has(key)) {
      if (!window.confirm(`Discard your unsaved changes to ${tab.path.split('/').pop()}?`)) return
      setDraft(key, undefined)
    }
    closeCodeTab(threadId, tabKey(tab))
  }

  return (
    <div ref={root} className={cn('flex min-h-0 min-w-0 flex-col bg-card', className)}>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b pr-1.5">
        <div
          role="tablist"
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1.5"
        >
          {state.tabs.map((tab) => {
            const key = tabKey(tab)
            const name = tab.path.split('/').pop()
            const other = tab.teammateId !== teammateId
            const dirty = drafts.has(draftKey(threadId, tab.teammateId, tab.path))
            const status = other ? undefined : statuses.get(tab.path)
            return (
              <Hint
                key={key}
                label={
                  other
                    ? `${tab.path}, in ${teammateName(tab.teammateId)}'s copy${inPreview ? ': not the one the preview runs' : ''}`
                    : tab.path
                }
              >
                <div
                  role="tab"
                  aria-selected={key === state.active}
                  className={cn(
                    'group flex h-7 shrink-0 items-center gap-1 rounded-md pr-1 pl-2 text-xs',
                    key === state.active
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                  )}
                >
                  <button
                    type="button"
                    className="flex items-center gap-1.5"
                    onClick={() => setCodePanel(threadId, { active: key })}
                    onAuxClick={(e) => e.button === 1 && close(tab)}
                  >
                    <FileCode2 aria-hidden className="size-3.5 shrink-0" />
                    <span
                      className={cn(
                        'max-w-40 truncate',
                        other && 'italic',
                        // Changed, as the Changes list says.
                        status === 'M' && 'text-warning',
                        status === 'A' && 'text-success',
                      )}
                    >
                      {name}
                    </span>
                    {other && (
                      <span className="rounded bg-warning/15 px-1 text-[10px] text-warning not-italic">
                        {teammateName(tab.teammateId)}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label={`Close ${name}`}
                    className="grid size-4 place-items-center rounded-sm hover:bg-foreground/10"
                    onClick={() => close(tab)}
                  >
                    {/* Unsaved: a dot, which turns into the close button under the pointer. */}
                    {dirty ? (
                      <>
                        <span className="size-1.5 rounded-full bg-primary group-hover:hidden" />
                        <X aria-hidden className="hidden size-3 group-hover:block" />
                      </>
                    ) : (
                      <X
                        aria-hidden
                        className={cn(
                          'size-3',
                          key !== state.active && 'opacity-0 group-hover:opacity-100',
                        )}
                      />
                    )}
                  </button>
                </div>
              </Hint>
            )
          })}
        </div>
        {onPick && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-pressed={picking}
            aria-label={picking ? 'Stop picking' : 'Open the code of an element of the page'}
            tooltip={
              picking ? 'Stop picking (Esc)' : 'Click an element of the page to open its code'
            }
            className={cn(picking && 'bg-primary/12 text-primary hover:text-primary')}
            onClick={onPick}
          >
            <Crosshair aria-hidden />
          </Button>
        )}
        {/* With no file open the list always shows: nothing to hide it for. */}
        {state.tabs.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-pressed={state.tree}
            aria-label={state.tree ? 'Hide the files' : 'Show the files'}
            tooltip={
              state.tree
                ? 'Hide the files'
                : changed
                  ? `Show the files: ${changed} changed${mixedBases(changes.data) ? '' : ` ${against.since}`}`
                  : 'Show the files'
            }
            className="relative"
            onClick={() => setCodePanel(threadId, { tree: !state.tree })}
          >
            <PanelLeft aria-hidden />
            {/* Files changed, while the list is hidden. */}
            {!tree && changed > 0 && (
              <span className="absolute top-1 right-1 size-1.5 rounded-full bg-primary" />
            )}
          </Button>
        )}
        {actions}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close the code"
          tooltip="Close the code"
          onClick={onClose ?? (() => setCodePanel(threadId, { open: false }))}
        >
          <X aria-hidden />
        </Button>
      </div>
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {state.tabs.map((tab) => {
            const key = tabKey(tab)
            const front = key === state.active
            return (
              <CodeFile
                key={key}
                threadId={threadId}
                teammateId={tab.teammateId}
                path={tab.path}
                teammateName={teammateName(tab.teammateId)}
                mayEdit={mayEdit}
                line={tab.line}
                lineKey={tab.nonce}
                visible={shown && front}
                breadcrumb
                className={front ? undefined : 'hidden'}
                {...(tab.teammateId === teammateId && changes.data
                  ? {
                      head: changes.data.head,
                      base: bases.get(tab.path),
                      status: statuses.get(tab.path),
                      reloadKey: reverted[tab.path],
                      onRevert: () => revert([tab.path]),
                      onSaved: changes.refresh,
                    }
                  : {})}
              />
            )
          })}
          {state.tabs.length === 0 && (
            <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center text-sm text-muted-foreground">
              <p>Open a file from the list.</p>
              {onPick && <p>Or pick an element of the page to open its code.</p>}
            </div>
          )}
        </div>
        {tree && (
          <div
            className={cn(
              // Left of the editor, as in an editor: never between the code and the preview.
              'order-first flex min-h-0 w-60 shrink-0 flex-col border-r bg-card',
              !wide && state.tabs.length > 0 && 'absolute inset-y-0 left-0 z-10 shadow-lg',
              !wide && state.tabs.length === 0 && 'w-full border-r-0',
            )}
          >
            <p className="truncate px-3 pt-2 text-[11px] text-muted-foreground">
              {teammateName(teammateId)}&rsquo;s copy{inPreview && ', the one the preview runs'}
            </p>
            {!changes.unsupported && (
              <div role="tablist" className="flex shrink-0 gap-1 px-2 pt-2 text-xs">
                {(['files', 'changes'] as const).map((side) => (
                  <button
                    key={side}
                    type="button"
                    role="tab"
                    aria-selected={(state.side ?? 'files') === side}
                    className={cn(
                      'flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md',
                      (state.side ?? 'files') === side
                        ? 'bg-muted text-foreground'
                        : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                    )}
                    onClick={() => setCodePanel(threadId, { side })}
                  >
                    {side === 'files' ? 'Files' : 'Changes'}
                    {side === 'changes' && changes.data && (
                      <span
                        className={cn(
                          'min-w-4 rounded px-1 text-[10px] leading-4 tabular-nums',
                          changed
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted-foreground/15 text-muted-foreground',
                        )}
                      >
                        {changes.data.more ? `${changed}+` : changed}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
            {showChanges && (
              <>
                {revertError && (
                  <p role="alert" className="px-3 pt-2 text-xs text-destructive-text">
                    {revertError}
                  </p>
                )}
                <CodeChanges
                  data={changes.data}
                  error={changes.error}
                  active={active?.teammateId === teammateId ? active.path : undefined}
                  mayEdit={mayEdit}
                  reverting={reverting}
                  onOpen={open}
                  onRevert={(paths) => void revert(paths)}
                  className="min-h-0 flex-1"
                />
              </>
            )}
            {/* Kept while Changes shows: its open folders stay as they were. */}
            <CodeTree
              key={teammateId}
              threadId={threadId}
              teammateId={teammateId}
              reveal={[...(cwd ? [cwd] : []), ...(active ? [active.path] : [])]}
              active={active?.teammateId === teammateId ? active.path : undefined}
              onOpen={open}
              className={cn('min-h-0 flex-1', showChanges && 'hidden')}
            />
          </div>
        )}
      </div>
    </div>
  )
}
