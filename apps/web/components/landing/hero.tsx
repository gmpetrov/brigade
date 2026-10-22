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
    <section className={c('hero')} aria-labelledby="hero-title" data-anim>
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
            <a className={c('btn lg')} href="#demo">
              Try the live demo
            </a>
          </div>
          <p className={c('fine')}>Open source · Free on your Mac</p>
        </div>

        <div className={c('hero-art')}>
          <div className={c('blk slab')} aria-hidden="true"></div>
          <div className={c('blk b-orange')} aria-hidden="true"></div>
          <div className={c('blk b-green')} aria-hidden="true"></div>
          <div className={c('blk b-ink')} aria-hidden="true"></div>

          <div
            className={c('thread')}
            role="img"
            aria-label="A Brigade thread: Ada asks for the export bug to be fixed, Riley fixes it and ships it after her approval, Sam drafts replies to the customers who asked, and a weekly routine is created."
          >
            <div className={c('th-top')}>
              <span className={c('th-pill')}>
                <span className={c('proj')}>A</span>
                <span className={c('av xs')}>R</span>Acme · Export bug
              </span>
              <span className={c('th-state')}>
                <span className={c('dot run')}></span>Riley, Sam
              </span>
            </div>
            <div className={c('th-body')}>
              <div className={c('me-who seq s0')}>Ada</div>
              <div className={c('me seq s1')}>
                A customer says the export button is broken. Fix it and tell the people who asked.
              </div>

              <div className={c('mm seq s2')}>
                <span className={c('av')}>R</span>
                <div className={c('tx')}>
                  <div className={c('who')}>Riley</div>
                  <p>On it.</p>
                  <div className={c('conn')}>
                    <span className={c('chip seq s3')}>
                      <span className={c('tile sm')}>GH</span>GitHub{' '}
                      <span className={c('ok-i')}>
                        <Icon name="check" />
                      </span>
                    </span>
                    <span className={c('chip seq s4')}>
                      <span className={c('tile sm')}>G</span>Gmail{' '}
                      <span className={c('ok-i')}>
                        <Icon name="check" />
                      </span>
                    </span>
                    <span className={c('seq s5')}>connected</span>
                  </div>
                </div>
              </div>

              <div className={c('steps-l')}>
                <div className={c('st seq s6')}>
                  → found the bug in export.ts{' '}
                  <span className={c('ok-i')}>
                    <Icon name="check" />
                  </span>
                </div>
                <div className={c('st seq s7')}>
                  → tests pass{' '}
                  <span className={c('ok-i')}>
                    <Icon name="check" />
                  </span>
                </div>
              </div>

              <div className={c('pvw seq s8')}>
                <div className={c('pvw-bar')}>
                  <i></i>
                  <i></i>
                  <i></i>
                  <span>preview · /reports</span>
                  <b>live</b>
                </div>
                <div className={c('pvw-body')}>
                  <div className={c('rows')}>
                    <span className={c('ttl')}>Reports</span>
                    <div className={c('bar')}></div>
                    <div className={c('bar')}></div>
                  </div>
                  <span className={c('pvw-exp')}>
                    Export <Icon name="check" />
                  </span>
                </div>
              </div>

              <div className={c('appr seq s9')}>
                <span className={c('av')}>R</span>
                <div className={c('tx')}>
                  <div className={c('o')}>Needs you</div>
                  <div className={c('tt')}>
                    Riley wants to ship <span className={c('k')}>· Fix export button</span>
                  </div>
                </div>
                <div className={c('act')}>
                  <span className={c('btn sm pri')}>Approve</span>
                  <span className={c('badge ok')}>approved</span>
                </div>
              </div>

              <div className={c('mm seq s10')}>
                <span className={c('av sam')}>S</span>
                <div className={c('tx')}>
                  <div className={c('who')}>Sam</div>
                  <p>3 customers asked about it. Replies drafted, waiting on you.</p>
                  <div className={c('conn')}>
                    <span className={c('badge yel')}>waiting on you</span>
                  </div>
                </div>
              </div>

              <div className={c('sys seq s11')}>
                <Icon name="refresh" />
                Created routine · <b>Weekly release notes</b>
              </div>
            </div>
            <div className={c('composer')} aria-hidden="true">
              <span className={c('ph-t')}>Reply to Riley and Sam…</span>
              <span className={c('send')}>
                <Icon name="arrowUp" />
              </span>
            </div>
          </div>
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
