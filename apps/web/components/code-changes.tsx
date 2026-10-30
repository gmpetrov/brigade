'use client'
// The code panel's Changes: the files of the teammate's working folder that differ
// from where their branch left its default branch, or from their last commit
// (lib/code-changes.ts), to open with what
// changed shown in the editor, and to revert one by one or all at once.
import type { CodeChange } from '@brigade/contracts'
import { Undo2 } from 'lucide-react'
import { comparedTo, type CodeChanges as Changes } from '@/lib/code-changes'
import { cn } from '@/lib/utils'
import { Hint } from '@/components/ui/tooltip'

const STATUS: Record<CodeChange['status'], { label: string; className: string }> = {
  M: { label: 'Modified', className: 'text-warning' },
  A: { label: 'New', className: 'text-success' },
  D: { label: 'Deleted', className: 'text-destructive-text' },
}

export function CodeChanges({
  data,
  error,
  unsupported,
  active,
  mayEdit,
  reverting,
  onOpen,
  onRevert,
  className,
}: {
  data?: Changes
  error?: string
  unsupported?: boolean
  /** The file in front, marked. */
  active?: string
  mayEdit: boolean
  /** A revert under way: its buttons wait. */
  reverting: boolean
  onOpen: (file: { path: string }) => void
  onRevert: (paths: string[]) => void
  className?: string
}) {
  const changes = data?.changes ?? []
  const against = comparedTo(data)
  return (
    <div className={cn('flex min-h-0 flex-col text-xs', className)}>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
        {unsupported ? (
          <p className="px-2 py-1 text-muted-foreground">
            Update Brigade on this computer to see the changes.
          </p>
        ) : !data ? (
          <p className={cn('px-2 py-1', error ? 'text-destructive-text' : 'text-muted-foreground')}>
            {error ?? 'Looking…'}
          </p>
        ) : changes.length === 0 ? (
          <p className="px-2 py-1 text-muted-foreground">No changes {against.since}.</p>
        ) : (
          <>
            {changes.map((change) => {
              const slash = change.path.lastIndexOf('/')
              const name = change.path.slice(slash + 1)
              const status = STATUS[change.status]
              const deleted = change.status === 'D'
              return (
                <div
                  key={change.path}
                  className={cn(
                    'group flex min-w-0 items-center rounded-md hover:bg-muted',
                    change.path === active && 'bg-primary/10',
                  )}
                >
                  <button
                    type="button"
                    disabled={deleted}
                    title={
                      deleted ? `${change.path}, deleted ${comparedTo(change).since}` : change.path
                    }
                    className="flex min-w-0 flex-1 items-baseline gap-2 py-1 pr-1 pl-2 text-left disabled:cursor-default"
                    onClick={() => onOpen({ path: change.path })}
                  >
                    <Hint label={status.label}>
                      <span
                        aria-label={status.label}
                        className={cn('w-2.5 shrink-0 font-mono font-semibold', status.className)}
                      >
                        {change.status}
                      </span>
                    </Hint>
                    <span
                      className={cn('shrink-0', deleted && 'text-muted-foreground line-through')}
                    >
                      {name}
                    </span>
                    <span className="truncate text-muted-foreground">
                      {change.path.slice(0, slash)}
                    </span>
                  </button>
                  {mayEdit && (
                    <Hint
                      label={
                        change.status === 'A'
                          ? `Delete it: it is new ${comparedTo(change).since}`
                          : `Put it back ${comparedTo(change).as}`
                      }
                    >
                      <button
                        type="button"
                        disabled={reverting}
                        aria-label={`Revert ${name}`}
                        className="mr-1 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground disabled:opacity-40"
                        onClick={() => onRevert([change.path])}
                      >
                        <Undo2 aria-hidden className="size-3.5" />
                      </button>
                    </Hint>
                  )}
                </div>
              )
            })}
            {data.more && <p className="px-2 py-1 text-muted-foreground">More not shown.</p>}
          </>
        )}
      </div>
      {mayEdit && changes.length > 0 && (
        <div className="shrink-0 border-t p-2">
          <button
            type="button"
            disabled={reverting}
            className="h-7 w-full rounded-md border text-foreground hover:bg-muted disabled:opacity-50"
            onClick={() => onRevert(changes.map((c) => c.path))}
          >
            {reverting ? 'Reverting…' : 'Revert all'}
          </button>
        </div>
      )}
    </div>
  )
}
