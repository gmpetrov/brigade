import Link from 'next/link'
import type { CSSProperties } from 'react'
import { BrigadeMark } from '@/components/brigade-mark'
import { formatCount, mergeDate, type ProofNumbers, REPO, REPO_URL } from '@/lib/github-proof'
import { AuthLink } from './auth-link'
import { FEATURED_ON } from './featured-on'
import { c, Icon, SIGN_IN, SIGN_UP } from './parts'
import { Pebble } from './pebble'
import { OPERATOR } from './operator'
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
            Our own teammates write {share} of Brigade&apos;s code, and a person makes the calls
            that matter. The whole history is public.
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

/**
 * The cards at the top of /pricing, as Settings › Billing offers them
 * (components/settings/billing.tsx): Free and Starter, Max in the comparison below them.
 */
const PLANS: {
  name: string
  icon: 'laptop' | 'clock'
  amount: string
  who: string
  features: string[]
  cta: string
}[] = [
  {
    name: 'Free',
    icon: 'laptop',
    amount: '$0',
    who: 'For trying it on your own computer',
    features: [
      'Unlimited teammates, threads and members',
      'Your own Claude or ChatGPT plan',
      'GitHub, Notion, Linear, Stripe and many more Apps',
      'Teammates work while your computer is on',
    ],
    cta: 'Sign up',
  },
  {
    name: 'Starter',
    icon: 'clock',
    amount: '$15',
    who: 'Always-on teammates at the lowest price',
    features: [
      'Everything in Free',
      'A cloud computer for 100 hours a month',
      'Teammates keep working with your laptop closed',
      'Schedules and triggers run on time, even at 3 a.m.',
      'An email address for each teammate',
    ],
    cta: 'Get Starter',
  },
]

/**
 * The top of /pricing, on a band in the dark theme whatever the page's theme, its title the
 * page's heading: Free and Starter, pebbles falling on Starter's button.
 */
export function Pricing() {
  const featured = 'Starter'
  return (
    <section
      aria-labelledby="pricing-title"
      className={c('pricing dark pricing-page')}
      id="pricing"
    >
      <div className={c('wrap')}>
        <div className={c('pr-head centered')}>
          <h1 className={c('h2')} id="pricing-title">
            Pricing
          </h1>
        </div>
        <div className={c('plans two')}>
          {PLANS.map((plan) => (
            <div
              key={plan.name}
              className={c(plan.name === featured ? 'plan cloud' : 'plan')}
              {...(plan.name === featured ? { 'data-pebble-card': true } : {})}
            >
              <div className={c('plan-n')}>
                <Icon name={plan.icon} />
                {plan.name}
              </div>
              <div className={c('price')}>
                <span className={c('amt')}>{plan.amount}</span>
                {plan.amount !== '$0' && <span className={c('per')}>/ month</span>}
              </div>
              <p className={c('who')}>{plan.who}</p>
              <ul className={c('feat')}>
                {plan.features.map((feature) => (
                  <li key={feature}>
                    <Icon name="check" />
                    {feature}
                  </li>
                ))}
              </ul>
              <AuthLink
                className={c(plan.name === featured ? 'btn pri lg' : 'btn lg')}
                href={SIGN_UP}
                {...(plan.name === featured ? { 'data-pebble-target': true } : {})}
              >
                {plan.cta}
              </AuthLink>
            </div>
          ))}
          <PebbleRain />
        </div>
        <p className={c('pr-note')}>
          Teammates run on your own Claude or ChatGPT plan: we never bill you for AI usage. Switch
          or cancel anytime.
        </p>
      </div>
    </section>
  )
}

/** The landing's questions: shown in Faq, and given to search engines as an FAQPage (app/page.tsx). */
export const FAQ: { q: string; a: string }[] = [
  {
    q: 'Do I need to know how to code?',
    a: "No. You describe a job in a message, the way you would to a new hire. For a task in a website or an app, take over a teammate's cloud computer and show it once.",
  },
  {
    q: 'What does Brigade cost?',
    a: 'Brigade is free when teammates run on your own computer. To keep them working when yours is off, give them a cloud computer: Starter is $15 a month for 100 hours, and Max is $99 a month with no hour limit. On top of that, you bring the Claude or ChatGPT plan you already pay for: we never bill you for AI usage.',
  },
  {
    q: 'Which AI plans work?',
    a: 'Claude plans through Claude Code, and ChatGPT plans through Codex. Max or Pro gives the most room. Pick a model per teammate, and stack several accounts: when one hits its limit, the teammate carries on with the next account of the same provider, in the middle of the task.',
  },
  {
    q: 'How do I stay in control?',
    a: 'For each teammate, you choose what it does on its own and what waits for your yes in Needs you, which Apps it can reach, and daily caps on its threads, computer hours and writes to each App. Every step it takes is in its thread, for you to read.',
  },
  {
    q: 'Why several teammates rather than one agent?',
    a: 'One agent with every tool and no owner gets vague fast. Each teammate holds one job, with its own Apps, memory and rules, so you see who did what and fix the one that is off.',
  },
  {
    q: 'Where do my passwords go?',
    a: "In your workspace's vault. When a teammate signs in to a website, Brigade types the login for it: the teammate never sees the password, and it never ends up in a thread.",
  },
  {
    q: 'Is my data used to train AI models?',
    a: 'Not by us. The work runs on the AI plan you bring, so your data goes only to the provider you picked, under the terms of your plan.',
  },
  {
    q: 'Can a teammate have its own email address?',
    a: 'Yes, with Starter or Max. Turn on the Email App and each teammate gets an address of its own. It sends from it, and replies come back to the teammate that started the conversation, not to your inbox.',
  },
  {
    q: 'Can my team see the work?',
    a: "Yes. Invite them to your workspace: threads, tasks and files are shared, so nothing sits in one person's chat history.",
  },
  {
    q: 'Is it open source?',
    a: 'Yes. The whole product is on GitHub under the MIT license, so you can read every line and run it yourself.',
  },
  {
    q: 'What if I cancel?',
    a: 'Cancel from Settings whenever you want: Cloud stops at the end of the month you paid for. Your workspace stays, and your teammates can keep working for free on your own computer.',
  },
]

/** Questions with their answers, the first open: the landing's FAQ by default. */
export function Faq({
  items = FAQ,
  title = 'Questions, answered',
}: {
  items?: { q: string; a: string }[]
  title?: string
}) {
  return (
    <section aria-labelledby="faq-title" className={c('sec faq')}>
      <div className={c('wrap')}>
        <div className={c('side')}>
          <h2 className={c('h2')} id="faq-title">
            {title}
          </h2>
        </div>
        <div className={c('qs')}>
          {items.map(({ q, a }, i) => (
            <details key={q} open={i === 0}>
              <summary>
                {q}
                <span className={c('pm')}>
                  <Icon name="plus" />
                </span>
              </summary>
              <p>{a}</p>
            </details>
          ))}
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
        <AuthLink className={c('btn pri lg')} href={SIGN_UP}>
          Sign up
        </AuthLink>
      </div>
    </section>
  )
}

/**
 * Directories Brigade is listed on, shown on the landing page only: There's An AI For That
 * verifies its listing by finding this exact link on www.brigade.lol/ and on no other page,
 * so keep its href as they gave it and keep it out of the shared footer. The others
 * (featured-on.ts) follow it in one quiet line of text.
 */
function Featured() {
  return (
    <div className={c('wrap foot-featured')}>
      <a
        href="https://theresanaiforthat.com/ai/brigade/?ref=featured&v=915251"
        target="_blank"
        rel="nofollow"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- TAAFT's own badge, served by them */}
        <img
          width="300"
          src="https://media.theresanaiforthat.com/featured-on-taaft.png?width=600"
          alt="Featured on There's An AI For That"
        />
      </a>
      {FEATURED_ON.length > 0 && (
        <ul className={c('foot-links')} aria-label="Also featured on">
          {FEATURED_ON.map((d) => (
            <li key={d.href}>
              {d.badge ? (
                <a className={c('foot-badge')} href={d.href} title={d.name}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- the directory's own badge, served by it */}
                  <img
                    src={d.badge.src}
                    alt={d.badge.alt}
                    width={d.badge.width}
                    height={d.badge.height}
                  />
                </a>
              ) : (
                <a href={d.href}>{d.name}</a>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The page's footer; `featured` adds the directory badges, on the landing page only. */
export function Footer({ featured = false }: { featured?: boolean }) {
  return (
    <footer className={c('foot')}>
      <div className={c('wrap')}>
        <span className={c('word')}>
          <BrigadeMark className={c('word-mark')} />
          Brigade
        </span>
        <nav aria-label="Footer">
          <a href={REPO_URL}>GitHub</a>
          <a href="https://status.brigade.lol">Status</a>
          <a href="/docs">Docs</a>
          <Link href="/changelog">Changelog</Link>
          <Link href="/compare">Compare</Link>
          <Link href="/guides">Guides</Link>
          <AuthLink href={SIGN_IN}>Sign in</AuthLink>
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
          {OPERATOR.company && <Link href="/legal">Legal</Link>}
          <span>© 2026</span>
        </nav>
      </div>
      {featured && <Featured />}
      {/* The name, as large as the page is wide, cut by the bottom edge. */}
      <div className={c('foot-name')} aria-hidden="true" data-anim>
        <span>Brigade</span>
      </div>
    </footer>
  )
}
