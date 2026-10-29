'use client'
import Link from 'next/link'
import { type ComponentProps, useEffect, useState } from 'react'
import { carried, visitSource, withSource } from '@/lib/signup-source'

/**
 * A link to /sign-up or /sign-in that carries where the visit came from (lib/signup-source.ts),
 * once the page runs: the prerendered page has the bare path. On the sign-in pages
 * (`passOn`), only what their own address carries.
 */
export function AuthLink({
  href,
  passOn,
  ...props
}: ComponentProps<typeof Link> & { href: string; passOn?: boolean }) {
  const [to, setTo] = useState(href)
  useEffect(
    () => setTo(withSource(href, passOn ? carried(location.search) : visitSource())),
    [href, passOn],
  )
  return <Link href={to} {...props} />
}
