import { Faq, Footer, Pricing } from '@/components/landing/closing'
import { AuthLink } from '@/components/landing/auth-link'
import { Header } from '@/components/landing/hero'
import { c, Icon, SIGN_UP } from '@/components/landing/parts'
import { pageMetadata } from '@/lib/page-metadata'

// The plans side by side, compared line by line, and the questions people ask before paying.
// Every line is what the product does today (docs/billing.md, apps/docs/billing.mdx): check it
// against the code before changing it.

export const dynamic = 'force-static'
export const revalidate = false

const title = 'Pricing · Brigade'
const description =
  'Brigade is free on your own computer. Starter, $15 a month, gives your AI teammates a cloud computer for 100 hours a month; Max, $99 a month, has no hour limit. AI usage stays on your own Claude or ChatGPT plan.'

export const metadata = pageMetadata('/pricing', title, description)

/** A cell: a word, or yes / no as a mark. */
type Cell = string | boolean

/** The plans' columns, Starter's softly tinted as its card above is featured. */
const COLUMNS = [
  { name: 'Free', price: '$0', cta: 'Sign up' },
  { name: 'Starter', price: '$15/mo', cta: 'Get Starter', featured: true },
  { name: 'Max', price: '$99/mo', cta: 'Get Max' },
] as const

/** The comparison, Free, Starter and Max in that order. */
/** `strong`: what sets the plans apart, in bold. */
const ROWS: { label: string; cells: [Cell, Cell, Cell]; strong?: boolean }[] = [
  { label: 'Teammates, threads and members', cells: ['Unlimited', 'Unlimited', 'Unlimited'] },
  { label: 'Claude or ChatGPT usage', cells: ['Your own plan', 'Your own plan', 'Your own plan'] },
  { label: 'Cloud computer', cells: [false, '100 h a month', 'Unlimited'], strong: true },
  { label: 'Works with your laptop closed', cells: [false, true, true] },
  { label: 'Schedules and triggers', cells: ['While you’re on', 'Any hour', 'Any hour'] },
  { label: 'Website logins from Secrets', cells: [false, true, true] },
  { label: 'An email address per teammate', cells: [false, true, true] },
  { label: 'Dictation', cells: [false, true, true] },
  { label: 'Support', cells: ['Email', 'Email', 'Priority'] },
  { label: 'Open source (MIT)', cells: [true, true, true] },
]

/** The questions asked before paying: shown below, and given to search engines as an FAQPage. */
const QUESTIONS: { q: string; a: string }[] = [
  {
    q: 'What counts as a cloud hour?',
    a: 'An hour counts while the cloud computer is on. It goes to sleep 30 minutes after your teammates finish their work, and wakes as soon as they have more.',
  },
  {
    q: 'What happens after Starter’s 100 hours?',
    a: 'The cloud computer sleeps until your billing period starts over, and your teammates’ cloud work waits for it. Email and the rest of your workspace keep working, and a card in the sidebar warns you from 80 hours. Upgrade to Max at any time to lift the limit.',
  },
  {
    q: 'Can I change plans or cancel?',
    a: 'Yes. Upgrade from Starter to Max in Settings, Billing: Stripe charges the difference for the rest of the period. Cancel at any time; the plan runs until the end of the period you paid for.',
  },
  {
    q: 'Do you charge for AI usage?',
    a: 'No, on any plan. Your teammates run the official Claude Code or Codex on the Claude or ChatGPT plan you already pay for.',
  },
  {
    q: 'Is the price per person?',
    a: 'No, per workspace. Members, teammates and threads are unlimited on every plan.',
  },
  {
    q: 'Can I pay in euros?',
    a: 'Yes: Starter is €15 and Max €99 a month in the euro zone. Stripe Checkout shows the price in your currency.',
  },
]

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: QUESTIONS.map(({ q, a }) => ({
    '@type': 'Question',
    name: q,
    acceptedAnswer: { '@type': 'Answer', text: a },
  })),
}

function CellView({ cell }: { cell: Cell }) {
  if (cell === true)
    return (
      <span className={c('pt-yes')} role="img" aria-label="Included">
        <Icon name="check" />
      </span>
    )
  if (cell === false)
    return (
      <span className={c('pt-no')} role="img" aria-label="Not included">
        –
      </span>
    )
  return <span>{cell}</span>
}

/** Free, Starter and Max compared line by line, with the way to each at the foot. */
function CompareTable() {
  const tint = (i: number) => c('featured' in COLUMNS[i]! ? 'pt-plan pt-tint' : 'pt-plan')
  return (
    <div className={c('pt-wrap')}>
      <table className={c('pt')}>
        <thead>
          <tr>
            <th scope="col">
              <span className={c('sr-only')}>Feature</span>
            </th>
            {COLUMNS.map((col, i) => (
              <th key={col.name} scope="col" className={tint(i)}>
                <span className={c('pt-name')}>{col.name}</span>
                <span className={c('pt-price')}>{col.price}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={row.label} className={c(row.strong ? 'pt-strong' : '')}>
              <th scope="row">{row.label}</th>
              {row.cells.map((cell, i) => (
                <td key={COLUMNS[i]!.name} className={tint(i)}>
                  <CellView cell={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">
              <span className={c('sr-only')}>Get started</span>
            </th>
            {COLUMNS.map((col, i) => (
              <td key={col.name} className={tint(i)}>
                <AuthLink className={c('featured' in col ? 'btn pri' : 'btn')} href={SIGN_UP}>
                  {col.cta}
                </AuthLink>
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

export default function PricingPage() {
  return (
    <div className={c('page')}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }}
      />
      <Header />
      <main>
        <Pricing />
        <section aria-labelledby="compare-title" className={c('sec pt-sec')}>
          <div className={c('wrap')}>
            <h2 className={c('h2 pt-title')} id="compare-title">
              Compare plans
            </h2>
            <CompareTable />
          </div>
        </section>
        <Faq items={QUESTIONS} title="Billing questions" />
      </main>
      <Footer />
    </div>
  )
}
