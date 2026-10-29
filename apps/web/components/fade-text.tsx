'use client'
// A line of text that fades out at its end when it does not fit, rather than being cut by an
// ellipsis, as thread titles in the sidebar do. Only when it overflows: a short title keeps
// its last letters, and a caret after it stays right after it.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function FadeText({
  children,
  className,
  textClassName,
}: {
  children: ReactNode
  /** On the box that clips it (its size in a flex row). */
  className?: string
  /** On the text itself (the band over a working thread's title). */
  textClassName?: string
}) {
  const box = useRef<HTMLSpanElement>(null)
  const text = useRef<HTMLSpanElement>(null)
  const [overflows, setOverflows] = useState(false)
  useLayoutEffect(() => {
    const outer = box.current
    const inner = text.current
    if (!outer || !inner) return
    const check = () => setOverflows(inner.offsetWidth > outer.clientWidth + 1)
    // Either may change: the sidebar's width, or the title as it streams in.
    const observer = new ResizeObserver(check)
    observer.observe(outer)
    observer.observe(inner)
    check()
    return () => observer.disconnect()
  }, [])
  return (
    <span
      ref={box}
      className={cn(
        'min-w-0 overflow-hidden whitespace-nowrap',
        overflows && '[mask-image:linear-gradient(90deg,#000_calc(100%-2rem),transparent)]',
        className,
      )}
    >
      <span ref={text} className={cn('inline-block', textClassName)}>
        {children}
      </span>
    </span>
  )
}
