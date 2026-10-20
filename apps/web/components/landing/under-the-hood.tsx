import type { ReactNode } from 'react'
import { c, Icon } from './parts'

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
    <div className={c(dim ? 'node dim' : 'node')}>
      <span className={c(ink ? 'tile ink' : 'tile')}>{tile}</span>
      <div className={c('tx')}>
        <div className={c('nm')}>{name}</div>
        <div className={c('ds')}>{desc}</div>
      </div>
      {badge}
    </div>
  )
}

/** How Brigade runs, for /how-it-works: the real CLIs, stacked plans, Mac or cloud, computer use. */
export function UnderTheHood() {
  return (
    <section className={c('sec under')} aria-labelledby="under-title">
      <div className={c('wrap')}>
        <div className={c('sec-head')}>
          <h2 className={c('h2')} id="under-title">
            Built on the agents you already trust
          </h2>
        </div>
        <div className={c('diagram')} aria-hidden="true">
          <div className={c('dgCol')}>
            <span className={c('dgL')}>Harness</span>
            <Node tile="C" ink name="Claude Code" desc="official CLI" />
            <Node tile="X" ink name="Codex" desc="official CLI" />
          </div>
          <div className={c('arrow')}>
            <Icon name="arrow" />
          </div>
          <div className={c('dgCol')}>
            <span className={c('dgL')}>Riley&apos;s plans</span>
            <Node
              tile="A"
              dim
              name="ada@acme.com"
              desc="Claude Max"
              badge={<span className={c('badge wait')}>limit reached</span>}
            />
            <Node
              tile="O"
              name="ops@acme.com"
              desc="Claude Max · picked up mid-task"
              badge={<span className={c('badge ok')}>active</span>}
            />
          </div>
          <div className={c('arrow')}>
            <Icon name="arrow" />
          </div>
          <div className={c('dgCol')}>
            <span className={c('dgL')}>Runs on</span>
            <Node tile={<Icon name="laptop" />} name="Ada's MacBook" desc="online" />
            <span className={c('cont')}>
              <Icon name="swap" />
              Continue on…
            </span>
            <Node tile={<Icon name="cloud" />} name="Cloud computer" desc="online" />
          </div>
        </div>
        <div className={c('blocks4')}>
          <div className={c('b4')}>
            <h3>The real Claude Code and Codex.</h3>
            <p>
              Brigade runs the official CLIs, signed in with your accounts, so each teammate works
              exactly as it does in your terminal. Pick Claude Code or Codex for each teammate.
            </p>
          </div>
          <div className={c('b4')}>
            <h3>Stack your plans.</h3>
            <p>
              Connect several Claude or ChatGPT accounts. When one hits its limit, the teammate
              carries on with the next one, in the middle of the task.
            </p>
          </div>
          <div className={c('b4')}>
            <h3>Your Mac or the cloud, and back.</h3>
            <p>
              Move a thread from the cloud computer to your Mac and back again with &quot;Continue
              on…&quot;. It picks up where it left off.
            </p>
          </div>
          <div className={c('b4')}>
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
