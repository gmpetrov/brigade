import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

/** A teammate's title ("Software engineer"), as a badge beside its name; nothing without one. */
export function TeammateTitle({ title, className }: { title?: string; className?: string }) {
  if (!title) return null
  return (
    <Badge
      variant="secondary"
      title={title}
      className={cn(
        'max-w-40 min-w-0 shrink truncate font-medium text-muted-foreground',
        className,
      )}
    >
      <span className="truncate">{title}</span>
    </Badge>
  )
}
