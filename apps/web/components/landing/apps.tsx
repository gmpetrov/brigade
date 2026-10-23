import type { CSSProperties } from 'react'
import { ProviderLogo, type ProviderKind } from '@/components/provider-logo'
import { c, Icon } from './parts'

type Tile = { kind: ProviderKind | 'github'; name: string; x: string; y: string; glow?: string }

// Around the chat: the Apps the use case calls glow in turn, one class per step (g0 to g3).
const tiles: Tile[] = [
  { kind: 'google_calendar', name: 'Google Calendar', x: '4%', y: '10%', glow: 'g0' },
  { kind: 'gmail', name: 'Gmail', x: '13%', y: '42%', glow: 'g1' },
  { kind: 'notion', name: 'Notion', x: '3%', y: '74%' },
  { kind: 'google_drive', name: 'Google Drive', x: '17%', y: '86%' },
  { kind: 'linear', name: 'Linear', x: '18%', y: '4%' },
  { kind: 'stripe', name: 'Stripe', x: '84%', y: '12%', glow: 'g2' },
  { kind: 'mixpanel', name: 'Mixpanel', x: '90%', y: '44%', glow: 'g3' },
  { kind: 'github', name: 'GitHub', x: '79%', y: '84%' },
  { kind: 'posthog', name: 'PostHog', x: '94%', y: '76%' },
  { kind: 'google_sheets', name: 'Google Sheets', x: '77%', y: '0%' },
]

// Every App Brigade has built in (apps/api/src/connectors/index.ts).
const names = [
  'Gmail',
  'Google Calendar',
  'Google Drive',
  'Google Docs',
  'Google Sheets',
  'Google Analytics',
  'Search Console',
  'Stripe',
  'GitHub',
  'Linear',
  'Notion',
  'Jira & Confluence',
  'Mixpanel',
  'PostHog',
  'Supabase',
  'Neon',
  'Cloudflare',
  'Google Cloud',
  'Resend',
  'Replicate',
  'OpenRouter',
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

/** Apps: the tools teammates work in, and one request that uses four of them. */
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
          {tiles.map((t) => (
            <span
              key={t.kind}
              className={c(t.glow ? `app-t ${t.glow}` : 'app-t')}
              style={{ '--x': t.x, '--y': t.y } as CSSProperties}
              title={t.name}
            >
              <Logo kind={t.kind} />
            </span>
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

        <p className={c('apps-list')}>
          {names.join(' · ')}
          <span> · and a custom App for any service that sends webhooks</span>
        </p>
      </div>
    </section>
  )
}
