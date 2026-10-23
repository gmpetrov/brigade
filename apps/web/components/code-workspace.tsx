'use client'
// The code panel beside a thread's preview: the files open as tabs, the one in front
// in the code editor, and the tree of the working folder the preview runs from, so
// what is saved here shows in the preview. Its state is the thread's
// (lib/code-tabs.ts); tabs keep their editors while another is in front, for undo.
import { Crosshair, FileCode2, PanelRight, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { CodeFile } from '@/components/code-file'
import { CodeTree } from '@/components/code-tree'
import { Button } from '@/components/ui/button'
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
  className?: string
}) {
  const state = useCodePanel(threadId)
  const drafts = useDraftKeys()
  const root = useRef<HTMLDivElement>(null)
  const [wide, setWide] = useState(true)

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
  const tree = state.tree || state.tabs.length === 0
  const open = (file: { path: string; line?: number }) => {
    openCodeTab(threadId, { teammateId, ...file })
    // Over the editor, the tree makes way for the file.
    if (!wide) setCodePanel(threadId, { tree: false })
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
            return (
              <div
                key={key}
                role="tab"
                aria-selected={key === state.active}
                title={
                  other
                    ? `${tab.path}, in ${teammateName(tab.teammateId)}'s copy: not the one the preview runs`
                    : tab.path
                }
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
                  <span className={cn('max-w-40 truncate', other && 'italic')}>{name}</span>
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
            title={picking ? 'Stop picking (Esc)' : 'Click an element of the page to open its code'}
            className={cn(picking && 'bg-primary/12 text-primary hover:text-primary')}
            onClick={onPick}
          >
            <Crosshair aria-hidden />
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-pressed={state.tree}
          aria-label={state.tree ? 'Hide the files' : 'Show the files'}
          title={state.tree ? 'Hide the files' : 'Show the files'}
          onClick={() => setCodePanel(threadId, { tree: !state.tree })}
        >
          <PanelRight aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close the code"
          title="Close the code"
          onClick={() => setCodePanel(threadId, { open: false })}
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
              'flex min-h-0 w-60 shrink-0 flex-col border-l bg-card',
              !wide && state.tabs.length > 0 && 'absolute inset-y-0 right-0 z-10 shadow-lg',
              !wide && state.tabs.length === 0 && 'w-full border-l-0',
            )}
          >
            <p className="truncate px-3 pt-2 text-[11px] text-muted-foreground">
              {teammateName(teammateId)}&rsquo;s copy, the one the preview runs
            </p>
            <CodeTree
              key={teammateId}
              threadId={threadId}
              teammateId={teammateId}
              reveal={[...(cwd ? [cwd] : []), ...(active ? [active.path] : [])]}
              active={active?.teammateId === teammateId ? active.path : undefined}
              onOpen={open}
              className="min-h-0 flex-1"
            />
          </div>
        )}
      </div>
    </div>
  )
}
