import Link from 'next/link'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import s from './landing.module.css'

export { s }

// Lucide's paths, drawn at 24×24 with the landing's own stroke (.i).
const paths = {
  github: (
    <>
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </>
  ),
  mail: (
    <>
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </>
  ),
  pr: (
    <>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <path d="M6 9v12" />
    </>
  ),
  merged: (
    <>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M6 21V9a9 9 0 0 0 9 9" />
    </>
  ),
  arrow: (
    <>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </>
  ),
  terminal: (
    <>
      <path d="m4 17 6-6-6-6" />
      <path d="M12 19h8" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  alert: (
    <>
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </>
  ),
  lock: (
    <>
      <rect width="18" height="11" x="3" y="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </>
  ),
  list: <path d="M3 12h.01M3 18h.01M3 6h.01M8 12h13M8 18h13M8 6h13" />,
  octagon: (
    <path d="M2.586 16.726A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2h6.624a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586z" />
  ),
  key: (
    <>
      <path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4" />
      <path d="m21 2-9.6 9.6" />
      <circle cx="7.5" cy="15.5" r="5.5" />
    </>
  ),
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  stop: <rect x="5" y="5" width="14" height="14" rx="2" />,
  laptop: (
    <path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16" />
  ),
  cloud: <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />,
  swap: (
    <>
      <path d="M8 3 4 7l4 4" />
      <path d="M4 7h16" />
      <path d="m16 21 4-4-4-4" />
      <path d="M20 17H4" />
    </>
  ),
  plus: <path d="M5 12h14M12 5v14" />,
}

export function Icon({ name }: { name: keyof typeof paths }) {
  return (
    <svg className={s.i} viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  )
}

/** A teammate's initial in a round avatar; Sam's is orange, the others violet. */
export function Av({ children, sam }: { children: ReactNode; sam?: boolean }) {
  return <span className={cn(s.av, sam && s.sam)}>{children}</span>
}

export function Tile({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn(s.tile, className)}>{children}</span>
}

export function Badge({ tone, children }: { tone?: 'ok' | 'wait' | 'run'; children: ReactNode }) {
  return <span className={cn(s.badge, tone && s[tone])}>{children}</span>
}

/** A button drawn inside an illustration: the product's Button, but nothing to press. */
export function MockButton({
  children,
  tone,
  size = 'sm',
}: {
  children: ReactNode
  tone?: 'pri' | 'ghost'
  size?: 'sm' | 'md'
}) {
  return (
    <Button
      asChild
      variant={tone === 'pri' ? 'default' : tone === 'ghost' ? 'ghost' : 'outline'}
      className={cn(s.btn, size === 'sm' && s.sm, tone && s[tone])}
    >
      <span>{children}</span>
    </Button>
  )
}

/** A call to action: the product's Button as a link, in the landing's pill shape. */
export function Cta({
  href,
  children,
  primary,
  large,
  className,
}: {
  href: string
  children: ReactNode
  primary?: boolean
  large?: boolean
  className?: string
}) {
  return (
    <Button
      asChild
      variant={primary ? 'default' : 'outline'}
      className={cn(s.btn, primary && s.pri, large && s.lg, className)}
    >
      <Link href={href}>{children}</Link>
    </Button>
  )
}

export const SIGN_UP = '/sign-up'
export const SIGN_IN = '/sign-in'
