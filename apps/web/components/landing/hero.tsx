import Link from 'next/link'
import { formatCount, type ProofNumbers, REPO, REPO_URL, rileyShare } from '@/lib/github-proof'
import { cn } from '@/lib/utils'
import { Av, Cta, Icon, MockButton, s, SIGN_IN, SIGN_UP } from './parts'

export function Header() {
  return (
    <header className={cn(s.wrap, s.top)}>
      <Link className={s.word} href="/">
        Brigade
      </Link>
      <nav aria-label="Main">
        <a className={s.hideM} href="#pricing">
          Pricing
        </a>
        <a className={s.hideM} href={REPO_URL}>
          <Icon name="github" />
          GitHub
        </a>
        <Link href={SIGN_IN}>Sign in</Link>
        <Cta href={SIGN_UP} primary>
          Start free on your Mac
        </Cta>
      </nav>
    </header>
  )
}

export function Hero() {
  return (
    <section className={s.hero} aria-labelledby="hero-title">
      <div className={s.wrap}>
        <div className={s.heroCopy}>
          <h1 id="hero-title">
            Hand off the work. Keep the <em>decisions.</em>
          </h1>
          <p className={s.sub}>
            Stop babysitting terminal tabs. Brigade runs your Claude Code and Codex teammates in the
            background, on the plan you already pay for, and puts every decision that needs you in
            one list on your phone.
          </p>
          <div className={s.ctaRow}>
            <Cta href={SIGN_UP} primary large>
              Start free on your Mac
            </Cta>
          </div>
          <p className={s.fine}>Open source (MIT) · Free on your Mac</p>
        </div>

        <div className={s.artM} aria-hidden="true">
          <div className={s.art}>
            <div className={cn(s.blk, s.slab)}>
              <span className={s.msg}>
                <Av>R</Av>Riley <span className={s.k}>· opened PR #212</span>
              </span>
              <span className={cn(s.msg, s.r)}>
                <Av sam>S</Av>Sam <span className={s.k}>· sorted 14 emails</span>
              </span>
              <span className={s.msg}>
                <Av>R</Av>Riley <span className={s.k}>· checks passed</span>
              </span>
              <span className={cn(s.msg, s.waiting)}>
                <Av sam>S</Av>Sam <span className={s.k}>· draft ready, waiting on you</span>
              </span>
            </div>
            <div className={cn(s.blk, s.bGreen)} />
            <div className={cn(s.blk, s.bOrange)} />
            <div className={cn(s.blk, s.bInk)} />
            <div className={cn(s.blk, s.bTint)} />

            <div className={s.homeCard}>
              <div className={s.hcHello}>Good morning, Ada</div>
              <div className={s.hcState}>
                <span className={cn(s.dot, s.wait)} />2 waiting on you · 3 threads running
              </div>
              <div className={s.hcH}>
                <h4>Waiting on you</h4>
                <span className={s.n}>2</span>
              </div>
              <div className={cn(s.list, s.wait)}>
                <div className={s.it}>
                  <span className={cn(s.ico, s.w)}>
                    <Icon name="mail" />
                  </span>
                  <div className={s.tx}>
                    <div className={s.tt}>Send reply to jo@northwind.io</div>
                    <div className={s.mt}>Sam · Where is my invoice? · draft ready</div>
                  </div>
                  <MockButton>Review</MockButton>
                </div>
                <div className={s.it}>
                  <span className={cn(s.ico, s.w)}>
                    <Icon name="pr" />
                  </span>
                  <div className={s.tx}>
                    <div className={s.tt}>
                      PR #212 <span className={s.k}>· Fix invoice rounding</span>
                    </div>
                    <div className={s.mt}>Ready to merge · Riley · checks passed</div>
                  </div>
                  <MockButton>Merge</MockButton>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

/** The live numbers from GitHub; a number it did not give back leaves out what needs it. */
export function Proof({ numbers }: { numbers: ProofNumbers }) {
  const { mergedPrs, rileyCommits, totalCommits } = numbers
  return (
    <section className={s.proof} aria-label="Built by its own teammates">
      <div className={cn(s.wrap, s.reveal)}>
        {mergedPrs !== null && (
          <div>
            <div className={s.num}>{formatCount(mergedPrs)}</div>
            <div className={s.numL}>pull requests merged · last 30 days</div>
          </div>
        )}
        {rileyCommits !== null && totalCommits !== null && (
          <div>
            <div className={s.num}>
              {formatCount(rileyCommits)}
              <span className={s.of}>/{formatCount(totalCommits)}</span>
            </div>
            <div className={s.numL}>commits written by Riley</div>
          </div>
        )}
        <p>
          <b>Brigade is built by its own teammates.</b>{' '}
          {mergedPrs !== null && (
            <>
              {formatCount(mergedPrs)} pull requests merged on <code>{REPO}</code> in the last 30
              days.{' '}
            </>
          )}
          {rileyCommits !== null && totalCommits !== null && (
            <>Riley, a Brigade teammate, wrote {rileyShare(rileyCommits, totalCommits)}. </>
          )}
          <a className={s.link} href={`${REPO_URL}/pulls?q=is%3Apr+is%3Amerged`}>
            See them on GitHub <Icon name="arrow" />
          </a>
        </p>
      </div>
    </section>
  )
}
