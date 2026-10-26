import type { CSSProperties } from 'react'
import { ProviderLogo, type ProviderKind } from '@/components/provider-logo'
import { c, Icon } from './parts'

type Tile = {
  kind: ProviderKind | 'github'
  name: string
  x: string
  y: string
  path: string
  glow?: string
}

// The Apps on a wide oval around the thread, each with a dotted path to it (in the stage's
// 1168×640 box, ending under the thread's card). The four the use case calls glow in turn and
// send a pulse down their path, one class per step (g0 to g3).
const tiles: Tile[] = [
  {
    kind: 'google_calendar',
    name: 'Google Calendar',
    x: '37.2%',
    y: '8%',
    path: 'M435 51 C491 51 547 152 547 253',
  },
  { kind: 'linear', name: 'Linear', x: '62.8%', y: '8%', path: 'M733 51 C677 51 621 152 621 253' },
  {
    kind: 'google_sheets',
    name: 'Google Sheets',
    x: '84.3%',
    y: '21.3%',
    path: 'M985 137 C834 137 684 205 684 274',
  },
  {
    kind: 'stripe',
    name: 'Stripe',
    x: '94.9%',
    y: '43.8%',
    path: 'M1109 280 C912 280 715 295 715 310',
  },
  {
    kind: 'mixpanel',
    name: 'Mixpanel',
    x: '91.3%',
    y: '68.2%',
    path: 'M1066 436 C885 436 705 393 705 349',
  },
  {
    kind: 'github',
    name: 'GitHub',
    x: '74.5%',
    y: '86.8%',
    path: 'M871 556 C763 556 656 467 656 379',
    glow: 'g1',
  },
  {
    kind: 'posthog',
    name: 'PostHog',
    x: '50%',
    y: '93.8%',
    path: 'M584 600 C584 600 584 495 584 390',
    glow: 'g3',
  },
  {
    kind: 'supabase',
    name: 'Supabase',
    x: '25.5%',
    y: '86.8%',
    path: 'M297 556 C405 556 512 467 512 379',
  },
  {
    kind: 'google_drive',
    name: 'Google Drive',
    x: '8.7%',
    y: '68.2%',
    path: 'M102 436 C283 436 463 393 463 349',
    glow: 'g2',
  },
  {
    kind: 'notion',
    name: 'Notion',
    x: '5.1%',
    y: '43.8%',
    path: 'M59 280 C256 280 453 295 453 310',
  },
  {
    kind: 'gmail',
    name: 'Gmail',
    x: '15.7%',
    y: '21.3%',
    path: 'M183 137 C334 137 484 205 484 274',
    glow: 'g0',
  },
]

const steps = [
  { kind: 'gmail', cls: 'ap-step ap1', text: "Found Jo's request for CSV export" },
  { kind: 'github', cls: 'ap-step ap2', text: 'Merged #214 · CSV export on Reports' },
  { kind: 'google_drive', cls: 'ap-step ap3', text: 'Saved a 30-second demo to Drive' },
  { kind: 'posthog', cls: 'ap-step ap4', text: '4 accounts exported a CSV in the first hour' },
] as const

function Logo({ kind }: { kind: Tile['kind'] }) {
  return kind === 'github' ? <Icon name="github" /> : <ProviderLogo kind={kind} />
}

/** An App mentioned in a message, as the composer shows it: its logo and its name. */
function Mention({ kind, name }: { kind: ProviderKind; name: string }) {
  return (
    <span className={c('ap-men')}>
      <ProviderLogo kind={kind} />
      {name}
    </span>
  )
}

/** Apps: the tools teammates work in, around a thread whose request (a customer's feature,
 * shipped and announced) uses four of them. Its
 * four steps are there from the start, greyed, and tick off as each App sends its pulse. */
export function Apps() {
  return (
    <section aria-labelledby="apps-title" className={c('sec apps-sec')} data-anim>
      <div className={c('wrap')}>
        <div className={c('sec-head c apps-head')}>
          <h2 className={c('h2')} id="apps-title">
            Plugged into your stack.
          </h2>
          <p className={c('lead')}>
            Connect Gmail, GitHub, Google Drive, PostHog and more once. Ask in a message, and your
            teammate works across them for you, from the code to the customer.
          </p>
        </div>

        <div className={c('apps-stage')} aria-hidden="true">
          <svg className={c('ap-paths')} viewBox="0 0 1168 640" preserveAspectRatio="none">
            {tiles.map((t) => (
              <path key={t.kind} d={t.path} pathLength={100} />
            ))}
            {tiles.map((t) =>
              t.glow ? (
                <path
                  key={t.kind}
                  className={c(`ap-pulse ${t.glow}`)}
                  d={t.path}
                  pathLength={100}
                />
              ) : null,
            )}
          </svg>
          {tiles.map((t) => (
            <span
              key={t.kind}
              className={c(t.glow ? `app-t ${t.glow}` : 'app-t')}
              style={{ '--x': t.x, '--y': t.y } as CSSProperties}
              title={t.name}
            >
              <span className={c('app-i')}>
                <Logo kind={t.kind} />
              </span>
            </span>
          ))}

          <div className={c('ap-chat')}>
            <div className={c('ap-head')}>
              <span className={c('av xs sam')}>S</span>
              <b>Sam</b>
              <span className={c('ap-state')}>
                <span className={c('dot run')}></span>
                working
              </span>
            </div>
            <div className={c('ap-msg ap-me')}>
              <span className={c('av xs')}>A</span>
              <span>
                Jo at Northwind asked for CSV export in <Mention kind="gmail" name="Gmail" />. Build
                it, save a short demo to <Mention kind="google_drive" name="Google Drive" />, send
                it to Jo, and tell me how it&apos;s used in{' '}
                <Mention kind="posthog" name="PostHog" />.
              </span>
            </div>
            <div className={c('ap-steps')}>
              {steps.map((s) => (
                <div key={s.kind} className={c(s.cls)}>
                  <Logo kind={s.kind} />
                  <span>{s.text}</span>
                  <span className={c('ap-ok')}>
                    <Icon name="check" />
                  </span>
                </div>
              ))}
            </div>
            <div className={c('ap-msg ap5')}>
              <span className={c('av xs sam')}>S</span>
              <span>
                CSV export is live and Jo has the demo. Four accounts used it already. Want me to
                post the demo for your other users?
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
