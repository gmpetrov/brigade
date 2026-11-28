'use client'
// A thread's Tree, in its details (docs/sub-threads.md): each sub-thread below it at its level,
// on a branch line like the sidebar's, with its teammate, the computer it runs on, what it is at,
// the line of a list it works on, what it produced and the tokens it spent; the whole tree's
// tokens in the section's title. A working one stops from here, a failed one tries again.
import type { ThreadTree, TreeNode, TreeNodeState } from '@brigade/contracts'
import { RotateCcw, Square } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { ThreadStatusIcon } from '@/components/sidebar-threads'
import { Button } from '@/components/ui/button'
import { api, useApi } from '@/lib/api'
import { cn } from '@/lib/utils'

/** What each state reads as, and the dot it shows (ThreadStatusIcon's statuses). */
const STATES: Record<TreeNodeState, { label: string; dot: string }> = {
  working: { label: 'working', dot: 'running' },
  waiting: { label: 'waiting', dot: 'running' },
  needs_you: { label: 'needs you', dot: 'waiting' },
  needs_parent: { label: 'needs parent', dot: 'running' },
  failed: { label: 'failed', dot: 'failed' },
  done: { label: 'done', dot: 'done' },
  cancelled: { label: 'cancelled', dot: 'done' },
  idle: { label: 'idle', dot: 'idle' },
}

/** Tokens, short: 950, 12k, 1.2M. */
export const shortTokens = (n: number) =>
  n < 1_000
    ? String(n)
    : n < 1_000_000
      ? `${Math.round(n / 100) / 10}k`.replace('.0k', 'k')
      : `${Math.round(n / 100_000) / 10}M`.replace('.0M', 'M')

/** A branch line from its parent, ending in a rounded elbow at the last row, as in the sidebar. */
const BRANCH =
  'relative pl-3.5 before:pointer-events-none before:absolute before:top-0 before:bottom-0 before:left-0 before:border-l before:border-border last:before:bottom-auto last:before:h-4 last:before:w-2 last:before:rounded-bl-lg last:before:border-b'

/** What it produced, in a few words: its pull requests, documents and files. */
function outputs(node: TreeNode) {
  const parts: string[] = node.pullRequests.map((p) => `#${p.number}`)
  if (node.documents.length)
    parts.push(node.documents.length === 1 ? '1 document' : `${node.documents.length} documents`)
  if (node.files) parts.push(node.files === 1 ? '1 file' : `${node.files} files`)
  return parts.join(', ')
}

function TreeRow({ node, onChange }: { node: TreeNode; onChange: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const state = STATES[node.state]
  const act = (path: 'interrupt' | 'retry') => {
    setBusy(true)
    setError(undefined)
    void api(`/threads/${node.id}/${path}`, { body: {} })
      .then(onChange, (e: unknown) =>
        setError(e instanceof Error ? e.message : 'It did not go through. Try again.'),
      )
      .finally(() => setBusy(false))
  }
  const made = outputs(node)
  const where = node.computer.kind === 'cloud' ? 'cloud computer' : node.computer.name
  return (
    <div className="group/tree flex min-w-0 items-start gap-1">
      <Link
        href={`/app/threads/${node.id}`}
        className="flex min-w-0 flex-1 flex-col rounded-lg px-2 py-1.5 text-sm hover:bg-accent"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <ThreadStatusIcon
            status={state.dot}
            ask={node.state === 'needs_you' ? 'needs you' : undefined}
          />
          <span className="shrink-0 text-muted-foreground">{node.teammate.name}</span>
          <span className="min-w-0 flex-1 truncate font-medium">{node.title}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{state.label}</span>
        </span>
        <span className="truncate pl-5.5 text-xs text-muted-foreground">
          {[where, `${shortTokens(node.tokens)} tokens`, made, node.line && `“${node.line}”`]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {error && <span className="pl-5.5 text-xs text-destructive-text">{error}</span>}
      </Link>
      {node.state === 'working' && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="mt-1.5 shrink-0 md:opacity-0 md:group-hover/tree:opacity-100 focus-visible:opacity-100"
          disabled={busy}
          tooltip="Stop"
          aria-label={`Stop “${node.title}”`}
          onClick={() => act('interrupt')}
        >
          <Square aria-hidden />
        </Button>
      )}
      {/* Its turn failed, which Retry runs again; a failed report on a turn that ended has nothing to retry. */}
      {node.status === 'failed' && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="mt-1.5 shrink-0"
          disabled={busy}
          tooltip="Try again"
          aria-label={`Try “${node.title}” again`}
          onClick={() => act('retry')}
        >
          <RotateCcw aria-hidden />
        </Button>
      )}
    </div>
  )
}

/** The sub-threads under `parentId`, each on its branch, with theirs one step further in. */
function Branches({
  nodes,
  parentId,
  onChange,
}: {
  nodes: TreeNode[]
  parentId: string
  onChange: () => void
}) {
  const here = nodes.filter((n) => n.parentId === parentId)
  if (!here.length) return null
  return (
    <ul className="flex min-w-0 flex-col">
      {here.map((n) => (
        <li key={n.id} className={BRANCH}>
          <TreeRow node={n} onChange={onChange} />
          <div className="ml-2.5">
            <Branches nodes={nodes} parentId={n.id} onChange={onChange} />
          </div>
        </li>
      ))}
    </ul>
  )
}

/** The tree below a thread, live: null while it loads, or when it has no sub-threads. */
export function useThreadTree(threadId: string) {
  return useApi<ThreadTree>(`/threads/${threadId}/tree`, ['thread.updated'])
}

export function TreeList({
  threadId,
  tree,
  onChange,
  className,
}: {
  threadId: string
  tree: ThreadTree
  onChange: () => void
  className?: string
}) {
  return (
    <div className={cn('ml-2 flex min-w-0 flex-col', className)}>
      <Branches nodes={tree.nodes} parentId={threadId} onChange={onChange} />
    </div>
  )
}

/** The section's title: how many, and the tokens of the whole tree. */
export const treeTitle = (tree: ThreadTree) =>
  `Tree · ${tree.nodes.length} · ${shortTokens(tree.tokens.tree)} tokens`
