import type { CSSProperties } from 'react'
import { c, Icon } from './parts'

export function Control() {
  return (
    <section aria-labelledby="control-title" className={c('sec control')}>
      <div className={c('wrap')}>
        <div className={c('sec-head')}>
          <h2 className={c('h2')} id="control-title">
            Hand off the work. Keep the decisions.
          </h2>
          <p className={c('lead')}>
            You set what each teammate does alone and what waits for you. Every request lands in one
            list, Needs you, with what the teammate wants to do and why.
          </p>
        </div>
        <div className={c('ctl-grid')}>
          <div className={c('ctl')}>
            <div className={c('ctl-n')}>
              <span className={c('pt-i')}>
                <Icon name="check" />
              </span>
              <span className={c('n')}>01</span>
            </div>
            <h3>Approvals</h3>
            <p>
              For each teammate, you choose what waits for your yes: sending an email, a change in
              Stripe, shipping code.
            </p>
            <div className={c('cap')} aria-hidden="true">
              <div className={c('mini ticket')}>
                <div className={c('tk-top')}>
                  <span className={c('dot wait')}></span>Needs you<span className={c('sp')}></span>
                  <span className={c('tm')}>2m</span>
                </div>
                <div className={c('tk-who')}>
                  <span className={c('av sam')}>S</span>
                  <b>Sam wants to send a reply</b>
                </div>
                <div className={c('tk-meta')}>
                  <span className={c('tile sm')}>G</span>Gmail · to jo@northwind.io
                </div>
                <div className={c('tk-act xg blk-g')}>
                  <div className={c('acts c-a')}>
                    <span className={c('btn sm pri c-tap')}>Send</span>
                    <span className={c('btn sm ghost')}>Decline</span>
                  </div>
                  <div className={c('sentline c-b')}>
                    <span className={c('badge ok')}>sent</span>after your yes
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className={c('ctl')}>
            <div className={c('ctl-n')}>
              <span className={c('pt-i')}>
                <Icon name="lock" />
              </span>
              <span className={c('n')}>02</span>
            </div>
            <h3>Vault</h3>
            <p>
              Passwords stay in your workspace&apos;s vault. Brigade types the login for the
              teammate, which never sees the password.
            </p>
            <div className={c('cap')} aria-hidden="true">
              <div className={c('mini')}>
                <div className={c('vrow')}>
                  <span className={c('vi')}>
                    <Icon name="key" />
                  </span>
                  <div className={c('tx')}>
                    <div className={c('tt')}>Stripe dashboard</div>
                    <div className={c('mt')}>Sam · updated 3 days ago</div>
                  </div>
                  <span className={c('dots')}>••••••••</span>
                </div>
                <div className={c('vrow')}>
                  <span className={c('vi')}>
                    <Icon name="key" />
                  </span>
                  <div className={c('tx')}>
                    <div className={c('tt')}>HubSpot</div>
                    <div className={c('mt')}>Sam, Mark · updated last week</div>
                  </div>
                  <span className={c('dots')}>••••••••</span>
                </div>
                <div className={c('typing c-type')}>
                  <Icon name="shield" />
                  Brigade typed the Stripe login for Sam
                </div>
              </div>
            </div>
          </div>
          <div className={c('ctl')}>
            <div className={c('ctl-n')}>
              <span className={c('pt-i')}>
                <Icon name="users" />
              </span>
              <span className={c('n')}>03</span>
            </div>
            <h3>Access per teammate</h3>
            <p>
              Give the support teammate Gmail and the developer GitHub. Each app is read-only or
              read-write, teammate by teammate.
            </p>
            <div className={c('cap')} aria-hidden="true">
              <div className={c('mini')}>
                <div className={c('acc-row')}>
                  <span className={c('av sam')}>S</span>
                  <span className={c('nm')}>Sam&apos;s apps</span>
                  <span className={c('acc-h')}>set by Ada · admin</span>
                </div>
                <div className={c('acc-row')}>
                  <span className={c('tile sm')}>G</span>
                  <span className={c('nm')}>Gmail</span>
                  <span className={c('seg2 rw')}>
                    <span className={c('thumb')}></span>
                    <span>Read</span>
                    <span>Read-write</span>
                  </span>
                </div>
                <div className={c('acc-row')}>
                  <span className={c('tile sm')}>S</span>
                  <span className={c('nm')}>Stripe</span>
                  <span className={c('seg2')}>
                    <span className={c('thumb ac-thumb')}></span>
                    <span>Read</span>
                    <span>Read-write</span>
                  </span>
                </div>
                <div className={c('acc-row')}>
                  <span className={c('tile sm')}>GH</span>
                  <span className={c('nm')}>GitHub</span>
                  <span className={c('acc-h')}>no access</span>
                </div>
              </div>
            </div>
          </div>
          <div className={c('ctl')}>
            <div className={c('ctl-n')}>
              <span className={c('pt-i')}>
                <Icon name="list" />
              </span>
              <span className={c('n')}>04</span>
            </div>
            <h3>Every step logged</h3>
            <p>Open any thread to see what the teammate did, read and changed, step by step.</p>
            <div className={c('cap')} aria-hidden="true">
              <div className={c('mini')}>
                <div className={c('log-l')}>
                  <div className={c('ln lg0')}>
                    <span>09:12</span>
                    <span className={c('ok-i')}>
                      <Icon name="check" />
                    </span>
                    <span>
                      <b>read</b> Gmail · 14 new emails
                    </span>
                  </div>
                  <div className={c('ln lg1')}>
                    <span>09:13</span>
                    <span className={c('ok-i')}>
                      <Icon name="check" />
                    </span>
                    <span>
                      <b>searched</b> help center · "invoice"
                    </span>
                  </div>
                  <div className={c('ln lg2')}>
                    <span>09:14</span>
                    <span className={c('ok-i')}>
                      <Icon name="check" />
                    </span>
                    <span>
                      <b>drafted</b> reply to jo@northwind.io
                    </span>
                  </div>
                  <div className={c('ln lg3')}>
                    <span>09:14</span>
                    <span
                      style={{ color: 'var(--warning)', display: 'inline-flex' } as CSSProperties}
                    >
                      <Icon name="clock" />
                    </span>
                    <span>
                      <b>waiting</b> on Ada to send
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
