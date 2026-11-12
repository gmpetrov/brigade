import type { ReactNode } from 'react'
import Link from 'next/link'
import { BrigadeMark } from '@/components/brigade-mark'
import { HarnessLogo } from '@/components/harness-logo'
import { Footer } from '@/components/landing/closing'
import { Header } from '@/components/landing/hero'
import type { Logo, Mark } from '@/lib/compare'
import { AuthLink } from './auth-link'
import { c, Icon, SIGN_UP } from './parts'

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

/** The page's one way in: sign-up. */
export function CompareCta({ label = 'Sign up free' }: { label?: string }) {
  return (
    <div className={c('cta-row vs-cta')}>
      <AuthLink className={c('btn pri lg')} href={SIGN_UP}>
        {label}
        <Icon name="arrow" />
      </AuthLink>
    </div>
  )
}

/** Above the title: the way back to every comparison, and the day the facts were checked. */
export function CompareEyebrow({ checked, back }: { checked: string; back?: boolean }) {
  return (
    <p className={c('vs-eyebrow')}>
      {back ? (
        <Link className={c('vs-chip link')} href="/compare">
          <Icon name="arrow" />
          All comparisons
        </Link>
      ) : (
        <span className={c('vs-chip')}>Comparisons</span>
      )}
      <span className={c('vs-checked')}>
        <Icon name="clock" />
        Checked {checked}
      </span>
    </p>
  )
}

/** The closing band: one more way in, at the end of the page. */
export function CompareClose({ title }: { title: string }) {
  return (
    <section className={c('vs-close')}>
      <LogoTile logo="brigade" />
      <h2>{title}</h2>
      <p>
        Start free on your own computer. Brigade runs on the Claude or ChatGPT plan you already pay
        for.
      </p>
      <CompareCta />
    </section>
  )
}
