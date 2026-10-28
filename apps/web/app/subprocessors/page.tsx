import Link from 'next/link'
import { LegalPage, legalMetadata } from '@/components/landing/legal'
import { OPERATOR } from '@/components/landing/operator'

export const dynamic = 'force-static'
export const revalidate = false

export const metadata = legalMetadata(
  '/subprocessors',
  'Subprocessors · Brigade',
  'The companies that process data for Brigade, what each does, and where.',
)

/** Each one the code sends workspace or account data to (check it when adding a service). */
const SUBPROCESSORS = [
  {
    name: 'Cloudflare, Inc.',
    does: 'Runs Brigade (Workers, Durable Objects, D1), stores files (R2), DNS, bot checks (Turnstile)',
    where: 'Global network; company in the United States',
  },
  { name: 'Neon (Databricks, Inc.)', does: 'Database', where: 'EU (Frankfurt, on AWS)' },
  {
    name: 'Boat',
    does: 'Cloud computers of workspaces with Brigade Cloud',
    where: 'EU (Germany, Finland or France)',
  },
  { name: 'Resend, Inc.', does: 'Sending and receiving email', where: 'United States' },
  {
    name: 'Stripe Payments Europe, Ltd.',
    does: 'Payments, invoices',
    where: 'Ireland, and the United States',
  },
  {
    name: 'Google LLC',
    does: 'Sign in with Google; Gmail notifications for connected Google Apps',
    where: 'United States',
  },
  { name: 'GitHub, Inc.', does: 'Repository access, when connected', where: 'United States' },
  {
    name: 'Apple, Google and Mozilla push services',
    does: 'Delivering the notifications a member turned on',
    where: 'United States',
  },
]

export default function Subprocessors() {
  return (
    <LegalPage title="Subprocessors">
      <p>
        These companies process data for Brigade, under contracts that protect it as our{' '}
        <Link href="/dpa">data processing agreement</Link> requires. Transfers to the United States
        rely on the EU-US Data Privacy Framework or the European Commission&apos;s standard
        contractual clauses.
      </p>
      <ul>
        {SUBPROCESSORS.map((s) => (
          <li key={s.name}>
            <strong>{s.name}:</strong> {s.does}. {s.where}.
          </li>
        ))}
      </ul>

      <h2>Not ours: your AI provider</h2>
      <p>
        Teammates run on Claude Code or Codex, signed in with each member&apos;s own Anthropic or
        OpenAI account. What they read and write goes to that provider under the member&apos;s own
        agreement with it, not through Brigade. The same goes for the Apps you connect (such as
        Notion, Linear or Stripe): they receive what your teammates send them under your account
        with them.
      </p>

      <h2>Changes</h2>
      <p>
        We update this page, and its date, before a new subprocessor gets your data. A customer who
        objects can tell us at <a href={`mailto:${OPERATOR.email}`}>{OPERATOR.email}</a> within 30
        days, as the data processing agreement says.
      </p>
    </LegalPage>
  )
}
