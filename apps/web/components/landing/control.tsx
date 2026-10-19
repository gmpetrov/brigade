import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Av, Badge, Icon, MockButton, s, Tile } from './parts'
import { Push } from './sections'

const tickets = [
  {
    sam: true,
    time: '2m',
    who: 'Sam wants to send a reply',
    tile: 'G',
    meta: 'Gmail · to jo@northwind.io',
    quote: "Hi Jo, your October invoice is in Settings, Billing. I've attached a copy here too.",
    why: 'the answer is in your billing docs.',
    action: 'Send',
  },
  {
    sam: false,
    time: '9m',
    who: 'Riley wants to merge PR #212',
    tile: 'GH',
    meta: 'GitHub · acme/web',
    quote: 'Fix invoice rounding. 3 files changed, checks passed.',
    why: "Sam's bug report from jo@northwind.io.",
    action: 'Merge',
  },
  {
    sam: true,
    time: '14m',
    who: 'Sam wants to write to Stripe',
    tile: 'S',
    meta: 'Stripe · Northwind',
    quote: 'Retry the failed payment of $318.40.',
    why: 'the card was updated yesterday.',
    action: 'Approve',
  },
  {
    sam: true,
    time: '21m',
    who: 'Sam wants to send a reply',
    tile: 'G',
    meta: 'Gmail · to mei@lumen.co',
    quote: 'Hi Mei, you can add a seat from Settings, Members.',
    why: 'covered by your help center.',
    action: 'Send',
  },
]

function Point({
  icon,
  title,
  children,
}: {
  icon: Parameters<typeof Icon>[0]['name']
  title: string
  children: ReactNode
}) {
  return (
    <div className={s.point}>
      <span className={s.ptI} aria-hidden="true">
        <Icon name={icon} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  )
}

export function Control() {
  return (
    <section className={cn(s.sec, s.control)} aria-labelledby="control-title">
      <div className={s.wrap}>
        <div className={cn(s.secHead, s.reveal)}>
          <h2 className={s.h2} id="control-title">
            You decide what needs your yes
          </h2>
          <p className={s.lead}>
            For each teammate, choose what it does alone and what it asks first: sending an email,
            writing to Stripe, merging a pull request. Every request lands in one list, Needs you,
            with what the teammate wants to do and why. Your phone buzzes, you tap, you answer.
          </p>
        </div>

        <div className={cn(s.rail, s.reveal)} aria-hidden="true">
          <div className={s.bar} />
          <div className={s.tickets}>
            {tickets.map((t) => (
              <div key={t.time} className={s.ticket}>
                <div className={s.tkTop}>
                  <span className={cn(s.dot, s.wait)} />
                  Needs you
                  <span className={s.sp} />
                  <span className={s.tm}>{t.time}</span>
                </div>
                <div className={s.tkWho}>
                  <Av sam={t.sam}>{t.sam ? 'S' : 'R'}</Av>
                  <b>{t.who}</b>
                </div>
                <div className={s.tkMeta}>
                  <Tile>{t.tile}</Tile>
                  {t.meta}
                </div>
                <div className={s.tkQuote}>{t.quote}</div>
                <div className={s.tkWhy}>
                  <b>Why:</b> {t.why}
                </div>
                <div className={s.tkAct}>
                  <MockButton>{t.action}</MockButton>
                  <MockButton tone="ghost">Decline</MockButton>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className={s.ctlBody}>
          <div className={cn(s.phone, s.reveal)} aria-hidden="true">
            <div className={s.screen}>
              <span className={s.island} />
              <div className={s.sbar}>
                <span>9:41</span>
                <span className={s.sig}>
                  <i />
                </span>
              </div>
              <div className={s.phPush}>
                <Push />
              </div>
              <div className={s.phBody}>
                <div className={s.phTitle}>
                  Needs you <span className={s.n}>3</span>
                </div>
                <div className={s.ticket}>
                  <div className={s.tkTop}>
                    <span className={cn(s.dot, s.wait)} />
                    Gmail · write
                    <span className={s.sp} />
                    <span className={s.tm}>now</span>
                  </div>
                  <div className={s.tkWho}>
                    <Av sam>S</Av>
                    <b>Sam wants to send a reply</b>
                  </div>
                  <div className={s.tkMeta}>to jo@northwind.io · Where is my invoice?</div>
                  <div className={s.tkQuote}>
                    Hi Jo, your October invoice is in Settings, Billing. I&apos;ve attached a copy
                    here too.
                  </div>
                  <div className={s.tkAct}>
                    <MockButton tone="pri" size="md">
                      Send
                    </MockButton>
                    <MockButton size="md">Decline</MockButton>
                  </div>
                </div>
                <div className={s.phMore}>
                  <Av>R</Av>
                  <div>
                    <div className={s.tt}>Merge PR #212</div>
                    <div className={s.mt}>Riley · checks passed</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className={cn(s.points, s.reveal)}>
            <Point icon="lock" title="Passwords stay in the vault.">
              Brigade types a website login for the teammate, so it never sees the password.
            </Point>
            <Point icon="list" title="Every step is logged.">
              Open any thread to see what the teammate ran, read and changed.
            </Point>
            <Point icon="octagon" title="Stop it any time.">
              When a teammate uses your Mac, a pill on your screen says so, with a Stop button.
            </Point>
            <Point icon="key" title="Each teammate gets only its own keys.">
              Give the support teammate Gmail and the engineer GitHub. A login in the vault goes to
              the teammates you pick, and each app is read-only or read-write per teammate.
            </Point>
            <Point icon="users" title="Roles for the people too.">
              Owners and admins set up teammates and access. An account you connect can stay in your
              own threads or be shared with the workspace.
            </Point>
            <div className={s.point} aria-hidden="true">
              <span className={s.using}>
                <span className={s.dot} />
                Riley is using your computer
                <span className={s.stop}>
                  <Icon name="stop" />
                  Stop
                </span>
              </span>
            </div>
            <div className={s.artifacts} aria-hidden="true">
              <div className={s.access}>
                <div className={s.accRow}>
                  <Av sam>S</Av>
                  <span className={s.nm}>Sam&apos;s apps</span>
                  <span className={s.accH}>set by Ada · admin</span>
                </div>
                <div className={s.accRow}>
                  <Tile>G</Tile>
                  <span className={s.nm}>Gmail</span>
                  <span className={s.lv}>read-write · asks before sending</span>
                </div>
                <div className={s.accRow}>
                  <Tile>S</Tile>
                  <span className={s.nm}>Stripe</span>
                  <span className={s.lv}>read-only</span>
                </div>
                <div className={s.accRow}>
                  <Tile>GH</Tile>
                  <span className={s.nm}>GitHub</span>
                  <span className={s.lv}>no access</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function Node({
  tile,
  ink,
  name,
  desc,
  dim,
  badge,
}: {
  tile: ReactNode
  ink?: boolean
  name: string
  desc: string
  dim?: boolean
  badge?: ReactNode
}) {
  return (
    <div className={cn(s.node, dim && s.dim)}>
      <Tile className={ink ? s.ink : undefined}>{tile}</Tile>
      <div className={s.tx}>
        <div className={s.nm}>{name}</div>
        <div className={s.ds}>{desc}</div>
      </div>
      {badge}
    </div>
  )
}

export function UnderTheHood() {
  return (
    <section className={cn(s.sec, s.under)} aria-labelledby="under-title">
      <div className={s.wrap}>
        <div className={cn(s.secHead, s.reveal)}>
          <h2 className={s.h2} id="under-title">
            Built on the agents you already trust
          </h2>
        </div>
        <div className={cn(s.diagram, s.reveal)} aria-hidden="true">
          <div className={s.dgCol}>
            <span className={s.dgL}>Harness</span>
            <Node tile="C" ink name="Claude Code" desc="official CLI" />
            <Node tile="X" ink name="Codex" desc="official CLI" />
          </div>
          <div className={s.arrow}>
            <Icon name="arrow" />
          </div>
          <div className={s.dgCol}>
            <span className={s.dgL}>Riley&apos;s plans</span>
            <Node
              tile="A"
              dim
              name="ada@acme.com"
              desc="Claude Max"
              badge={<Badge tone="wait">limit reached</Badge>}
            />
            <Node
              tile="O"
              name="ops@acme.com"
              desc="Claude Max · picked up mid-task"
              badge={<Badge tone="ok">active</Badge>}
            />
          </div>
          <div className={s.arrow}>
            <Icon name="arrow" />
          </div>
          <div className={s.dgCol}>
            <span className={s.dgL}>Runs on</span>
            <Node tile={<Icon name="laptop" />} name="Ada's MacBook" desc="online" />
            <span className={s.cont}>
              <Icon name="swap" />
              Continue on…
            </span>
            <Node tile={<Icon name="cloud" />} name="Cloud computer" desc="online" />
          </div>
        </div>
        <div className={s.blocks4}>
          <div className={cn(s.b4, s.reveal)}>
            <h3>The real Claude Code and Codex.</h3>
            <p>
              Brigade runs the official CLIs, signed in with your accounts, so each teammate works
              exactly as it does in your terminal. Pick Claude Code or Codex for each teammate.
            </p>
          </div>
          <div className={cn(s.b4, s.reveal)}>
            <h3>Stack your plans.</h3>
            <p>
              Connect several Claude or ChatGPT accounts. When one hits its limit, the teammate
              carries on with the next one, in the middle of the task.
            </p>
          </div>
          <div className={cn(s.b4, s.reveal)}>
            <h3>Your Mac or the cloud, and back.</h3>
            <p>
              Move a thread from the cloud computer to your Mac and back again with &quot;Continue
              on…&quot;. It picks up where it left off.
            </p>
          </div>
          <div className={cn(s.b4, s.reveal)}>
            <h3>Computer use for every teammate.</h3>
            <p>
              On your Mac, Claude and Codex teammates alike read the screen&apos;s interface, click
              and type in any app, and take screenshots only when they need one. On the cloud
              computer, each teammate drives its own browser.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
