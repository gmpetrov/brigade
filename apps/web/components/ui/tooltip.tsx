'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'
import { Tooltip as TooltipPrimitive } from 'radix-ui'

// Brigade: 300ms before the first tooltip shows (the browser's own `title` waited about a
// second), then none while the pointer moves on to the next control.
function TooltipProvider({
  delayDuration = 300,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({
  onFocus,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      onFocus={(e) => {
        onFocus?.(e)
        // Brigade: open on keyboard focus only. A menu or dialog closed with the mouse hands
        // focus back to its button, which would otherwise pop its tooltip up again.
        if (!focusVisible(e.currentTarget)) e.preventDefault()
      }}
      {...props}
    />
  )
}

function focusVisible(el: Element) {
  try {
    return el.matches(':focus-visible')
  } catch {
    return true
  }
}

function TooltipContent({
  className,
  sideOffset = 4,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          'z-50 w-fit max-w-xs origin-(--radix-tooltip-content-transform-origin) animate-in rounded-md border bg-popover px-2.5 py-1.5 text-xs text-balance text-popover-foreground shadow-md fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

/**
 * Shows `label` in a tooltip over its one child, in place of the browser's slow `title`.
 * The child must take a ref and pass on its props (an element, Button, Link). Without a
 * label it renders the child alone. A tooltip is not an accessible name: an icon-only
 * button still needs its `aria-label`.
 */
function Hint({
  label,
  side,
  align,
  children,
}: {
  label?: React.ReactNode
  side?: React.ComponentProps<typeof TooltipPrimitive.Content>['side']
  align?: React.ComponentProps<typeof TooltipPrimitive.Content>['align']
  children: React.ReactElement
}) {
  if (label === undefined || label === null || label === false || label === '') return children
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} align={align}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, Hint }
