import Link from 'next/link'
import type { CSSProperties } from 'react'
import { BrigadeMark } from '@/components/brigade-mark'
import { formatCount, mergeDate, type ProofNumbers, REPO, REPO_URL } from '@/lib/github-proof'
import { MAC_APP_URL } from '@/lib/mac-app'
import { c, Icon, SIGN_IN, SIGN_UP } from './parts'
import { Pebble } from './pebble'

/** Brigade's own team as proof: the GitHub numbers read at build (lib/github-proof.ts), and
 * the last pull requests merged. A number GitHub did not give back leaves out what needs it. */
export function BuiltBy({ numbers }: { numbers: ProofNumbers }) {
  const { mergedPrs, rileyCommits, totalCommits, recentMerges } = numbers
  const commits = rileyCommits !== null && totalCommits !== null
  // "Most" only while the numbers say so.
  const share = commits && rileyCommits * 2 > totalCommits ? 'most' : 'much'
  return (
    <section className={c('sec built')} aria-labelledby="built-title">
      <div className={c('wrap')}>
        <div>
          <h2 className={c('h2')} id="built-title">
            Brigade is built by Brigade.
          </h2>
          <p className={c('lead')}>
            Our own teammates write {share} of Brigade&apos;s code, and a person approves every
            change before it goes in. The whole history is public.
          </p>
          <p className={c('mark-note')}>
            <span className={c('av mark')} aria-hidden="true">
              M
            </span>
            This page was researched by Mark, a Brigade teammate.
          </p>
          <a className={c('link')} href={REPO_URL}>
            Read the code on GitHub <Icon name="arrow" />
          </a>
        </div>
        <div>
          {(mergedPrs !== null || commits) && (
            <div className={c('nums')}>
              {mergedPrs !== null && (
                <div>
                  <div className={c('num')}>{formatCount(mergedPrs)}</div>
                  <div className={c('num-l')}>pull requests merged · last 30 days</div>
                </div>
              )}
              {commits && (
                <div>
                  <div className={c('num')}>
                    {formatCount(rileyCommits)}
                    <span className={c('of')}>/{formatCount(totalCommits)}</span>
                  </div>
                  <div className={c('num-l')}>commits by Riley</div>
                </div>
              )}
            </div>
          )}
          {recentMerges && (
            <section className={c('log')} aria-label="Latest merged pull requests">
              <div className={c('log-h')}>
                <Icon name="github" />
                <span className={c('mono')}>{REPO}</span>
                <span className={c('sp')} />
                {mergedPrs !== null && (
                  <span className={c('badge ok')}>{formatCount(mergedPrs)} merged</span>
                )}
              </div>
              {recentMerges.map((pr) => (
                <a key={pr.number} className={c('lgr')} href={pr.url}>
                  <span className={c('mg')} aria-hidden="true">
                    <Icon name="merged" />
                  </span>
                  <div>
                    <div className={c('tt')}>{pr.title}</div>
                    <div className={c('mt')}>
                      #{pr.number}
                      {pr.branch && <> · {pr.branch}</>} · merged
                    </div>
                  </div>
                  <span className={c('tm')}>
                    <time dateTime={pr.mergedAt}>{mergeDate(pr.mergedAt)}</time>
                  </span>
                </a>
              ))}
            </section>
          )}
        </div>
      </div>
    </section>
  )
}

/** Pricing, on a band in the dark theme whatever the page's theme: the night the cloud computer works through. */
export function Pricing() {
  return (
    <section aria-labelledby="pricing-title" className={c('pricing dark')} id="pricing">
      <div className={c('night')} aria-hidden="true">
        <div className={c('blk slab')}>
          <span className={c('msg')}>
            <span className={c('when')}>02:14</span>Riley{' '}
            <span className={c('k')}>· fixed the export bug</span>
          </span>
          <span className={c('msg r')}>
            <span className={c('when')}>03:40</span>Sam{' '}
            <span className={c('k')}>· drafted 9 replies</span>
          </span>
          <span className={c('msg')}>
            <span className={c('when')}>07:00</span>Sam{' '}
            <span className={c('k')}>· inbox triaged</span>
          </span>
        </div>
        <div className={c('moon')}></div>
        <div className={c('blk b-green')}></div>
      </div>
      <div className={c('wrap')}>
        <div className={c('pr-head')}>
          <h2 className={c('h2')} id="pricing-title">
            Free on your Mac. Pay only for the cloud computer.
          </h2>
        </div>
        <div className={c('plans')}>
          <div className={c('plan')}>
            <div className={c('plan-n')}>
              <Icon name="laptop" />
              Free
            </div>
            <div className={c('price')}>
              <span className={c('amt')}>$0</span>
            </div>
            <ul className={c('feat')}>
              <li>
                <Icon name="check" />
                Teammates run on your Mac while it&apos;s awake
              </li>
              <li>
                <Icon name="check" />
                Your Claude or ChatGPT plan
              </li>
              <li>
                <Icon name="check" />
                Unlimited teammates, threads and members
              </li>
            </ul>
            <Link className={c('btn lg')} href={SIGN_UP}>
              Sign up
            </Link>
          </div>
          <div className={c('plan cloud')}>
            <div className={c('plan-n')}>
              <Icon name="cloud" />
              Cloud
            </div>
            <div className={c('price')}>
              <span className={c('amt')}>$99</span>
              <span className={c('per')}>/ month per workspace</span>
            </div>
            <ul className={c('feat')}>
              <li>
                <Icon name="check" />
                Teammates keep working when your Mac is asleep, closed or you don&apos;t have one
              </li>
              <li>
                <Icon name="check" />
                Your Claude or ChatGPT plan
              </li>
              <li>
                <Icon name="check" />
                Everything in Free, plus Brigade&apos;s cloud computer
              </li>
            </ul>
            <Link className={c('btn pri lg')} href={SIGN_UP}>
              Start with Cloud
            </Link>
            <p className={c('quiet')}>Runs up to 4 threads at once</p>
          </div>
        </div>
      </div>
    </section>
  )
}

export function Download() {
  return (
    <section aria-labelledby="download-title" className={c('sec download')} id="download">
      <div className={c('wrap')}>
        <div className={c('sec-head')}>
          <h2 className={c('h2')} id="download-title">
            One team, on your desk and in your pocket.
          </h2>
          <p className={c('lead')}>
            Install Brigade.app and sign in with the Claude or ChatGPT account you already use. Then
            follow your teammates from any browser or your iPhone.
          </p>
        </div>
        <div className={c('dl-grid')}>
          <div className={c('dl')}>
            <div className={c('dl-art tint')} aria-hidden="true">
              <div className={c('mb')}>
                <div className={c('mb-bar')}>
                  <span>Mon 9:41</span>
                  <span className={c('bb')}></span>
                </div>
                <div className={c('mb-menu')}>
                  <div className={c('r')}>
                    <span className={c('dot ok')}></span>Runner online
                  </div>
                  <div className={c('r')}>
                    <span className={c('dot run')}></span>3 threads running
                  </div>
                  <div className={c('r m')}>Set up Brigade…</div>
                </div>
              </div>
            </div>
            <div className={c('dl-body')}>
              <h3>Brigade.app for Mac</h3>
              <p>
                Lives in your menu bar. It checks each setup step and fixes what&apos;s missing.
              </p>
              <a className={c('btn pri')} href={MAC_APP_URL}>
                <Icon name="download" />
                Download for Mac
              </a>
            </div>
          </div>
          <div className={c('dl')}>
            <div className={c('dl-art green')} aria-hidden="true">
              <div className={c('brw2')}>
                <div className={c('brw-bar')}>
                  <span>www.brigade.lol</span>
                </div>
                <div className={c('brw2-b')}>
                  <div className={c('sb')}>
                    <i className={c('y')}></i>
                    <i></i>
                    <i></i>
                    <i></i>
                  </div>
                  <div className={c('mn')}>
                    <div className={c('h')}></div>
                    <div className={c('w')}></div>
                    <div className={c('g')}></div>
                    <div className={c('g')} style={{ width: '70%' } as CSSProperties}></div>
                  </div>
                </div>
              </div>
            </div>
            <div className={c('dl-body')}>
              <h3>On the web</h3>
              <p>Every thread and every decision, from any browser.</p>
              <Link className={c('btn')} href={SIGN_IN}>
                Open Brigade
              </Link>
            </div>
          </div>
          <div className={c('dl')}>
            <div className={c('dl-art orange')} aria-hidden="true">
              <div className={c('iph')}>
                <div className={c('sc')}>
                  <div className={c('ic')}>
                    <i></i>
                    <i></i>
                    <i className={c('b')}></i>
                    <i></i>
                    <i></i>
                    <i></i>
                    <i></i>
                    <i></i>
                  </div>
                  <div className={c('lbl')}>Brigade on your Home Screen</div>
                </div>
              </div>
            </div>
            <div className={c('dl-body')}>
              <h3>On your iPhone</h3>
              <p>
                Open Brigade in Safari and add it to your Home Screen. Its badge counts what needs
                you.
              </p>
              <p className={c('dl-hint')}>
                <Icon name="share" />
                Add to Home Screen from Safari
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

export function Faq() {
  return (
    <section aria-labelledby="faq-title" className={c('sec faq')}>
      <div className={c('wrap')}>
        <div className={c('side')}>
          <h2 className={c('h2')} id="faq-title">
            Questions
          </h2>
          <p>
            More on how it runs:{' '}
            <Link className={c('link')} href="/how-it-works">
              How Brigade works
            </Link>
          </p>
        </div>
        <div className={c('qs')}>
          <details open>
            <summary>
              Do I need to know how to code?
              <span className={c('pm')}>
                <Icon name="plus" />
              </span>
            </summary>
            <p>
              No. You describe a job in a message, the way you would to a new hire. For a task in an
              app, show it once with Teach a task.
            </p>
          </details>
          <details>
            <summary>
              Can a teammate send an email or pay without me?
              <span className={c('pm')}>
                <Icon name="plus" />
              </span>
            </summary>
            <p>
              Yes, unless you tell it to wait. For each teammate you choose what it does on its own
              and what waits for your yes in Needs you. Ready-made playbooks, like the support one,
              ask before they send.
            </p>
          </details>
          <details>
            <summary>
              What happens when my Mac goes to sleep?
              <span className={c('pm')}>
                <Icon name="plus" />
              </span>
            </summary>
            <p>
              Teammates on your Mac stop until it wakes up, and a routine due in the meantime is
              skipped: you get a ticket saying so. With Cloud, they keep working on Brigade&apos;s
              computer and routines run on time.
            </p>
          </details>
          <details>
            <summary>
              I don&apos;t have a Mac.
              <span className={c('pm')}>
                <Icon name="plus" />
              </span>
            </summary>
            <p>
              Start with Cloud. Your teammates run on Brigade&apos;s cloud computer and you use
              Brigade from any browser or your phone.
            </p>
          </details>
          <details>
            <summary>
              Which AI plans work?
              <span className={c('pm')}>
                <Icon name="plus" />
              </span>
            </summary>
            <p>
              Claude and ChatGPT plans, through Claude Code and Codex. Max or Pro gives the most
              room. You can stack several accounts: when one runs out, the teammate continues on the
              next account of the same provider.
            </p>
          </details>
          <details>
            <summary>
              Where do my passwords go?
              <span className={c('pm')}>
                <Icon name="plus" />
              </span>
            </summary>
            <p>
              In your workspace&apos;s vault. For a website, Brigade types the login for the
              teammate, which never sees the password.
            </p>
          </details>
          <details>
            <summary>
              Is it open source?
              <span className={c('pm')}>
                <Icon name="plus" />
              </span>
            </summary>
            <p>
              Yes, the whole product is on GitHub under the MIT license, including the web app, the
              server and the Mac app.
            </p>
          </details>
        </div>
      </div>
    </section>
  )
}

export function FinalCall() {
  return (
    <section aria-labelledby="final-title" className={c('final')} data-anim>
      <Pebble />
      <div className={c('wrap')}>
        <h2 id="final-title">Meet your first teammate.</h2>
        <p className={c('lead')}>
          Start on your Mac today. Move to the cloud when you want them working through the night.
        </p>
        <Link className={c('btn pri lg')} href={SIGN_UP}>
          Sign up
        </Link>
      </div>
    </section>
  )
}

export function Footer() {
  return (
    <footer className={c('foot')}>
      <div className={c('wrap')}>
        <span className={c('word')}>
          <BrigadeMark className={c('word-mark')} />
          Brigade
        </span>
        <nav aria-label="Footer">
          <a href="/#pricing">Pricing</a>
          <Link href="/how-it-works">How it works</Link>
          <a href={REPO_URL}>GitHub</a>
          <Link href={SIGN_IN}>Sign in</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
          <span>MIT license</span>
          <span>© 2026</span>
        </nav>
      </div>
    </footer>
  )
}
