'use client'
import { usePathname } from 'next/navigation'
import { useEffect } from 'react'
import { DEMO } from '@/lib/demo/flag'
import { isPublicPage } from '@/lib/public-pages'
import { visitSource } from '@/lib/signup-source'

// The site's own analytics (docs/analytics.md): pages seen and calls to action clicked, on
// www.brigade.lol's public pages only, never the dashboard nor the sign-in pages. PostHog
// without cookies or storage (cookieless_mode), so no banner; no session replay, no
// autocapture. Nothing loads without NEXT_PUBLIC_POSTHOG_KEY, nor in the demo's build.
const KEY = DEMO ? undefined : process.env.NEXT_PUBLIC_POSTHOG_KEY
const HOST = 'https://eu.i.posthog.com'

type Capture = (event: string, properties: Record<string, string>) => void

/** What a link leads to, for cta_clicked, or nothing for a link that is no call to action. */
export function ctaTarget(href: string) {
  let url: URL
  try {
    url = new URL(href, 'https://www.brigade.lol')
  } catch {
    return undefined
  }
  if (url.hostname === 'github.com') return 'github'
  if (url.hostname.startsWith('demo.')) return 'demo'
  if (/\/(install|download)/.test(url.pathname) || url.hostname.startsWith('install.'))
    return 'install'
  if (url.pathname === '/sign-up') return 'sign_up'
  if (url.pathname === '/sign-in') return 'sign_in'
  return undefined
}

/** Where on the page a link is: header, footer, or the section's name (hero, pricing…). */
function ctaLocation(link: Element) {
  if (link.closest('header')) return 'header'
  if (link.closest('footer')) return 'footer'
  let section = link.closest('section')
  while (section?.parentElement?.closest('section'))
    section = section.parentElement.closest('section')
  const name = (section?.getAttribute('aria-labelledby') ?? section?.id ?? '').replace(
    /-title$/,
    '',
  )
  return /^[a-z0-9-]{1,30}$/.test(name) ? name : 'page'
}

let loading: Promise<Capture> | undefined

/** posthog-js, loaded and started once per page load, apart from the page's own code. */
function load(key: string) {
  loading ??= import('posthog-js').then(({ default: posthog }) => {
    posthog.init(key, {
      api_host: HOST,
      cookieless_mode: 'always',
      persistence: 'memory',
      disable_session_recording: true,
      autocapture: false,
      // Sent by SiteAnalytics itself, for the public pages it is mounted on only.
      capture_pageview: false,
      capture_pageleave: false,
      capture_dead_clicks: false,
      capture_heatmaps: false,
      capture_exceptions: false,
      capture_performance: false,
      rageclick: false,
      disable_surveys: true,
      disable_product_tours: true,
      disable_conversations: true,
      disable_web_experiments: true,
      disable_external_dependency_loading: true,
      advanced_disable_flags: true,
      mask_personal_data_properties: true,
      person_profiles: 'identified_only',
      // Once loaded, posthog-js outlives the header: a client-side navigation to /sign-in or
      // /app keeps it, so anything it would send from there is dropped.
      before_send: (event) => (isPublicPage(location.pathname) ? event : null),
    })
    // At once, with the browser's beacon: the click may leave the page.
    return (event, properties) =>
      void posthog.capture(event, properties, { send_instantly: true, transport: 'sendBeacon' })
  })
  return loading
}

/** Mounted in the site's header: pages seen and calls to action clicked. */
export function SiteAnalytics() {
  const pathname = usePathname()
  useEffect(() => {
    if (KEY && isPublicPage(pathname))
      // posthog-js fills in the address itself, masked (mask_personal_data_properties): click
      // ids such as gclid never leave the browser.
      void load(KEY).then((capture) => capture('$pageview', {}))
  }, [pathname])
  useEffect(() => {
    // Where this visit came from, read before any of the site's pages changes the address.
    visitSource()
    if (!KEY) return
    const ready = load(KEY)
    function clicked(event: MouseEvent) {
      const link = (event.target as Element | null)?.closest?.('a[href]')
      const target = link && ctaTarget(link.getAttribute('href') ?? '')
      if (link && target && isPublicPage(location.pathname))
        void ready.then((capture) =>
          capture('cta_clicked', { location: ctaLocation(link), target }),
        )
    }
    document.addEventListener('click', clicked, { capture: true })
    return () => document.removeEventListener('click', clicked, { capture: true })
  }, [])
  return null
}
