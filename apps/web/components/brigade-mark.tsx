import { useId } from 'react'
import { cn } from '@/lib/utils'

/** Brigade's logo: the violet pebble with happy eyes, drawn like the teammates'
 * avatars. The same drawing as app/icon.svg. Size it with the className (`size-14`). */
export function BrigadeMark({ className }: { className?: string }) {
  const gradient = useId()
  return (
    <svg viewBox="0 0 100 100" aria-hidden className={cn('size-8 shrink-0', className)}>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a58af9" />
          <stop offset=".55" stopColor="#855ef6" />
          <stop offset="1" stopColor="#6c43e6" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${gradient})`}
        d="M56 0A44 56 0 0 1 100 56A40 44 0 0 1 60 100A60 54 0 0 1 0 46A56 46 0 0 1 56 0Z"
      />
      <g fill="none" stroke="#190d2b" strokeWidth="6" strokeLinecap="round">
        <path d="M34.5 44Q40.5 28 46.5 44" />
        <path d="M53.5 44Q59.5 28 65.5 44" />
      </g>
    </svg>
  )
}
