import type { CSSProperties } from 'react'
import { JobTabs, type Job } from './job-tabs'
import { c, Icon } from './parts'

const jobs: Job[] = [
  {
    id: 'support',
    tab: (
      <>
        <span className={c('av sam')}>S</span>Support inbox
      </>
    ),
    panel: (
      <>
        <div className={c('pn-copy')}>
          <div className={c('pn-who')}>
            <span className={c('av sam')}>S</span>Sam <span className={c('k')}>· Support</span>
          </div>
          <h3>
            Sam sorts every support email and drafts the answers your docs already cover. It asks
            before it sends.
          </h3>
          <div className={c('apps')}>
            <span className={c('tile sm')}>G</span>
            <span className={c('tile sm')}>N</span>Gmail · Notion help center
          </div>
        </div>
        <div className={c('pn-art orange')} aria-hidden="true">
          <div className={c('shot')}>
            <div className={c('shot-h pi i0')}>
              <span className={c('av sam')}>S</span>
              <b>Support inbox</b>
              <span className={c('sp')}></span>
              <span className={c('meta')}>today</span>
            </div>
            <div className={c('list')}>
              <div className={c('it pi i1')}>
                <span className={c('ico')}>
                  <Icon name="mail" />
                </span>
                <div className={c('tx')}>
                  <div className={c('tt')}>Where is my invoice?</div>
                  <div className={c('mt')}>jo@northwind.io · answer drafted from your docs</div>
                </div>
                <span className={c('badge wait')}>waiting</span>
              </div>
              <div className={c('it pi i2')}>
                <span className={c('ico')}>
                  <Icon name="pr" />
                </span>
                <div className={c('tx')}>
                  <div className={c('tt')}>Login loop after password reset</div>
                  <div className={c('mt')}>Bug · passed to Riley</div>
                </div>
                <span className={c('badge run')}>working</span>
              </div>
              <div className={c('it pi i3')}>
                <span className={c('ico')}>
                  <Icon name="mail" />
                </span>
                <div className={c('tx')}>
                  <div className={c('tt')}>How do I add a seat?</div>
                  <div className={c('mt')}>mei@lumen.co · sent after your yes</div>
                </div>
                <span className={c('badge ok')}>answered</span>
              </div>
            </div>
          </div>
        </div>
      </>
    ),
  },
  {
    id: 'bugs',
    tab: (
      <>
        <span className={c('av')}>R</span>Bug fixes
      </>
    ),
    panel: (
      <>
        <div className={c('pn-copy')}>
          <div className={c('pn-who')}>
            <span className={c('av')}>R</span>Riley <span className={c('k')}>· Code</span>
          </div>
          <h3>
            Describe the bug in a sentence. Riley fixes it, shows you the change in a live preview
            and waits for your approval.
          </h3>
          <div className={c('apps')}>
            <span className={c('tile sm')}>GH</span>
            <span className={c('tile sm')}>L</span>GitHub · Linear
          </div>
        </div>
        <div className={c('pn-art violet')} aria-hidden="true">
          <div className={c('shot convo')}>
            <div className={c('me pi i0')}>The signup button does nothing on Safari.</div>
            <div className={c('mm pi i1')}>
              <span className={c('av')}>R</span>
              <div className={c('tx')}>
                <div className={c('who')}>Riley</div>
                <p>Reproduced it. The click handler runs before the form loads.</p>
              </div>
            </div>
            <div className={c('steps-l pi i2')}>
              <div className={c('st')}>
                → fixed signup-form.tsx{' '}
                <span className={c('ok-i')}>
                  <Icon name="check" />
                </span>
              </div>
              <div className={c('st')}>
                → checked in Safari and Chrome{' '}
                <span className={c('ok-i')}>
                  <Icon name="check" />
                </span>
              </div>
            </div>
            <div className={c('appr pi i3')}>
              <span className={c('av')}>R</span>
              <div className={c('tx')}>
                <div className={c('o')}>Needs you</div>
                <div className={c('tt')}>
                  Riley wants to ship <span className={c('k')}>· Fix Safari signup</span>
                </div>
              </div>
              <span className={c('btn sm pri')}>Approve</span>
            </div>
          </div>
        </div>
      </>
    ),
  },
  {
    id: 'release',
    tab: (
      <>
        <span className={c('av mark')}>M</span>Release notes
      </>
    ),
    panel: (
      <>
        <div className={c('pn-copy')}>
          <div className={c('pn-who')}>
            <span className={c('av mark')}>M</span>Mark <span className={c('k')}>· Marketing</span>
          </div>
          <h3>Every Friday, Mark turns what shipped into release notes your customers can read.</h3>
          <div className={c('apps')}>
            <span className={c('tile sm')}>GH</span>
            <span className={c('tile sm')}>N</span>GitHub · Notion
          </div>
        </div>
        <div className={c('pn-art green')} aria-hidden="true">
          <div className={c('shot doc')}>
            <div className={c('shot-h pi i0')}>
              <span className={c('av mark')}>M</span>
              <b>Draft · Week 43</b>
              <span className={c('sp')}></span>
              <span className={c('badge wait')}>waiting</span>
            </div>
            <div className={c('dt pi i1')}>
              Exports work again, and invoices round the way your accountant expects.
            </div>
            <ul>
              <li className={c('pi i2')}>
                <span>
                  <b>Export button.</b> Reports download as CSV again in every browser.
                </span>
              </li>
              <li className={c('pi i3')}>
                <span>
                  <b>Invoice rounding.</b> Totals now match Stripe to the cent.
                </span>
              </li>
              <li className={c('pi i4')}>
                <span>
                  <b>Faster search.</b> Results show as you type.
                </span>
              </li>
            </ul>
            <div className={c('conn pi i5')} style={{ margin: '12px 0 6px' } as CSSProperties}>
              <span className={c('diff')}>from 6 merged pull requests</span>
            </div>
          </div>
        </div>
      </>
    ),
  },
  {
    id: 'leads',
    tab: (
      <>
        <span className={c('av sam')}>S</span>Lead follow-ups
      </>
    ),
    panel: (
      <>
        <div className={c('pn-copy')}>
          <div className={c('pn-who')}>
            <span className={c('av sam')}>S</span>Sam <span className={c('k')}>· Sales</span>
          </div>
          <h3>
            Leads who went quiet get a follow-up drafted from your last conversation, ready for your
            yes.
          </h3>
          <div className={c('apps')}>
            <span className={c('tile sm')}>G</span>
            <span className={c('tile sm')}>H</span>Gmail · HubSpot
          </div>
        </div>
        <div className={c('pn-art tint')} aria-hidden="true">
          <div className={c('shot')}>
            <div className={c('shot-h pi i0')}>
              <b>Quiet for 7 days</b>
              <span className={c('sp')}></span>
              <span className={c('meta')}>Sam · 3 drafts</span>
            </div>
            <div className={c('list wait')}>
              <div className={c('it pi i1')}>
                <span className={c('ico w')}>
                  <Icon name="mail" />
                </span>
                <div className={c('tx')}>
                  <div className={c('tt')}>Priya · Lumen</div>
                  <div className={c('mt')}>Asked about annual billing · follow-up drafted</div>
                </div>
                <span className={c('btn sm')}>Review</span>
              </div>
              <div className={c('it pi i2')}>
                <span className={c('ico w')}>
                  <Icon name="mail" />
                </span>
                <div className={c('tx')}>
                  <div className={c('tt')}>Tom · Northwind</div>
                  <div className={c('mt')}>Trial ends Friday · follow-up drafted</div>
                </div>
                <span className={c('btn sm')}>Review</span>
              </div>
              <div className={c('it pi i3')}>
                <span className={c('ico w')}>
                  <Icon name="mail" />
                </span>
                <div className={c('tx')}>
                  <div className={c('tt')}>Ines · Fieldwork</div>
                  <div className={c('mt')}>Wanted a demo · follow-up drafted</div>
                </div>
                <span className={c('btn sm')}>Review</span>
              </div>
            </div>
            <div style={{ height: '8px' } as CSSProperties}></div>
          </div>
        </div>
      </>
    ),
  },
  {
    id: 'numbers',
    tab: (
      <>
        <span className={c('av')}>R</span>Weekly numbers
      </>
    ),
    panel: (
      <>
        <div className={c('pn-copy')}>
          <div className={c('pn-who')}>
            <span className={c('av')}>R</span>Riley <span className={c('k')}>· Operations</span>
          </div>
          <h3>
            Revenue, refunds and signups on one page every Monday, posted where your team reads it.
          </h3>
          <div className={c('apps')}>
            <span className={c('tile sm')}>S</span>
            <span className={c('tile sm')}>#</span>Stripe · Slack
          </div>
        </div>
        <div className={c('pn-art ink')} aria-hidden="true">
          <div className={c('shot')}>
            <div className={c('shot-h pi i0')}>
              <b>Week 43</b>
              <span className={c('sp')}></span>
              <span className={c('meta')}>Mon 09:00 · #founders</span>
            </div>
            <div className={c('stats')}>
              <div className={c('stat pi i1')}>
                <div className={c('l')}>Revenue</div>
                <div className={c('v')}>$18,420</div>
                <div className={c('d')}>+6.1%</div>
              </div>
              <div className={c('stat pi i2')}>
                <div className={c('l')}>Refunds</div>
                <div className={c('v')}>$318</div>
                <div className={c('d dn')}>+1</div>
              </div>
              <div className={c('stat pi i3')}>
                <div className={c('l')}>Signups</div>
                <div className={c('v')}>142</div>
                <div className={c('d')}>+12%</div>
              </div>
            </div>
            <div className={c('bars pi i4')}>
              <i style={{ height: '40%' } as CSSProperties}></i>
              <i style={{ height: '52%' } as CSSProperties}></i>
              <i style={{ height: '46%' } as CSSProperties}></i>
              <i style={{ height: '60%' } as CSSProperties}></i>
              <i style={{ height: '58%' } as CSSProperties}></i>
              <i style={{ height: '72%' } as CSSProperties}></i>
              <i className={c('on')} style={{ height: '84%' } as CSSProperties}></i>
            </div>
          </div>
        </div>
      </>
    ),
  },
  {
    id: 'competitors',
    tab: (
      <>
        <span className={c('av mark')}>M</span>Competitor watch
      </>
    ),
    panel: (
      <>
        <div className={c('pn-copy')}>
          <div className={c('pn-who')}>
            <span className={c('av mark')}>M</span>Mark <span className={c('k')}>· Marketing</span>
          </div>
          <h3>
            What your competitors changed on their site and pricing, every week, with links to
            check.
          </h3>
          <div className={c('apps')}>
            <Icon name="globe" style={{ width: '14px', height: '14px' } as CSSProperties} />
            Its own browser
          </div>
        </div>
        <div className={c('pn-art green')} aria-hidden="true">
          <div className={c('shot')}>
            <div className={c('shot-h pi i0')}>
              <span className={c('av mark')}>M</span>
              <b>Competitor watch</b>
              <span className={c('sp')}></span>
              <span className={c('meta')}>this week</span>
            </div>
            <div className={c('list')}>
              <div className={c('it pi i1')}>
                <span className={c('ico')}>
                  <Icon name="globe" />
                </span>
                <div className={c('tx')}>
                  <div className={c('tt')}>Relaydesk raised its Team plan</div>
                  <div className={c('mt')}>relaydesk.com/pricing</div>
                </div>
                <span className={c('diff')}>$49 → $59</span>
              </div>
              <div className={c('it pi i2')}>
                <span className={c('ico')}>
                  <Icon name="globe" />
                </span>
                <div className={c('tx')}>
                  <div className={c('tt')}>Opsly launched a Slack app</div>
                  <div className={c('mt')}>opsly.io/changelog</div>
                </div>
                <span className={c('diff')}>new</span>
              </div>
              <div className={c('it pi i3')}>
                <span className={c('ico')}>
                  <Icon name="globe" />
                </span>
                <div className={c('tx')}>
                  <div className={c('tt')}>Taskhand removed its free plan</div>
                  <div className={c('mt')}>taskhand.ai/pricing</div>
                </div>
                <span className={c('diff')}>removed</span>
              </div>
            </div>
            <div style={{ height: '8px' } as CSSProperties}></div>
          </div>
        </div>
      </>
    ),
  },
]

export function Jobs() {
  return (
    <section className={c('sec jobs')} aria-labelledby="jobs-title">
      <div className={c('wrap')}>
        <div className={c('sec-head')}>
          <h2 className={c('h2')} id="jobs-title">
            Give each teammate a job.
          </h2>
          <p className={c('lead')}>
            If you can explain the job to a new hire, you can give it to a teammate.
          </p>
        </div>
        <JobTabs jobs={jobs} />
        <div className={c('more')}>
          <div className={c('more-h')}>
            <h3>And more you can hand off</h3>
            <span>A few of the jobs teams give their teammates.</span>
          </div>
          <div className={c('groups')}>
            <section>
              <h4 className={c('group-l')}>
                <span className={c('group-dot')}></span>Build
              </h4>
              <ul>
                <li>
                  <b>Bug fixes</b>A bug a customer reports becomes a tested fix waiting for your
                  approval
                </li>
                <li>
                  <b>Release check</b>Each new version clicked through like a customer would, with
                  screenshots
                </li>
                <li>
                  <b>Ticket cleanup</b>Duplicate tickets merged and every bug given an owner
                </li>
                <li>
                  <b>Product questions</b>“Why did signups drop on Tuesday?” answered from your
                  analytics
                </li>
              </ul>
            </section>
            <section>
              <h4 className={c('group-l')}>
                <span className={c('group-dot orange')}></span>Support
              </h4>
              <ul>
                <li>
                  <b>Support inbox</b>Every support email sorted, and the routine ones answered from
                  your docs once you say yes
                </li>
                <li>
                  <b>Inbox triage</b>The overnight inbox is sorted, with what needs you on top
                </li>
                <li>
                  <b>Help center</b>Help pages updated when the product changes
                </li>
              </ul>
            </section>
            <section>
              <h4 className={c('group-l')}>
                <span className={c('group-dot green')}></span>Marketing
              </h4>
              <ul>
                <li>
                  <b>Release notes</b>What shipped this week, rewritten in plain words for customers
                </li>
                <li>
                  <b>Competitor watch</b>What your competitors changed on their site and pricing,
                  every week
                </li>
                <li>
                  <b>Customer research</b>What people say about you on Reddit and in reviews, with
                  links
                </li>
                <li>
                  <b>Search traffic</b>Pages losing Google traffic get flagged and explained every
                  week
                </li>
              </ul>
            </section>
            <section>
              <h4 className={c('group-l')}>
                <span className={c('group-dot ink')}></span>Sales
              </h4>
              <ul>
                <li>
                  <b>Lead follow-ups</b>Leads who went quiet get a follow-up drafted for your yes
                </li>
                <li>
                  <b>Meeting prep</b>Each of tomorrow&apos;s meetings gets a one-page brief from
                  your email and files
                </li>
              </ul>
            </section>
            <section>
              <h4 className={c('group-l')}>
                <span className={c('group-dot blue')}></span>Operations
              </h4>
              <ul>
                <li>
                  <b>Invoice reminders</b>Overdue Stripe invoices get a polite reminder every
                  morning
                </li>
                <li>
                  <b>Failed payments</b>Customers with a failed card hear from you before they churn
                </li>
                <li>
                  <b>Weekly numbers</b>Revenue, refunds and signups on one page every Monday
                </li>
                <li>
                  <b>Spreadsheet upkeep</b>Your sheets updated from Stripe and your database every
                  evening
                </li>
                <li>
                  <b>Mac chores</b>Keynote, Finder and any app on your Mac, used for you while you
                  watch
                </li>
                <li>
                  <b>Your own job</b>Show it once with Teach a task, and it runs on schedule from
                  then on
                </li>
              </ul>
            </section>
          </div>
        </div>
      </div>
    </section>
  )
}
