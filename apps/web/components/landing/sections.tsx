import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Av, Badge, Icon, MockButton, s, Tile } from './parts'

export function Problem() {
  const tabs = ['claude · fix-auth', 'codex · billing-tests', 'claude · onboarding', 'zsh']
  return (
    <section className={cn(s.sec, s.problem)} aria-labelledby="problem-title">
      <div className={s.wrap}>
        <h2 className={cn(s.h2, s.reveal)} id="problem-title">
          Your agents can do the work. You&apos;re still watching them do it.
        </h2>
        <p className={cn(s.lead, s.reveal)}>
          You pay for the best models there are, then spend the day switching terminal tabs to find
          out which session finished and which one wants you. Meanwhile one of them has sat on a y/n
          prompt for twenty minutes. And the inbox, the refunds and the follow-ups stay on your
          desk, because you can&apos;t see what an agent would do with them.
        </p>
        <div className={cn(s.tabs, s.reveal)} aria-hidden="true">
          {tabs.slice(0, 2).map((t) => (
            <div key={t} className={s.tab}>
              <Icon name="terminal" />
              <span className={s.t}>{t}</span>
            </div>
          ))}
          <div className={cn(s.tab, s.stuck)}>
            <Icon name="terminal" />
            <span className={s.t}>claude · migrate-db [y/n]</span>
            <span className={s.tm}>20:14</span>
          </div>
          {tabs.slice(2).map((t) => (
            <div key={t} className={s.tab}>
              <Icon name="terminal" />
              <span className={s.t}>{t}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function Check({ todo, children }: { todo?: boolean; children: ReactNode }) {
  return (
    <div className={s.chk}>
      <span className={cn(s.c, todo && s.todo)}>
        <Icon name={todo ? 'alert' : 'check'} />
      </span>
      <span className={s.l}>{children}</span>
      {todo && <MockButton>Fix</MockButton>}
    </div>
  )
}

export function Push() {
  return (
    <div className={s.push}>
      <span className={s.app}>B</span>
      <div className={s.pushBody}>
        <div className={s.ph}>
          <b>Brigade</b>
          <span>now</span>
        </div>
        <div className={s.pt}>Sam is waiting on you</div>
        <div className={s.pb}>Send this reply to jo@northwind.io?</div>
      </div>
    </div>
  )
}

export function HowItWorks() {
  return (
    <section className={cn(s.sec, s.how)} aria-labelledby="how-title">
      <div className={s.wrap}>
        <div className={cn(s.secHead, s.reveal)}>
          <h2 className={s.h2} id="how-title">
            Three steps to your first teammate
          </h2>
        </div>
        <ol className={s.steps}>
          <li className={cn(s.step, s.reveal)}>
            <span className={s.n}>01</span>
            <h3>Link your Mac.</h3>
            <p>
              Install Brigade.app. It checks each setup step and fixes what&apos;s missing in one
              click. Then sign in with the Claude or ChatGPT account you already use.
            </p>
            <div className={s.cap} aria-hidden="true">
              <div className={s.mini}>
                <div className={s.miniH}>Set up Brigade</div>
                <Check>Claude Code installed</Check>
                <Check>Signed in as ada@acme.com</Check>
                <Check todo>Accessibility permission</Check>
              </div>
            </div>
          </li>
          <li className={cn(s.step, s.reveal)}>
            <span className={s.n}>02</span>
            <h3>Give each teammate a job.</h3>
            <p>
              Support, pull requests, Stripe follow-ups. Connect the apps it needs: Gmail, GitHub,
              Stripe, Linear, Notion and more.
            </p>
            <div className={s.cap} aria-hidden="true">
              <div className={s.mini}>
                <div className={s.miniH}>Teammates · Acme</div>
                <div className={s.tmRow}>
                  <Av sam>S</Av>
                  <div>
                    <div className={s.nm}>Sam</div>
                    <div className={s.rl}>Support</div>
                  </div>
                  <span className={s.tiles}>
                    <Tile>G</Tile>
                    <Tile>S</Tile>
                    <Tile>N</Tile>
                  </span>
                </div>
                <div className={s.tmRow}>
                  <Av>R</Av>
                  <div>
                    <div className={s.nm}>Riley</div>
                    <div className={s.rl}>Engineer</div>
                  </div>
                  <span className={s.tiles}>
                    <Tile>GH</Tile>
                    <Tile>L</Tile>
                  </span>
                </div>
              </div>
            </div>
          </li>
          <li className={cn(s.step, s.reveal)}>
            <span className={s.n}>03</span>
            <h3>Answer what needs you.</h3>
            <p>
              Teammates work in the background and come back for the decisions you kept. Your phone
              tells you when one is waiting.
            </p>
            <div className={cn(s.cap, s.capPush)} aria-hidden="true">
              <Push />
            </div>
          </li>
        </ol>
      </div>
    </section>
  )
}

export function Team() {
  return (
    <section className={cn(s.sec, s.team)} aria-labelledby="team-title">
      <div className={s.wrap}>
        <div className={cn(s.secHead, s.reveal)}>
          <h2 className={s.h2} id="team-title">
            One team, from the codebase to the inbox
          </h2>
        </div>
        <div className={s.jobs}>
          <article className={cn(s.job, s.reveal)}>
            <div className={cn(s.stage, s.green)} aria-hidden="true">
              <div className={s.shot}>
                <div className={s.shotH}>
                  <Av sam>S</Av>
                  <b>Support inbox</b>
                  <span className={s.sp} />
                  <span className={s.meta}>Sam · today</span>
                </div>
                <div className={s.list}>
                  <div className={s.it}>
                    <span className={s.ico}>
                      <Icon name="mail" />
                    </span>
                    <div className={s.tx}>
                      <div className={s.tt}>Where is my invoice?</div>
                      <div className={s.mt}>jo@northwind.io · answer drafted from your docs</div>
                    </div>
                    <Badge tone="wait">waiting</Badge>
                  </div>
                  <div className={s.it}>
                    <span className={s.ico}>
                      <Icon name="pr" />
                    </span>
                    <div className={s.tx}>
                      <div className={s.tt}>Login loop after password reset</div>
                      <div className={s.mt}>Bug · Riley opened PR #214</div>
                    </div>
                    <Badge tone="run">working</Badge>
                  </div>
                  <div className={s.it}>
                    <span className={s.ico}>
                      <Icon name="mail" />
                    </span>
                    <div className={s.tx}>
                      <div className={s.tt}>How do I add a seat?</div>
                      <div className={s.mt}>mei@lumen.co · sent after your yes</div>
                    </div>
                    <Badge tone="ok">answered</Badge>
                  </div>
                </div>
              </div>
            </div>
            <h3>Support inbox</h3>
            <p>
              A teammate sorts every support email into cases and drafts the answers your docs
              already cover. It asks you before it sends. A bug report becomes a pull request.
            </p>
          </article>

          <article className={cn(s.job, s.reveal)}>
            <div className={cn(s.stage, s.violet)} aria-hidden="true">
              <div className={s.shot}>
                <div className={s.pv}>
                  <div className={s.pvBar}>
                    <i />
                    <i />
                    <i />
                    <span>preview · /invoices</span>
                  </div>
                  <div className={s.pvBody}>
                    <div className={s.pvRow}>
                      <span>Invoice</span>
                      <span>Total</span>
                    </div>
                    <div className={s.pvRow}>
                      <span>#8811 · Lumen</span>
                      <span className={s.mono}>$1,240.00</span>
                    </div>
                    <div className={cn(s.pvRow, s.hl)}>
                      <span>#8812 · Northwind</span>
                      <span className={s.mono}>$318.40</span>
                    </div>
                  </div>
                </div>
                <div className={s.prc}>
                  <Av>R</Av>
                  <div className={s.tx}>
                    <div className={s.tt}>
                      PR #212 <span className={s.k}>· Fix invoice rounding</span>
                    </div>
                    <div className={s.mt}>Riley · checks passed</div>
                  </div>
                  <MockButton tone="pri">Merge</MockButton>
                </div>
              </div>
            </div>
            <h3>Pull requests</h3>
            <p>
              Ask for a fix in a sentence. The teammate runs your app and you watch the change
              appear in a live preview as it edits. Then it opens the pull request, and you merge it
              from your phone.
            </p>
          </article>

          <article className={cn(s.job, s.reveal)}>
            <div className={cn(s.stage, s.orange)} aria-hidden="true">
              <div className={cn(s.shot, s.doc)}>
                <div className={s.shotH}>
                  <Av>M</Av>
                  <b>Draft · pricing page</b>
                  <span className={s.sp} />
                  <Badge tone="wait">waiting</Badge>
                </div>
                <div className={s.dt}>
                  Stop paying twice for the same seat.<sup>1</sup>
                </div>
                <p>
                  Founders on Reddit say per-seat pricing is the first thing they cut<sup>1</sup>.
                  Two of five competitors hide prices behind a demo<sup>2</sup>.
                </p>
                <div className={s.srcs}>
                  <span className={s.src}>
                    <span className={s.sn}>1</span>reddit.com/r/SaaS
                  </span>
                  <span className={s.src}>
                    <span className={s.sn}>2</span>competitor pricing pages
                  </span>
                  <span className={cn(s.src, s.hideM)}>
                    <span className={s.sn}>3</span>skill · brand-voice
                  </span>
                </div>
              </div>
            </div>
            <h3>Marketing</h3>
            <p>
              A teammate reads what your customers write on Reddit and what your competitors put on
              their pages, then drafts the copy with every source linked. Give it your own skills,
              and it works the way your team does.
            </p>
          </article>

          <article className={cn(s.job, s.reveal)}>
            <div className={cn(s.stage, s.ink)} aria-hidden="true">
              {/* The dark theme's colours, whatever the page's theme. */}
              <div className={cn(s.shot, s.shotDark, 'dark')}>
                <div className={s.shotH}>
                  <b>This morning</b>
                  <span className={s.sp} />
                  <span className={s.meta}>Routines · Acme</span>
                </div>
                <div className={s.rt}>
                  <span className={s.when}>07:00</span>
                  <span className={s.what}>
                    Triage the inbox<span className={s.k}>Sam · 23 emails sorted, 4 drafts</span>
                  </span>
                  <Badge tone="ok">done</Badge>
                </div>
                <div className={s.rt}>
                  <span className={s.when}>08:00</span>
                  <span className={s.what}>
                    Chase failed payments
                    <span className={s.k}>Sam · 3 reminders, 1 waiting on you</span>
                  </span>
                  <Badge tone="ok">done</Badge>
                </div>
                <div className={s.rt}>
                  <span className={s.when}>Mon 09:00</span>
                  <span className={s.what}>
                    Send the week&apos;s numbers<span className={s.k}>Riley · to #founders</span>
                  </span>
                  <Badge>scheduled</Badge>
                </div>
              </div>
            </div>
            <h3>Overnight routines</h3>
            <p>
              Set a routine once: triage the inbox at 7, chase failed payments every morning, send
              the week&apos;s numbers on Monday. The morning list on Home shows what got done.
            </p>
          </article>
        </div>
      </div>
    </section>
  )
}
