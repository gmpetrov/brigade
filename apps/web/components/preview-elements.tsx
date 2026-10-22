'use client'
// Elements picked in a thread's preview: chips above the composer until the message
// is sent, and above the message in the thread once it is (contracts' preview-elements.ts).
// A click on one opens what the teammate gets, as Claude shows it: its picture, element,
// component, props and text, and the rest under More details.
import type { PreviewElement } from '@brigade/contracts'
import { ChevronRight, SquareMousePointer, X } from 'lucide-react'
import { Popover } from 'radix-ui'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** A picked element, and where its picture shows from (an object URL, or its attachment's). */
export type PickedElement = {
  element: PreviewElement
  picture?: string
  /** Its page is still drawing its picture: the message waits for it. */
  drawing?: boolean
}

function Row({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{name}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  )
}

function ElementCard({ element, picture }: PickedElement) {
  const [more, setMore] = useState(false)
  const component = element.components?.at(-1)
  const props = Object.entries(element.props ?? {})
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="flex items-center gap-1.5 text-muted-foreground">
        <SquareMousePointer aria-hidden className="size-4" />
        Included with your message
      </p>
      {picture && (
        // eslint-disable-next-line @next/next/no-img-element -- an object URL or an attachment
        <img
          src={picture}
          alt=""
          className="max-h-48 max-w-full self-start rounded-md border bg-muted object-contain"
        />
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
        <Row name="Element">{element.label}</Row>
        {component && (
          <Row name="Component">
            <span className="font-mono">{component}</span>
          </Row>
        )}
        {props.length > 0 && (
          <Row name="Props">
            <span className="grid grid-cols-[auto_1fr] gap-x-3 font-mono text-xs leading-5">
              {props.map(([key, value]) => (
                <span key={key} className="contents">
                  <span className="text-muted-foreground">{key}</span>
                  <span className="truncate" title={value}>
                    {value}
                  </span>
                </span>
              ))}
            </span>
          </Row>
        )}
        {element.text && (
          <Row name="Text">
            <span className="line-clamp-4">{element.text}</span>
          </Row>
        )}
        {more && (
          <>
            <Row name="Page">
              <span className="font-mono text-xs">{element.page || '/'}</span>
            </Row>
            <Row name="Selector">
              <span className="font-mono text-xs">{element.selector}</span>
            </Row>
            {element.size && <Row name="Size">{element.size}</Row>}
            {element.components && element.components.length > 1 && (
              <Row name="Inside">
                <span className="font-mono text-xs">{element.components.join(' › ')}</span>
              </Row>
            )}
          </>
        )}
      </dl>
      {more && (
        <pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
          {element.html}
        </pre>
      )}
      <button
        type="button"
        className="flex items-center gap-1 self-start text-muted-foreground hover:text-foreground"
        aria-expanded={more}
        onClick={() => setMore(!more)}
      >
        <ChevronRight
          aria-hidden
          className={cn('size-4 transition-transform', more && 'rotate-90')}
        />
        {more ? 'Fewer details' : 'More details'}
      </button>
    </div>
  )
}

export function PreviewElementChip({
  element,
  picture,
  drawing,
  onRemove,
  className,
}: PickedElement & { onRemove?: () => void; className?: string }) {
  return (
    <Popover.Root>
      <span
        className={cn(
          'inline-flex max-w-full min-w-0 items-center rounded-md bg-primary/12 font-mono text-xs leading-5 text-primary',
          className,
        )}
      >
        <Popover.Trigger asChild>
          <button
            type="button"
            className={cn(
              'flex min-w-0 items-center gap-1 rounded-md py-0.5 pl-1.5 hover:bg-primary/10',
              onRemove ? 'pr-0.5' : 'pr-1.5',
            )}
            aria-label={`${element.label}: show what goes with the message`}
          >
            <SquareMousePointer
              aria-hidden
              className={cn('size-3.5 shrink-0', drawing && 'animate-pulse')}
            />
            <span className="min-w-0 truncate">{element.label}</span>
            {drawing && <span className="sr-only">(taking its picture)</span>}
          </button>
        </Popover.Trigger>
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
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 w-96 max-w-[calc(100vw-16px)] rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg outline-none"
        >
          <ElementCard element={element} {...(picture ? { picture } : {})} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

export function PreviewElementChips({
  elements,
  onRemove,
  className,
}: {
  elements: PickedElement[]
  onRemove?: (index: number) => void
  className?: string
}) {
  if (!elements.length) return null
  return (
    <div className={cn('flex max-w-full flex-wrap gap-1', className)}>
      {elements.map((picked, i) => (
        <PreviewElementChip
          key={`${picked.element.page} ${picked.element.selector} ${i}`}
          {...picked}
          {...(onRemove ? { onRemove: () => onRemove(i) } : {})}
        />
      ))}
    </div>
  )
}
