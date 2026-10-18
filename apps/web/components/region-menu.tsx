'use client'

import type { ReactElement } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/**
 * An App with a server per data region (Mixpanel): its connect button opens the regions,
 * and the sign-in starts with the one picked. Without regions, the button is left as is.
 */
export function RegionMenu({
  regions,
  onPick,
  children,
}: {
  regions: { id: string; label: string }[] | null | undefined
  onPick: (region: string) => void
  children: ReactElement
}) {
  if (!regions?.length) return children
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Where your data is
        </DropdownMenuLabel>
        {regions.map((r) => (
          <DropdownMenuItem key={r.id} onSelect={() => onPick(r.id)}>
            {r.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
