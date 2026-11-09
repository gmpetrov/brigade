import { cn } from '@/lib/utils'

/**
 * A small spinner in Apple's style: eight rounded spokes that fade as they turn, in the colour
 * of the text around it (globals.css, `.activity-indicator`). 16 px, the size of an icon.
 */
export function ActivityIndicator({
  className,
  label = 'Loading',
}: {
  className?: string
  /** What it waits for, for screen readers. */
  label?: string
}) {
  return (
    <span role="status" aria-label={label} className={cn('activity-indicator', className)}>
      {Array.from({ length: 8 }, (_, i) => (
        <span
          key={i}
          style={
            {
              '--spoke': i,
              transform: `rotate(${i * 45}deg)`,
              animationDelay: `${(i - 8) * 0.1}s`,
            } as React.CSSProperties
          }
        />
      ))}
    </span>
  )
}
