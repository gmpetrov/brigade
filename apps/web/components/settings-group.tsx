'use client'
// A settings page's groups: a small label over one card whose settings are rows split by a thin
// line. Each row says in one line what it does, with its key facts as chips and the rest folded
// behind "How it works", and its control (a switch, a button) on the right.
import { ChevronRight } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import { Card } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

export function SettingsGroup({
  title,
  className,
  children,
}: {
  title: string
  /** For the card, e.g. a destructive border. */
  className?: string
  children: ReactNode
}) {
  return (
    <section className="flex max-w-xl flex-col gap-2">
      <h2 className="px-1 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
        {title}
      </h2>
      <Card className={cn('gap-0 divide-y py-0', className)}>{children}</Card>
    </section>
  )
}

export function SettingRow({
  title,
  detail,
  chips,
  more,
  control,
  children,
}: {
  title: string
  detail: ReactNode
  /** Key facts, each in a chip under the detail. */
  chips?: string[]
  /** What the detail leaves out, folded behind "How it works". */
  more?: ReactNode
  /** The row's control, given the id its title labels and the id of its detail. */
  control?: (ids: { id: string; describedBy: string }) => ReactNode
  /** Below the detail, across the row, e.g. a text box its title labels. */
  children?: (ids: { id: string; describedBy: string }) => ReactNode
}) {
  const id = useId()
  const describedBy = `${id}-detail`
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col gap-3 px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor={id} className="leading-snug">
            {title}
          </Label>
          <p id={describedBy} className="text-xs leading-relaxed text-muted-foreground">
            {detail}
          </p>
          {chips && chips.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {chips.map((chip) => (
                <span
                  key={chip}
                  className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                >
                  {chip}
                </span>
              ))}
            </div>
          )}
          {more && (
            <>
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
                className="mt-1 inline-flex w-fit cursor-pointer items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground"
              >
                How it works
                <ChevronRight
                  aria-hidden
                  className={cn('size-3.5 transition-transform', open && 'rotate-90')}
                />
              </button>
              {open && <p className="text-xs leading-relaxed text-muted-foreground">{more}</p>}
            </>
          )}
        </div>
        {control?.({ id, describedBy })}
      </div>
      {children?.({ id, describedBy })}
    </div>
  )
}
