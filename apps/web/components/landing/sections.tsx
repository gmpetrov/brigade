import type { CSSProperties } from 'react'
import { c, Icon } from './parts'

export function Message() {
  return (
    <section aria-labelledby="message-title" className={c('sec message')}>
      <div className={c('wrap')}>
        <div className={c('msg-stage')} aria-hidden="true">
          <div className={c('blk b-green')}></div>
          <div className={c('blk b-orange')}></div>
          <div className={c('home-card')}>
            <div className={c('hc-hello')}>Good morning, Ada</div>
            <div className={c('hc-state')}>
              <span className={c('dot wait')}></span>
              <span className={c('xg')}>
                <span className={c('m-a')}>2 waiting on you · 3 threads running</span>
                <span className={c('m-b')}>1 waiting on you · 3 threads running</span>
              </span>
            </div>
            <div className={c('hc-h')}>
              <h4>Waiting on you</h4>
              <span className={c('n xg')}>
                <span className={c('m-a')}>2</span>
                <span className={c('m-b')}>1</span>
              </span>
            </div>
            <div className={c('list wait')}>
              <div className={c('xg rows')}>
                <div className={c('it m-a')}>
                  <span className={c('ico w')}>
                    <Icon name="mail" />
                  </span>
                  <div className={c('tx')}>
                    <div className={c('tt')}>Send 3 replies about the export fix</div>
                    <div className={c('mt')}>Sam · Northwind, Lumen, Acme</div>
                  </div>
                  <span className={c('btn sm')}>Review</span>
                </div>
                <div className={c('it m-b')}>
                  <span className={c('ico ok-c')}>
                    <Icon name="check" />
                  </span>
                  <div className={c('tx')}>
                    <div className={c('tt')}>3 replies sent</div>
                    <div className={c('mt')}>Sam · after your yes</div>
                  </div>
                  <span className={c('badge ok')}>sent</span>
                </div>
              </div>
              <div className={c('it')}>
                <span className={c('ico w')}>
                  <Icon name="pr" />
                </span>
                <div className={c('tx')}>
                  <div className={c('tt')}>Fix invoice rounding</div>
                  <div className={c('mt')}>Riley · tested · ready to ship</div>
                </div>
                <span className={c('btn sm')}>Approve</span>
              </div>
            </div>
            <div className={c('hc-run')}>
              <div className={c('r')}>
                <span className={c('dot run')}></span>
                <span className={c('t')}>Release notes · week 43</span>
                <span className={c('m')}>Mark</span>
              </div>
              <div className={c('r')}>
                <span className={c('dot run')}></span>
                <span className={c('t')}>Competitor pricing check</span>
                <span className={c('m')}>Mark</span>
              </div>
            </div>
          </div>
          <div className={c('phone')}>
            <div className={c('screen')}>
              <span className={c('island')}></span>
              <div className={c('sbar')}>
                <span>9:41</span>
                <span className={c('sig')}>
                  <i></i>
                </span>
              </div>
              <div className={c('ph-push m-push')}>
                <div className={c('push')}>
                  <span className={c('app')}>B</span>
                  <div className={c('bd')}>
                    <div className={c('ph')}>
                      <b>Brigade</b>
                      <span>now</span>
                    </div>
                    <div className={c('pt')}>Sam is waiting on you</div>
                    <div className={c('pb')}>Send 3 replies about the export fix?</div>
                  </div>
                </div>
              </div>
              <div className={c('ph-body')}>
                <div className={c('ph-title')}>
                  Needs you{' '}
                  <span className={c('n xg')}>
                    <span className={c('m-a')}>2</span>
                    <span className={c('m-b')}>1</span>
                  </span>
                </div>
                <div className={c('ticket')}>
                  <div className={c('tk-top')}>
                    <span className={c('dot wait')}></span>Gmail · send
                    <span className={c('sp')}></span>
                    <span className={c('tm')}>now</span>
                  </div>
                  <div className={c('tk-who')}>
                    <span className={c('av sam')}>S</span>
                    <b>Sam wants to send 3 replies</b>
                  </div>
                  <div className={c('tk-meta')}>to jo@northwind.io and 2 more</div>
                  <div className={c('tk-quote')}>
                    Hi Jo, the export button works again. Thanks for telling us.
                  </div>
                  <div className={c('tk-act xg blk-g')}>
                    <div className={c('acts m-a')}>
                      <span className={c('btn pri m-tap')}>Send</span>
                      <span className={c('btn')}>Decline</span>
                    </div>
                    <div className={c('sentline m-b')}>
                      <span className={c('badge ok')}>sent</span>3 replies on their way
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className={c('msg-copy')}>
          <h2 className={c('h2')} id="message-title">
            Message your teammates like your team.
          </h2>
          <p className={c('lead')}>
            Give each job its own thread, from your computer or your phone. Your teammates get on
            with it in the background and come back only when a decision needs you.
          </p>
          <ul className={c('facts')}>
            <li>
              <Icon name="message" />
              <div>
                <b>One thread per job.</b> <span>Write it the way you would to a new hire.</span>
              </div>
            </li>
            <li>
              <Icon name="phone" />
              <div>
                <b>On your computer and your phone.</b>{' '}
                <span>The same threads, wherever you are.</span>
              </div>
            </li>
            <li>
              <Icon name="bell" />
              <div>
                <b>Needs you, in one list.</b>{' '}
                <span>Your phone buzzes only when a decision is yours.</span>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </section>
  )
}

export function Bridge() {
  return (
    <section aria-labelledby="bridge-title" className={c('sec bridge')}>
      <div className={c('wrap')}>
        <div className={c('sec-head')}>
          <h2 className={c('h2')} id="bridge-title">
            One request, every department.
          </h2>
          <div>
            <p className={c('lead')}>
              Your teammates pass the work along, the way a good team does.
            </p>
            <div className={c('cluster')} aria-hidden="true">
              <span className={c('cav av c0')}>R</span>
              <span className={c('cav av mark c1')}>M</span>
              <span className={c('cav av sam c2')}>S</span>
              <span className={c('cpill')}>
                <span className={c('tdots')}>
                  <i></i>
                  <i></i>
                  <i></i>
                </span>
                <span className={c('xg')}>
                  <span className={c('ct t0')}>Sending to Riley…</span>
                  <span className={c('ct t1')}>Asking Mark…</span>
                  <span className={c('ct t2')}>Pinging Sam…</span>
                </span>
              </span>
            </div>
          </div>
        </div>
        <ol className={c('chain')}>
          <li className={c('hand')}>
            <span className={c('glow g0')} aria-hidden="true"></span>
            <div className={c('hand-top')}>
              <span className={c('av sam')}>S</span>
              <span className={c('hand-name')}>Sam</span>
              <span className={c('hand-dept')}>Support</span>
            </div>
            <p className={c('hand-tx')}>Reads a customer email: the export button is broken.</p>
            <div className={c('list')}>
              <div className={c('it')}>
                <span className={c('ico')}>
                  <Icon name="mail" />
                </span>
                <div className={c('tx')}>
                  <div className={c('tt')}>Export does nothing since Monday</div>
                  <div className={c('mt')}>jo@northwind.io</div>
                </div>
              </div>
            </div>
            <span className={c('hand-arrow')} aria-hidden="true">
              <span>
                <Icon name="arrow" />
              </span>
            </span>
          </li>
          <li className={c('hand')}>
            <span className={c('glow g1')} aria-hidden="true"></span>
            <div className={c('hand-top')}>
              <span className={c('av')}>R</span>
              <span className={c('hand-name')}>Riley</span>
              <span className={c('hand-dept')}>Code</span>
            </div>
            <p className={c('hand-tx')}>Fixes it, and you approve the change from your phone.</p>
            <div className={c('list')}>
              <div className={c('it')}>
                <span className={c('ico')}>
                  <Icon name="pr" />
                </span>
                <div className={c('tx')}>
                  <div className={c('tt')}>Fix export button</div>
                  <div className={c('mt')}>tested</div>
                  <span className={c('badge ok')}>approved</span>
                </div>
              </div>
            </div>
            <span className={c('hand-arrow')} aria-hidden="true">
              <span>
                <Icon name="arrow" />
              </span>
            </span>
          </li>
          <li className={c('hand')}>
            <span className={c('glow g2')} aria-hidden="true"></span>
            <div className={c('hand-top')}>
              <span className={c('av mark')}>M</span>
              <span className={c('hand-name')}>Mark</span>
              <span className={c('hand-dept')}>Marketing</span>
            </div>
            <p className={c('hand-tx')}>
              Turns the fix into release notes and a post for your users.
            </p>
            <div className={c('list')}>
              <div className={c('it')}>
                <span className={c('ico')}>
                  <Icon name="list" />
                </span>
                <div className={c('tx')}>
                  <div className={c('tt')}>Release notes</div>
                  <div className={c('mt')}>draft ready</div>
                </div>
              </div>
            </div>
            <span className={c('hand-arrow')} aria-hidden="true">
              <span>
                <Icon name="arrow" />
              </span>
            </span>
          </li>
          <li className={c('hand')}>
            <span className={c('glow g3')} aria-hidden="true"></span>
            <div className={c('hand-top')}>
              <span className={c('av sam')}>S</span>
              <span className={c('hand-name')}>Sam</span>
              <span className={c('hand-dept')}>Sales</span>
            </div>
            <p className={c('hand-tx')}>
              Tells the three accounts who asked about it that it&apos;s fixed.
            </p>
            <div className={c('list wait')}>
              <div className={c('it')}>
                <span className={c('ico w')}>
                  <Icon name="mail" />
                </span>
                <div className={c('tx')}>
                  <div className={c('tt')}>3 emails</div>
                  <div className={c('mt')}>Northwind, Lumen, Acme</div>
                  <span className={c('badge wait')}>waiting on you</span>
                </div>
              </div>
            </div>
          </li>
        </ol>
        <div className={c('rail')} aria-hidden="true">
          <div className={c('rail-line')}></div>
          <div className={c('rail-dots')}>
            <i></i>
            <i></i>
            <i></i>
            <i></i>
          </div>
          <div className={c('mover')}>
            <span className={c('token')}>
              <span className={c('xg')}>
                <span className={c('av xs sam v0')}>S</span>
                <span className={c('av xs v1')}>R</span>
                <span className={c('av xs mark v2')}>M</span>
                <span className={c('av xs sam v3')}>S</span>
              </span>
              Export bug
            </span>
          </div>
        </div>
      </div>
    </section>
  )
}

/** The four tiles, on a band in the dark theme whatever the page's theme. */
export function Tiles() {
  return (
    <section aria-labelledby="tiles-title" className={c('sec tiles dark')}>
      <div className={c('wrap')}>
        <div className={c('sec-head')}>
          <h2 className={c('h2')} id="tiles-title">
            Teammates that work the way you do.
          </h2>
          <p className={c('lead')}>
            They sign in to your tools, learn a task from watching you, keep what your team decided,
            and work on a schedule.
          </p>
        </div>
        <div className={c('tk-grid')}>
          <article className={c('tk')}>
            <div className={c('tk-copy')}>
              <h3>Works in your tools</h3>
              <p>
                Gmail, Stripe, GitHub, Notion and its own browser. On your Mac, any app you have.
              </p>
            </div>
            <div className={c('demo')} aria-hidden="true">
              <div className={c('comp')}>
                <div className={c('comp-h')}>
                  <b>Computer</b>
                  <span className={c('xg end')}>
                    <span className={c('badge run ta-a')}>working</span>
                    <span className={c('badge wait ta-b')}>you&apos;re in control</span>
                  </span>
                </div>
                <div className={c('comp-sub')}>
                  Sign in to Gmail so I can work the support inbox.
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
                      <span>mail.google.com</span>
                    </div>
                    <div className={c('win-b xg blk-g')}>
                      <div className={c('inbox ta-a')}>
                        <div className={c('ir')}>
                          <span className={c('d')}></span>
                          <b>Where is my invoice?</b>
                          <span>jo@northwind.io</span>
                        </div>
                        <div className={c('ir')}>
                          <span className={c('d')}></span>
                          <b>Export does nothing</b>
                          <span>tom@lumen.co</span>
                        </div>
                        <div className={c('ir')}>
                          <b>How do I add a seat?</b>
                          <span>mei@acme.com</span>
                        </div>
                        <div className={c('ir')}>
                          <b>Refund for October</b>
                          <span>ines@fieldwork.io</span>
                        </div>
                      </div>
                      <div className={c('signin ta-b')}>
                        <div className={c('si-t')}>Sign in to continue</div>
                        <div className={c('sfld')}>sam@acme.com</div>
                        <div className={c('sfld')}>••••••••••</div>
                        <div className={c('btn-c ta-btn')}>Continue</div>
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
              <h3>Show it once</h3>
              <p>
                With Teach a task, do the job once while it watches. It writes down the steps and
                does it from then on.
              </p>
            </div>
            <div className={c('demo')} aria-hidden="true">
              <div className={c('rec2')}>
                <div className={c('rec-bar xg blk-g')}>
                  <div className={c('rb tb-a')}>
                    <span>Riley is watching and learning</span>
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
                    Send the week&apos;s numbers<span className={c('k')}>Riley · to #founders</span>
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
