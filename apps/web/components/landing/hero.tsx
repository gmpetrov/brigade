import Link from 'next/link'
import { BrigadeMark } from '@/components/brigade-mark'
import { REPO_URL } from '@/lib/github-proof'
import { c, Icon, SIGN_IN, SIGN_UP } from './parts'

export function Header() {
  return (
    <header className={c('wrap top')}>
      <Link className={c('word')} href="/">
        <BrigadeMark className={c('word-mark')} />
        Brigade
      </Link>
      <nav aria-label="Main">
        <a className={c('hide-m')} href="/#pricing">
          Pricing
        </a>
        <a className={c('hide-m')} href="/#download">
          Download
        </a>
        <a className={c('hide-m')} href={REPO_URL}>
          <Icon name="github" />
          GitHub
        </a>
        <Link href={SIGN_IN}>Sign in</Link>
        <Link className={c('btn pri')} href={SIGN_UP}>
          Start free on your Mac
        </Link>
      </nav>
    </header>
  )
}

export function Hero() {
  return (
    <section className={c('hero')} aria-labelledby="hero-title">
      <div className={c('wrap')}>
        <div className={c('hero-copy')}>
          <p className={c('eyebrow')}>The operating system for AI-native companies</p>
          <h1 id="hero-title">
            <em>One team</em> builds it, sells it and supports it.
          </h1>
          <p className={c('sub')}>
            AI teammates write your code, answer your customers, run your marketing and chase your
            leads, all in one place. They run on the Claude or ChatGPT plan you already pay for, and
            every decision that needs you lands in one list on your phone.
          </p>
          <div className={c('cta-row')}>
            <Link className={c('btn pri lg')} href={SIGN_UP}>
              Start free on your Mac
            </Link>
          </div>
          <p className={c('fine')}>Open source · Free on your Mac</p>
        </div>
      </div>
    </section>
  )
}

/** The AI plan band under the hero. */
export function PlanBand() {
  return (
    <section className={c('plan-band')} aria-label="Runs on the AI plan you already pay for">
      <div className={c('wrap')}>
        <p className={c('pb-t')}>Runs on the AI plan you already pay for</p>
        <div className={c('marks')}>
          <span className={c('mark-l')}>
            <svg viewBox="0 0 32 32" aria-hidden="true">
              <g stroke="oklch(0.64 0.15 42)" strokeWidth="3.2" strokeLinecap="round">
                <path d="M16 4v24" />
                <path d="M4 16h24" />
                <path d="m7.5 7.5 17 17" />
                <path d="m24.5 7.5-17 17" />
              </g>
            </svg>
            Claude
          </span>
          <span className={c('mark-l')}>
            <svg viewBox="0 0 32 32" aria-hidden="true">
              <g fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinejoin="round">
                <path d="M16 3.5 26.8 9.75v12.5L16 28.5 5.2 22.25V9.75z" />
                <path d="M16 10.2 21 13.1v5.8L16 21.8l-5-2.9v-5.8z" />
              </g>
            </svg>
            ChatGPT
          </span>
        </div>
        <div className={c('pb-s')}>
          <span className={c('pill')}>
            <Icon name="laptop" />
            Free on your Mac
          </span>
          <span className={c('pill')}>
            <Icon name="code" />
            Open source
          </span>
        </div>
      </div>
    </section>
  )
}
