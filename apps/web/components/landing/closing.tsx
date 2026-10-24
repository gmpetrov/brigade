import Link from 'next/link'
import type { CSSProperties } from 'react'
import { BrigadeMark } from '@/components/brigade-mark'
import { formatCount, mergeDate, type ProofNumbers, REPO, REPO_URL } from '@/lib/github-proof'
import { c, Icon, SIGN_IN, SIGN_UP } from './parts'
import { Pebble } from './pebble'
import { PebbleRain } from './pebble-rain'

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

/** Pricing, on a band in the dark theme whatever the page's theme, where pebbles fall on Start with Cloud. */
export function Pricing() {
  return (
    <section aria-labelledby="pricing-title" className={c('pricing dark')} id="pricing">
      <div className={c('wrap')}>
        <div className={c('pr-head')}>
          <h2 className={c('h2')} id="pricing-title">
            Simple Pricing
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
          <div className={c('plan cloud')} data-pebble-card>
            <div className={c('plan-n')}>
              <Icon name="cloud" />
              Cloud
            </div>
            <div className={c('price')}>
              <span className={c('amt')}>$99</span>
              <span className={c('per')}>/ month</span>
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
            <Link className={c('btn pri lg')} href={SIGN_UP} data-pebble-target>
              Start with Cloud
            </Link>
          </div>
          <PebbleRain />
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
        <h2 id="final-title">Meet your first teammate</h2>
        <p className={c('lead')}>He does the work. You make the calls.</p>
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
      {/* The name, as large as the page is wide, cut by the bottom edge. */}
      <div className={c('foot-name')} aria-hidden="true" data-anim>
        <span>Brigade</span>
      </div>
    </footer>
  )
}
