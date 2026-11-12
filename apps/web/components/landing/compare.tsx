import type { ReactNode } from 'react'
import { BrigadeMark } from '@/components/brigade-mark'
import { HarnessLogo } from '@/components/harness-logo'
import { Footer } from '@/components/landing/closing'
import { Header } from '@/components/landing/hero'
import { REPO_URL } from '@/lib/github-proof'
import type { Logo, Mark } from '@/lib/compare'
import { AuthLink } from './auth-link'
import { c, Icon, SIGN_UP } from './parts'

export const DEMO_URL = 'https://demo.brigade.lol'

/** A comparison page (app/compare) in the landing's header and footer. */
export function ComparePage({ children }: { children: ReactNode }) {
  return (
    <div className={c('page')}>
      <Header />
      <main className={c('vs')}>
        <div className={c('wrap')}>{children}</div>
      </main>
      <Footer />
    </div>
  )
}

/** A product's logo on a white tile, so its own colors read on both themes. */
export function LogoTile({ logo, size = 'md' }: { logo: Logo | 'brigade'; size?: 'sm' | 'md' }) {
  return (
    <span className={c(`vs-logo ${size}`)} aria-hidden="true">
      {logo === 'brigade' ? (
        <BrigadeMark className={c('vs-logo-img')} />
      ) : 'harness' in logo ? (
        <HarnessLogo harness={logo.harness} className={c('vs-logo-img')} />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- a small static icon
        <img src={logo.src} alt="" className={c('vs-logo-img')} />
      )}
    </span>
  )
}

/** Their logos, side by side when a page compares two products. */
export function Logos({ logos, size }: { logos: Logo[]; size?: 'sm' | 'md' }) {
  return (
    <span className={c('vs-logos')}>
      {logos.map((l, i) => (
        <LogoTile key={i} logo={l} size={size} />
      ))}
    </span>
  )
}

const MARK_LABEL: Record<Mark, string> = { yes: 'Yes', partly: 'Partly', no: 'No' }

/** A row's verdict as a small round icon, with its word for screen readers. */
export function MarkIcon({ mark }: { mark: Mark }) {
  return (
    <span className={c(`vs-mark ${mark}`)} role="img" aria-label={MARK_LABEL[mark]}>
      <Icon name={mark === 'yes' ? 'check' : mark === 'no' ? 'x' : 'minus'} />
    </span>
  )
}

/** The page's ways in: the live demo first, then sign-up and the code. */
export function CompareCta() {
  return (
    <div className={c('cta-row vs-cta')}>
      <a className={c('btn pri lg')} href={DEMO_URL}>
        Try the live demo
        <Icon name="arrow" />
      </a>
      <AuthLink className={c('btn lg')} href={SIGN_UP}>
        Sign up free
      </AuthLink>
      <a className={c('btn ghost lg')} href={REPO_URL}>
        <Icon name="github" />
        GitHub
      </a>
    </div>
  )
}

/** The closing band: one more way in, at the end of the page. */
export function CompareClose({ title }: { title: string }) {
  return (
    <section className={c('vs-close')}>
      <LogoTile logo="brigade" />
      <h2>{title}</h2>
      <p>
        Click around the real dashboard with no sign-up, or start free on your own computer. Brigade
        runs on the Claude or ChatGPT plan you already pay for.
      </p>
      <CompareCta />
    </section>
  )
}
