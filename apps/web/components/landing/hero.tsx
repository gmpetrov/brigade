import Link from 'next/link'
import { BrigadeMark } from '@/components/brigade-mark'
import { REPO_URL } from '@/lib/github-proof'
import { AuthLink } from './auth-link'
import { Dancers } from './dancers'
import { DownloadButton } from './download-button'
import { c, Icon, SIGN_IN } from './parts'
import { SiteAnalytics } from './site-analytics'

/** The plans, from any page. */
const CLOUD = '/pricing'

export function Header() {
  return (
    <header className={c('wrap top')}>
      <SiteAnalytics />
      <Link className={c('word')} href="/">
        <BrigadeMark className={c('word-mark')} />
        Brigade
      </Link>
      <nav aria-label="Main">
        <Link className={c('hide-m')} href="/pricing">
          Pricing
        </Link>
        <AuthLink href={SIGN_IN}>Sign in</AuthLink>
        {/* 24/7 is Brigade Cloud's promise (free teammates stop when the computer sleeps), so
            it leads to the Cloud plan, never to a plain sign-up. */}
        <a className={c('btn pri')} href={CLOUD}>
          <span>
            <span className={c('hide-m')}>Get your </span>24/7 AI team
          </span>
        </a>
        {/* No star count while it's small; on phones the icon alone keeps the bar on one line. */}
        <a className={c('btn')} href={REPO_URL} aria-label="Star Brigade on GitHub">
          <Icon name="github" />
          <span className={c('hide-m')}>Star</span>
        </a>
      </nav>
    </header>
  )
}

export function Hero() {
  return (
    <section className={c('hero')} aria-labelledby="hero-title">
      <div className={c('wrap')}>
        <div className={c('hero-copy')}>
          <h1 id="hero-title">
            <em className={c('dance-word')}>
              AI teammates
              <Dancers />
            </em>{' '}
            that run your whole company
          </h1>
          <p className={c('sub')}>
            They write your code, answer your customers, handle your marketing and chase your leads,
            on the Claude or ChatGPT plan you already pay for. Every decision that needs you lands
            in one list on your phone.
          </p>
          <div className={c('cta-row')}>
            <DownloadButton />
            <a className={c('btn pri lg')} href={CLOUD}>
              Get your 24/7 AI team
            </a>
          </div>
          <p className={c('fine-m')}>Free desktop app for Mac, Windows and Linux.</p>
        </div>
      </div>
    </section>
  )
}
