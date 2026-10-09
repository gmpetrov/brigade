import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export type StatusTone = 'success' | 'warning' | 'destructive' | 'progress' | 'neutral'

const TONES: Record<string, StatusTone> = {
  active: 'success',
  ready: 'success',
  connected: 'success',
  online: 'success',
  done: 'success',
  answered: 'success',
  approved: 'success',
  paused: 'warning',
  waiting: 'warning',
  pending: 'warning',
  'signing in': 'warning',
  signing_in: 'warning',
  expired: 'destructive',
  failed: 'destructive',
  blocked: 'destructive',
  error: 'destructive',
  denied: 'destructive',
  running: 'progress',
  working: 'progress',
  starting: 'progress',
}

const TONE_CLASSES: Record<StatusTone, string> = {
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  destructive: 'bg-destructive/15 text-destructive-text',
  progress: 'bg-primary/15 text-primary dark:text-primary',
  neutral: 'bg-secondary text-muted-foreground',
}

const LABELS: Record<string, string> = { waiting: 'needs approval', signing_in: 'signing in' }

/** A status word with a dot, colored by tone. The word is always shown. */
export function StatusBadge({
  status,
  tone,
  label,
  className,
}: {
  status: string
  tone?: StatusTone
  label?: string
  className?: string
}) {
  const resolved = tone ?? TONES[status] ?? 'neutral'
  return (
    <Badge
      variant="secondary"
      className={cn('gap-1.5 font-semibold', TONE_CLASSES[resolved], className)}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {label ?? LABELS[status] ?? status}
    </Badge>
  )
}
