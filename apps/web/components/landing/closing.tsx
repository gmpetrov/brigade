import Link from 'next/link'
import { formatCount, type ProofNumbers, REPO, REPO_URL, mergeDate } from '@/lib/github-proof'
import { cn } from '@/lib/utils'
import { Av, Badge, Cta, Icon, s, SIGN_IN, SIGN_UP } from './parts'

export function BuiltBy({ numbers }: { numbers: ProofNumbers }) {
  const { mergedPrs, rileyCommits, totalCommits, recentMerges } = numbers
  const commits = rileyCommits !== null && totalCommits !== null
  return (
    <section className={cn(s.sec, s.built)} aria-labelledby="built-title">
      <div className={s.wrap}>
        <div className={s.reveal}>
          <h2 className={s.h2} id="built-title">
            We build Brigade with Brigade
          </h2>
          <p className={s.lead}>
            Brigade started on October 9, 2026.{' '}
            {commits && (
              <>
                Since then Riley, one of its teammates, has written {formatCount(rileyCommits)} of
                its {formatCount(totalCommits)} commits.{' '}
              </>
            )}
            A person approves every change before it goes in. The whole history is public.
          </p>
          <p className={s.lead}>
            Our marketing runs the same way: Mark, a Brigade teammate, researched this page from 107
            real quotes and 14 competitors&apos; sites before a person picked the words.
          </p>
          <a className={s.link} href={REPO_URL}>
            Read the code on GitHub <Icon name="arrow" />
          </a>
        </div>
        <div className={s.reveal}>
          {commits && (
            <div className={s.nums} aria-hidden="true">
              <div>
                <div className={s.num}>{formatCount(rileyCommits)}</div>
                <div className={s.numL}>commits by Riley</div>
              </div>
              <div>
                <div className={cn(s.num, s.of)}>{formatCount(totalCommits)}</div>
                <div className={s.numL}>commits in total</div>
              </div>
            </div>
          )}
          {recentMerges && (
            <section className={s.log} aria-label="Latest merged pull requests">
              <div className={s.logH}>
                <Icon name="github" />
                <span className={s.mono}>{REPO}</span>
                <span className={s.sp} />
                {mergedPrs !== null && <Badge tone="ok">{formatCount(mergedPrs)} merged</Badge>}
              </div>
              {recentMerges.map((pr) => (
                <a key={pr.number} className={s.lgr} href={pr.url}>
                  <span className={s.mg} aria-hidden="true">
                    <Icon name="merged" />
                  </span>
                  <div>
                    <div className={s.tt}>{pr.title}</div>
                    <div className={s.mt}>
                      #{pr.number}
                      {pr.branch && <> · {pr.branch}</>} · merged
                    </div>
                  </div>
                  <span className={s.tm}>
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

export function Pricing() {
  return (
    // Dark whatever the page's theme: the night the cloud computer works through.
    <section className={cn(s.pricing, 'dark')} id="pricing" aria-labelledby="pricing-title">
      <div className={s.night} aria-hidden="true">
        <div className={cn(s.blk, s.slab)}>
          <span className={s.msg}>
            <span className={s.when}>02:14</span>Riley <span className={s.k}>· opened PR #213</span>
          </span>
          <span className={cn(s.msg, s.r)}>
            <span className={s.when}>03:40</span>Sam{' '}
            <span className={s.k}>· drafted 9 replies</span>
          </span>
          <span className={s.msg}>
            <span className={s.when}>07:00</span>Sam <span className={s.k}>· inbox triaged</span>
          </span>
        </div>
        <div className={s.moon} />
        <div className={cn(s.blk, s.bGreen)} />
      </div>
      <div className={s.wrap}>
        <div className={cn(s.prHead, s.reveal)}>
          <h2 className={s.h2} id="pricing-title">
            Free on your Mac. Pay only for the cloud computer.
          </h2>
        </div>
        <div className={cn(s.plans, s.reveal)}>
          <div className={s.plan}>
            <h3 className={s.planN}>
              <Icon name="laptop" />
              Free
            </h3>
            <div className={s.price}>
              <span className={s.amt}>$0</span>
            </div>
            <ul className={s.feat}>
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
            <Cta href={SIGN_UP} large>
              Start free on your Mac
            </Cta>
          </div>
          <div className={cn(s.plan, s.cloud)}>
            <h3 className={s.planN}>
              <Icon name="cloud" />
              Cloud
            </h3>
            <div className={s.price}>
              <span className={s.amt}>$99</span>
              <span className={s.per}>/ month per workspace</span>
            </div>
            <ul className={s.feat}>
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
            <Cta href={SIGN_UP} primary large>
              Start with Cloud
            </Cta>
            <p className={s.quiet}>Runs up to 4 threads at once</p>
          </div>
        </div>
        <p className={s.prFoot}>
          You use your own Claude or ChatGPT plan, so we never charge you for AI usage. Brigade is
          open source under the MIT license.
        </p>
      </div>
    </section>
  )
}

const faqs = [
  [
    'Do I need a Claude or ChatGPT plan?',
    'Yes. Teammates use your own Claude or ChatGPT account, through Claude Code and Codex, the official tools from Anthropic and OpenAI. A Claude Max or ChatGPT Pro plan gives them the most room.',
  ],
  [
    'What happens when my Mac goes to sleep?',
    "Teammates on your Mac stop until it wakes up, and a routine due in the meantime is skipped: you get a ticket saying so. With Cloud, they keep working on Brigade's computer and routines run on time.",
  ],
  [
    "I don't have a Mac.",
    "Start with Cloud. Your teammates run on Brigade's cloud computer and you use Brigade from any browser or your phone.",
  ],
  [
    'Can a teammate send an email or write to Stripe without me?',
    'Only if you let it. For each teammate you choose whether it can make changes in your apps on its own or waits for your yes in Needs you. Ready-made playbooks, like the support one, ask before they send.',
  ],
  [
    'Where do my passwords and API keys go?',
    "In your workspace's vault. For a website, Brigade types the login for the teammate, which never sees the password.",
  ],
  [
    'What happens when I hit my Claude limit?',
    'Connect a second account and the teammate moves to it mid-task. With no account left, the thread waits and starts again when your limit resets.',
  ],
  [
    'How is this different from using Claude or ChatGPT on my own?',
    "On your own, you start each task and stay with it until it's done. Brigade's teammates work in the background, connected to your Gmail, GitHub and Stripe, run routines on a schedule, and bring what needs you to one list your team shares.",
  ],
  [
    'Is it really open source?',
    'Yes, the whole product is on GitHub under the MIT license, including the web app, the server and the Mac app.',
  ],
]

export function Faq() {
  return (
    <section className={cn(s.sec, s.faq)} aria-labelledby="faq-title">
      <div className={s.wrap}>
        <div>
          <h2 className={s.ovl} id="faq-title">
            FAQ
          </h2>
        </div>
        <div className={cn(s.qs, s.reveal)}>
          {faqs.map(([q, a], i) => (
            <details key={q} open={i === 0}>
              <summary>
                {q}
                <span className={s.pm} aria-hidden="true">
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
    <section className={s.final} aria-labelledby="final-title">
      <div className={s.art} aria-hidden="true">
        <div className={cn(s.blk, s.bTint)} />
        <div className={cn(s.blk, s.slab)}>
          <span className={cn(s.msg, s.msg1)}>
            <Av>R</Av>Riley <span className={s.k}>· merged by Ada</span>
          </span>
          <span className={cn(s.msg, s.msg2)}>
            <Av sam>S</Av>Sam <span className={s.k}>· 4 replies sent</span>
          </span>
        </div>
        <div className={cn(s.blk, s.bGreen)} />
        <div className={cn(s.blk, s.bOrange)} />
        <div className={cn(s.blk, s.bInk)} />
      </div>
      <div className={cn(s.wrap, s.reveal)}>
        <h2 id="final-title">Give your AI teammates their own desk</h2>
        <p className={s.lead}>
          Start on your Mac today. Move to the cloud when you want them working through the night.
        </p>
        <Cta href={SIGN_UP} primary large>
          Start free on your Mac
        </Cta>
      </div>
    </section>
  )
}

export function Footer() {
  return (
    <footer className={s.foot}>
      <div className={s.wrap}>
        <span className={s.word}>Brigade</span>
        <nav aria-label="Footer">
          <a href="#pricing">Pricing</a>
          <a href={REPO_URL}>GitHub</a>
          <Link href={SIGN_IN}>Sign in</Link>
          <span>MIT license</span>
          <span>© 2026</span>
        </nav>
      </div>
    </footer>
  )
}
