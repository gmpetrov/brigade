import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Round and outlined, as the sidebar's search and new thread buttons. */
export function CloseButton({
  label,
  title,
  onClick,
  className,
}: {
  label: string
  title: string
  onClick: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      onClick={onClick}
      className={cn(
        'flex size-9 shrink-0 items-center justify-center rounded-full border bg-card text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring [&>svg]:size-4',
        className,
      )}
    >
      <X aria-hidden />
    </button>
  )
}
