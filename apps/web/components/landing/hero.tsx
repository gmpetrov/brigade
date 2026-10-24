import Link from 'next/link'
import { BrigadeMark } from '@/components/brigade-mark'
import { Dancers } from './dancers'
import { c, SIGN_IN, SIGN_UP } from './parts'

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
        <Link href={SIGN_IN}>Sign in</Link>
        <Link className={c('btn pri')} href={SIGN_UP}>
          Sign up
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
            <Link className={c('btn pri lg')} href={SIGN_UP}>
              Sign up
            </Link>
          </div>
        </div>
      </div>
    </section>
  )
}
