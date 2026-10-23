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
