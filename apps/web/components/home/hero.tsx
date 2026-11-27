'use client'

import Link from 'next/link'
import type { CSSProperties } from 'react'
import { BrigadeMark } from '@/components/brigade-mark'
import { HarnessLogo } from '@/components/harness-logo'
import { AuthLink } from '@/components/landing/auth-link'
import { DownloadButton } from '@/components/landing/download-button'
import { Dancers } from '@/components/landing/dancers'
import { c, Icon } from '@/components/landing/parts'
import { SiteAnalytics } from '@/components/landing/site-analytics'
import { REPO_URL } from '@/lib/github-proof'
import { h } from './parts'

/** The plans: 24/7 is Brigade Cloud's promise, so it leads there, never to a plain sign-up. */
const CLOUD = '/pricing'

/** The bar on top, scrolling away with the page. */
export function Header() {
  return (
    <header className={h('top')}>
      <SiteAnalytics />
      <div className={h('wrap top-in')}>
        <Link className={h('word')} href="/">
          <BrigadeMark className={h('word-mark')} />
          Brigade
        </Link>
        <nav aria-label="Main" className={h('nav')}>
          <Link className={h('nav-l hide-s')} href="/pricing">
            Pricing
          </Link>
          <a className={h('nav-l hide-s')} href="/docs">
            Docs
          </a>
          <a className={h('nav-l')} href={REPO_URL}>
            GitHub
          </a>
          <AuthLink className={h('nav-l')} href="/sign-in">
            Sign in
          </AuthLink>
          <a className={h('btn pri')} href={CLOUD}>
            {/* One run of text, so the button's gap doesn't land inside it. */}
            <span>
              <span className={h('hide-s')}>Get your </span>24/7 AI team
            </span>
          </a>
        </nav>
      </div>
    </header>
  )
}

export function Hero() {
  return (
    <section className={h('hero')} aria-labelledby="hero-title">
      <div className={h('wrap hero-in')}>
        <h1 id="hero-title" className={h('hero-title')}>
          <span className={h('hl')} style={{ animationDelay: '0ms' }}>
            {/* Pebbles fall onto the words as the page opens, and dance on them. */}
            <span className={c('dance-word')}>
              <Dancers word="AI teammates" />
            </span>{' '}
            that
          </span>{' '}
          <span className={h('hl')} style={{ animationDelay: '90ms' }}>
            run your whole company.
          </span>
        </h1>
        <p className={h('hero-sub')} style={{ animationDelay: '180ms' }}>
          {/* One sentence a line. */}
          <span className={h('sub-l')}>
            They code, support, market and sell, on the{' '}
            <span className={h('chip')}>
              <HarnessLogo harness="claude_code" className={h('chip-i')} />
              Claude
            </span>{' '}
            or{' '}
            <span className={h('chip')}>
              <HarnessLogo harness="codex" className={h('chip-i')} />
              ChatGPT
            </span>{' '}
            plan you already pay for.
          </span>{' '}
          <span className={h('sub-l')}>Every decision that needs you lands in one list.</span>
        </p>
        <HeroActions style={{ animationDelay: '260ms' }} />
      </div>
    </section>
  )
}

/**
 * The page's two calls to action: the download, and a star on GitHub whose star shows on
 * hover. In the hero, and again in the closing call (landing/closing.tsx), where `menuUp`
 * opens the download menu upward so the section's edge does not cut it off. On a phone there
 * is nothing to download: the sign-up takes the download's place. Without it, a phone's
 * download led to the releases on GitHub, and both buttons left the site.
 */
export function HeroActions({
  className,
  style,
  menuUp = false,
}: {
  className?: string
  style?: CSSProperties
  menuUp?: boolean
}) {
  return (
    <div className={className ? `${h('hero-cta')} ${className}` : h('hero-cta')} style={style}>
      <div className={h('hide-s')}>
        <DownloadButton menuUp={menuUp} />
      </div>
      <AuthLink className={h('btn pri lg show-s')} href="/sign-up">
        Get started free
      </AuthLink>
      <a className={h('btn grey lg star')} href={REPO_URL}>
        <Icon name="star" />
        <span>Star on GitHub</span>
      </a>
    </div>
  )
}
