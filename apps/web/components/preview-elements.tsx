'use client'
// Elements picked in a thread's preview: chips above the composer until the message
// is sent, and above the message in the thread once it is (contracts' preview-elements.ts).
import type { PreviewElement } from '@brigade/contracts'
import { SquareMousePointer, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** Where it is, for its tooltip: the page, its selector and its text. */
function describe(element: PreviewElement) {
  const text = element.html
    .replace(/<[^>]*>?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return [
    `${element.page}  ${element.selector}`,
    element.components?.length ? element.components.join(' › ') : '',
    text.length > 160 ? `${text.slice(0, 160)}…` : text,
  ]
    .filter(Boolean)
    .join('\n')
}

export function PreviewElementChip({
  element,
  onRemove,
  className,
}: {
  element: PreviewElement
  onRemove?: () => void
  className?: string
}) {
  return (
    <span
      title={describe(element)}
      className={cn(
        'inline-flex max-w-full min-w-0 items-center gap-1 rounded-md bg-primary/12 py-0.5 pl-1.5 font-mono text-xs leading-5 text-primary',
        onRemove ? 'pr-0.5' : 'pr-1.5',
        className,
      )}
    >
      <SquareMousePointer aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{element.label}</span>
      {onRemove && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="size-5 shrink-0 rounded-full text-primary hover:text-primary"
          onClick={onRemove}
          aria-label={`Remove ${element.label}`}
          title="Remove"
        >
          <X aria-hidden />
        </Button>
      )}
    </span>
  )
}

export function PreviewElementChips({
  elements,
  onRemove,
  className,
}: {
  elements: PreviewElement[]
  onRemove?: (index: number) => void
  className?: string
}) {
  if (!elements.length) return null
  return (
    <div className={cn('flex max-w-full flex-wrap gap-1', className)}>
      {elements.map((element, i) => (
        <PreviewElementChip
          key={`${element.page} ${element.selector} ${i}`}
          element={element}
          {...(onRemove ? { onRemove: () => onRemove(i) } : {})}
        />
      ))}
    </div>
  )
}
