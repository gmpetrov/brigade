'use client'
// Library files moved to the trash: restored where they were, or deleted for
// good, by hand or TRASH_DAYS days on.
import { RotateCcw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { timeAgo } from '@/components/dashboard'
import { ActorName, size } from '@/components/library-history'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { api, useApi, type TrashedFile } from '@/lib/api'

const DAY = 24 * 60 * 60_000

export function LibraryTrash({ onRestored }: { onRestored: (fileId: string) => Promise<void> }) {
  const trash = useApi<TrashedFile[]>('/library/trash')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()

  async function act(id: string, work: () => Promise<unknown>) {
    setBusy(id)
    setError(undefined)
    try {
      await work()
      await trash.reload()
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(undefined)
  }

  if (trash.error) return <p className="text-sm text-destructive-text">{trash.error.message}</p>
  if (!trash.data) return <p className="text-sm text-muted-foreground">Loading…</p>
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Files stay here for 30 days, then they are deleted for good. Teammates don&apos;t see
          them.
        </p>
        {trash.data.length > 0 && (
          <Button
            variant="danger"
            size="sm"
            disabled={Boolean(busy)}
            onClick={() =>
              confirm(
                `Delete the ${trash.data!.length} file(s) in the trash for good? This can't be undone.`,
              ) && void act('all', () => api('/library/trash', { method: 'DELETE' }))
            }
          >
            <Trash2 aria-hidden />
            Empty the trash
          </Button>
        )}
      </div>
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      {trash.data.length === 0 ? (
        <Card className="items-center border-dashed px-6 py-10 text-center text-sm text-muted-foreground shadow-none">
          The trash is empty.
        </Card>
      ) : (
        <Card className="gap-0 divide-y py-0">
          {trash.data.map((f) => {
            const slash = f.path.lastIndexOf('/')
            const days = Math.max(0, Math.ceil((Date.parse(f.purgeAt) - Date.now()) / DAY))
            return (
              <div key={f.id} className="flex flex-wrap items-center gap-4 px-5 py-3">
                <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
                  <span className="truncate text-sm">
                    {slash > 0 && (
                      <span className="text-muted-foreground">{f.path.slice(0, slash + 1)}</span>
                    )}
                    <span className="font-semibold">{f.path.slice(slash + 1)}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {size(f.size)} · deleted {timeAgo(f.deletedAt)}
                    {f.deletedBy && (
                      <>
                        {' by '}
                        <ActorName actor={f.deletedBy} />
                      </>
                    )}{' '}
                    · gone for good in {days} day{days === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void act(f.id, async () => {
                        await api(`/library/trash/${f.id}/restore`, { body: {} })
                        await onRestored(f.id)
                      })
                    }
                  >
                    <RotateCcw aria-hidden />
                    Restore
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      confirm(`Delete ${f.path} for good? This can't be undone.`) &&
                      void act(f.id, () => api(`/library/trash/${f.id}`, { method: 'DELETE' }))
                    }
                  >
                    Delete for good
                  </Button>
                </div>
              </div>
            )
          })}
        </Card>
      )}
    </div>
  )
}
