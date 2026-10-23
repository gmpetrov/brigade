import type { CSSProperties } from 'react'
import { ProviderLogo, type ProviderKind } from '@/components/provider-logo'
import { c, Icon } from './parts'

type Tile = { kind: ProviderKind | 'github'; name: string; angle: string; glow?: string }

// Two rings that turn slowly around the chat. The Apps the use case calls sit on the
// inner one and glow in turn, one class per step (g0 to g3).
const inner: Tile[] = [
  { kind: 'google_calendar', name: 'Google Calendar', angle: '-150deg', glow: 'g0' },
  { kind: 'gmail', name: 'Gmail', angle: '160deg', glow: 'g1' },
  { kind: 'stripe', name: 'Stripe', angle: '-30deg', glow: 'g2' },
  { kind: 'mixpanel', name: 'Mixpanel', angle: '20deg', glow: 'g3' },
  { kind: 'notion', name: 'Notion', angle: '90deg' },
]
const outer: Tile[] = [
  { kind: 'linear', name: 'Linear', angle: '-110deg' },
  { kind: 'google_sheets', name: 'Google Sheets', angle: '-60deg' },
  { kind: 'github', name: 'GitHub', angle: '0deg' },
  { kind: 'posthog', name: 'PostHog', angle: '55deg' },
  { kind: 'google_drive', name: 'Google Drive', angle: '125deg' },
  { kind: 'supabase', name: 'Supabase', angle: '185deg' },
]

const steps = [
  {
    kind: 'google_calendar',
    cls: 'ap-step ap1',
    text: 'Found Thursday 10:00 with jo@northwind.io',
  },
  { kind: 'gmail', cls: 'ap-step ap2', text: 'Read the last 6 emails with Jo' },
  { kind: 'stripe', cls: 'ap-step ap3', text: 'Northwind is on Pro, renews in 3 weeks' },
  { kind: 'mixpanel', cls: 'ap-step ap4', text: 'Their usage is up 32% this month' },
] as const

function Logo({ kind }: { kind: Tile['kind'] }) {
  return kind === 'github' ? <Icon name="github" /> : <ProviderLogo kind={kind} />
}

/** Apps: the tools teammates work in, on two rings around one request that uses four of them. */
export function Apps() {
  return (
    <section aria-labelledby="apps-title" className={c('sec apps-sec')} data-anim>
      <div className={c('wrap')}>
        <div className={c('sec-head c apps-head')}>
          <h2 className={c('h2')} id="apps-title">
            Plugged into your stack.
          </h2>
          <p className={c('lead')}>
            Connect Gmail, Google Calendar, Stripe, Mixpanel and more once. Ask in a message, and
            your teammate pulls from each of them for you.
          </p>
        </div>

        <div className={c('apps-stage')} aria-hidden="true">
          {[
            { cls: 'orbit o1', tiles: inner },
            { cls: 'orbit o2', tiles: outer },
          ].map((ring) => (
            <div key={ring.cls} className={c(ring.cls)}>
              {ring.tiles.map((t) => (
                <span
                  key={t.kind}
                  className={c(t.glow ? `app-t ${t.glow}` : 'app-t')}
                  style={{ '--a': t.angle } as CSSProperties}
                  title={t.name}
                >
                  <span className={c('app-i')}>
                    <Logo kind={t.kind} />
                  </span>
                </span>
              ))}
            </div>
          ))}

          <div className={c('ap-chat')}>
            <div className={c('ap-msg ap-me ap0')}>
              <span className={c('av xs')}>A</span>
              Prep me for tomorrow&apos;s call with Northwind.
            </div>
            <div className={c('ap-steps')}>
              {steps.map((s) => (
                <div key={s.kind} className={c(s.cls)}>
                  <ProviderLogo kind={s.kind} />
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
                Your brief is ready. Northwind is growing fast, asked about SSO twice, and renews in
                3 weeks. Want me to draft the agenda?
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
