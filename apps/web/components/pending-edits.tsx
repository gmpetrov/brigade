'use client'
// The composer's pending edits: elements picked in the thread's preview and comments
// made on a design's canvas beside it, one numbered row each with what should change
// there, until the person sends them all in one message with what they wrote
// (lib/pending-edits.ts). Each row's note can be changed or the row removed.
import { Palette, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { PreviewElementChip, type PickedElement } from '@/components/preview-elements'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export type PendingEditRow = {
  key: string
  /** Where it is, under its name: the page, or the design's board. */
  where: string
  note: string
  onNote: (note: string) => void
  onRemove: () => void
} & ({ kind: 'element'; picked: PickedElement } | { kind: 'design'; label: string })

export function PendingEdits({
  rows,
  focus,
  onDone,
  className,
}: {
  rows: PendingEditRow[]
  /** The row whose note takes the focus, once: the one just added. */
  focus?: string
  /** Enter in a note: back to the message. */
  onDone?: () => void
  className?: string
}) {
  const notes = useRef(new Map<string, HTMLTextAreaElement>())
  useEffect(() => {
    if (!focus) return
    notes.current.get(focus)?.focus({ preventScroll: false })
  }, [focus])
  if (!rows.length) return null
  return (
    <section
      aria-label="Pending edits"
      className={cn(
        'flex max-h-72 flex-col overflow-y-auto rounded-lg border bg-muted/40',
        className,
      )}
    >
      <p className="sticky top-0 z-10 flex items-baseline gap-2 border-b bg-muted px-2.5 py-1.5 text-xs">
        <span className="font-medium">Pending edits</span>
        <span className="text-muted-foreground">
          {rows.length === 1 ? '1 edit' : `${rows.length} edits`}, sent together with your message
        </span>
      </p>
      <ol className="flex flex-col">
        {rows.map((row, i) => (
          <li
            key={row.key}
            className="group/edit flex items-start gap-2 border-b px-2.5 py-1.5 last:border-b-0"
          >
            <span
              aria-hidden
              className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[0.6875rem] font-semibold text-primary-foreground tabular-nums"
            >
              {i + 1}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex min-w-0 items-center gap-1.5">
                {row.kind === 'element' ? (
                  <PreviewElementChip {...row.picked} className="min-w-0 shrink" />
                ) : (
                  <span className="inline-flex min-w-0 shrink items-center gap-1 rounded-md bg-primary/12 px-1.5 py-0.5 text-xs leading-5 text-primary">
                    <Palette aria-hidden className="size-3.5 shrink-0" />
                    <span className="min-w-0 truncate">{row.label}</span>
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate font-mono text-[0.6875rem] text-muted-foreground">
                  {row.where}
                </span>
              </div>
              <textarea
                ref={(el) => {
                  if (el) notes.current.set(row.key, el)
                  else notes.current.delete(row.key)
                }}
                aria-label={`Edit ${i + 1}: what should change`}
                value={row.note}
                rows={1}
                placeholder="What should change here?"
                onChange={(e) => row.onNote(e.target.value)}
                onKeyDown={(e) => {
                  // Enter is done with this note (not a send: the others may still be
                  // written); Shift+Enter is a new line.
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    onDone?.()
                  }
                }}
                className="field-sizing-content max-h-32 w-full resize-none bg-transparent py-0.5 text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="shrink-0 rounded-full text-muted-foreground"
              onClick={row.onRemove}
              aria-label={`Remove edit ${i + 1}`}
              tooltip="Remove"
            >
              <X aria-hidden />
            </Button>
          </li>
        ))}
      </ol>
    </section>
  )
}
