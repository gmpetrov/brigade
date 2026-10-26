import type { CSSProperties } from 'react'
import { c } from './parts'

/** The four tiles, on a band in the dark theme whatever the page's theme. */
export function Tiles() {
  return (
    <section aria-labelledby="tiles-title" className={c('sec tiles dark')} data-anim>
      <div className={c('wrap')}>
        <div className={c('sec-head')}>
          <h2 className={c('h2')} id="tiles-title">
            Teammates that work the way you do.
          </h2>
          <p className={c('lead')}>
            They have their own computer, learn a task from watching you, keep what your team
            decided, and work on a schedule.
          </p>
        </div>
        <div className={c('tk-grid')}>
          <article className={c('tk')}>
            <div className={c('tk-copy')}>
              <h3>A computer of its own</h3>
              <p>
                Each teammate signs in to websites in its own browser, with the logins you keep in
                the vault, and works in Gmail, Stripe, GitHub or Notion through Apps. On your Mac,
                any app you have.
              </p>
            </div>
            <div className={c('demo')} aria-hidden="true">
              <div className={c('comp')}>
                <div className={c('comp-h')}>
                  <b>Computer</b>
                  <span className={c('xg end')}>
                    <span className={c('badge wait ta-a')}>login from your vault</span>
                    <span className={c('badge run ta-b')}>working</span>
                  </span>
                </div>
                <div className={c('comp-sub')}>
                  Signing in to the supplier portal to get October&apos;s invoices.
                </div>
                <div className={c('desk')}>
                  <i className={c('wp w1')}></i>
                  <i className={c('wp w2')}></i>
                  <i className={c('wp w3')}></i>
                  <div className={c('win')}>
                    <div className={c('win-bar')}>
                      <i></i>
                      <i></i>
                      <i></i>
                      <span>billing.supplier.io</span>
                    </div>
                    <div className={c('win-b xg blk-g')}>
                      <div className={c('signin ta-a')}>
                        <div className={c('si-t')}>Sign in to Supplier billing</div>
                        <div className={c('sfld')}>billing@acme.com</div>
                        <div className={c('sfld')}>••••••••••</div>
                        <div className={c('btn-c')}>Continue</div>
                      </div>
                      <div className={c('inbox ta-b')}>
                        <div className={c('ir')}>
                          <b>Invoice · September</b>
                          <span>€240.00</span>
                          <span className={c('dl-b')}>PDF</span>
                        </div>
                        <div className={c('ir')}>
                          <b>Invoice · August</b>
                          <span>€240.00</span>
                          <span className={c('dl-b')}>PDF</span>
                        </div>
                        <div className={c('ir')}>
                          <span className={c('d')}></span>
                          <b>Invoice · October</b>
                          <span>€310.00</span>
                          <span className={c('dl-b ta-btn')}>PDF</span>
                        </div>
                        <div className={c('saved')}>
                          <span className={c('dot ok')}></span>
                          Saved to Google Drive
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className={c('cur-layer ta-cur')}>
                    <span className={c('cursor')}>
                      <svg viewBox="0 0 16 16" className={c('ca')}>
                        <path d="M2 1.5 13.5 7.6l-5.2 1.2-2.4 5z" />
                      </svg>
                      <span className={c('cn')}>Sam</span>
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </article>

          <article className={c('tk')}>
            <div className={c('tk-copy')}>
              <h3>Teach them a task</h3>
              <p>
                Take over a teammate&apos;s computer and do the task once while it watches. It
                writes the steps down as a skill, and does it on its own once you approve. On
                Brigade&apos;s cloud computer for now.
              </p>
            </div>
            <div className={c('demo')} aria-hidden="true">
              <div className={c('rec2')}>
                <div className={c('rec-bar xg blk-g')}>
                  <div className={c('rb tb-a')}>
                    <span>You&apos;re in control · Riley is learning</span>
                    <span className={c('timer')}>
                      <span className={c('rdot')}></span>
                      <span className={c('xg')}>
                        <span className={c('tm0')}>0:00</span>
                        <span className={c('tm1')}>0:01</span>
                        <span className={c('tm2')}>0:02</span>
                        <span className={c('tm3')}>0:03</span>
                        <span className={c('tm4')}>0:04</span>
                        <span className={c('tm5')}>0:05</span>
                        <span className={c('tm6')}>0:06</span>
                      </span>
                    </span>
                  </div>
                  <div className={c('rb tb-b')}>
                    <span className={c('badge ok')}>Teach a task · saved as skill</span>
                    <span className={c('sk')}>weekly-report</span>
                  </div>
                </div>
                <div className={c('dash')}>
                  <div className={c('d-side')}>
                    <i></i>
                    <i></i>
                    <i></i>
                    <i></i>
                    <i></i>
                  </div>
                  <div className={c('d-main')}>
                    <div className={c('d-top')}>
                      <span className={c('d-title')}></span>
                      <span className={c('d-chip')}>Month</span>
                      <span className={c('d-chip on')}>This week</span>
                    </div>
                    <div className={c('d-bars')}>
                      <i style={{ '--a': '.35', '--b': '.55' } as CSSProperties}></i>
                      <i style={{ '--a': '.5', '--b': '.42' } as CSSProperties}></i>
                      <i style={{ '--a': '.42', '--b': '.66' } as CSSProperties}></i>
                      <i style={{ '--a': '.6', '--b': '.5' } as CSSProperties}></i>
                      <i style={{ '--a': '.48', '--b': '.74' } as CSSProperties}></i>
                      <i style={{ '--a': '.7', '--b': '.62' } as CSSProperties}></i>
                      <i
                        className={c('hl')}
                        style={{ '--a': '.55', '--b': '.9' } as CSSProperties}
                      ></i>
                      <i style={{ '--a': '.62', '--b': '.7' } as CSSProperties}></i>
                      <i style={{ '--a': '.4', '--b': '.58' } as CSSProperties}></i>
                      <i style={{ '--a': '.66', '--b': '.8' } as CSSProperties}></i>
                    </div>
                  </div>
                  <div className={c('cur-layer tb-cur')}>
                    <span className={c('cursor')}>
                      <svg viewBox="0 0 16 16" className={c('ca')}>
                        <path d="M2 1.5 13.5 7.6l-5.2 1.2-2.4 5z" />
                      </svg>
                      <span className={c('cn')}>Ada</span>
                    </span>
                  </div>
                </div>
                <span className={c('rec-frame tb-a')}></span>
              </div>
            </div>
          </article>

          <article className={c('tk')}>
            <div className={c('tk-copy')}>
              <h3>Remembers how you work</h3>
              <p>
                What your team decides goes into the workspace&apos;s memory, and skills hold the
                steps for jobs you repeat.
              </p>
            </div>
            <div className={c('demo')} aria-hidden="true">
              <div className={c('memd')}>
                <div className={c('bub tc1')}>
                  <span className={c('av sam xs')}>S</span>
                  <span>
                    Northwind asked about invoices again. Same answer as last month, sent after your
                    yes.
                  </span>
                </div>
                <div className={c('bub tc2')}>
                  <span className={c('av sam xs')}>S</span>
                  <span>Noted: Jo prefers replies before 9am.</span>
                </div>
                <div className={c('memchip tc3')}>
                  Updated memory for{' '}
                  <span className={c('vchip')}>
                    <span className={c('av xs sam')}>S</span>Sam
                  </span>
                </div>
              </div>
            </div>
          </article>

          <article className={c('tk')}>
            <div className={c('tk-copy')}>
              <h3>Runs on a schedule</h3>
              <p>
                Set a routine once and it runs on time. With Cloud, it runs overnight while your Mac
                sleeps.
              </p>
            </div>
            <div className={c('demo')} aria-hidden="true">
              <div className={c('sched')}>
                <div className={c('sc-h')}>
                  <svg className={c('clk')} viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" />
                    <path className={c('hand-m')} d="M12 12V6" />
                    <path d="M12 12h3.5" />
                  </svg>
                  <span className={c('xg sc-time')}>
                    <span className={c('ck1')}>06:58</span>
                    <span className={c('ck2')}>06:59</span>
                    <span className={c('ck3')}>07:00</span>
                  </span>
                  <span className={c('sc-l')}>Routines · Acme</span>
                </div>
                <div className={c('rt')}>
                  <span className={c('when')}>07:00</span>
                  <span className={c('what')}>
                    Triage the inbox
                    <span className={c('k')}>Sam · sorts the night&apos;s emails</span>
                  </span>
                  <span className={c('xg end')}>
                    <span className={c('badge r1a')}>scheduled</span>
                    <span className={c('badge run r1b')}>running</span>
                    <span className={c('badge ok r1c')}>done</span>
                  </span>
                </div>
                <div className={c('rt')}>
                  <span className={c('when')}>07:00</span>
                  <span className={c('what')}>
                    Chase failed payments<span className={c('k')}>Sam · reminders for yes</span>
                  </span>
                  <span className={c('xg end')}>
                    <span className={c('badge r2a')}>scheduled</span>
                    <span className={c('badge run r2b')}>running</span>
                    <span className={c('badge ok r2c')}>done</span>
                  </span>
                </div>
                <div className={c('rt')}>
                  <span className={c('when')}>Mon 09:00</span>
                  <span className={c('what')}>
                    Send the week&apos;s numbers
                    <span className={c('k')}>Riley · to your inbox</span>
                  </span>
                  <span className={c('xg end')}>
                    <span className={c('badge')}>scheduled</span>
                  </span>
                </div>
                <div className={c('rt')}>
                  <span className={c('when')}>Fri 16:00</span>
                  <span className={c('what')}>
                    Weekly release notes<span className={c('k')}>Mark · to the changelog</span>
                  </span>
                  <span className={c('xg end')}>
                    <span className={c('badge')}>scheduled</span>
                  </span>
                </div>
              </div>
            </div>
          </article>
        </div>
      </div>
    </section>
  )
}
