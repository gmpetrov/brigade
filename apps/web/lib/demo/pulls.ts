// The demo's pull requests. The sample workspace's come from GitHub, which the preview the
// fixtures are recorded from does not reach: these stand in for what GitHub would answer,
// for the pull requests its threads opened (apps/api/prisma/seed-workspace.ts), and for the
// one Riley opens in the demo when asked to build the annual billing toggle.
import type {
  DiffFile,
  PullRequestDetail,
  PullRequestState,
  PullRequestSummary,
  PullReview,
} from '@brigade/contracts'

type Ref = { id: string; name: string }
export type DemoPull = {
  number: number
  summary: PullRequestSummary
  session: { id: string; title: string } | null
  detail: () => PullRequestDetail
  state: () => PullRequestState
}

type Spec = {
  number: number
  title: string
  head: string
  body: string
  files: DiffFile[]
  author: Ref | null
  session: { id: string; title: string } | null
  review: PullReview | null
  updatedAt: string
  merged?: string
}

const INVITES: DiffFile[] = [
  {
    path: 'lib/invites.ts',
    previousPath: null,
    status: 'modified',
    additions: 2,
    deletions: 2,
    patch: `@@ -18,7 +18,7 @@ export async function createInvite(email: string, role: Role) {
   const token = randomToken()
-  const expiresAt = Math.floor(Date.now() / 1000) + 7 * DAY_SECONDS
+  const expiresAt = Date.now() + 7 * DAY_MS
   await db.invite.create({ data: { email, role, token, expiresAt } })
   return token
 }
@@ -31,5 +31,5 @@ export async function readInvite(token: string) {
   const invite = await db.invite.findUnique({ where: { token } })
   if (!invite) return { state: 'missing' as const }
-  if (invite.expiresAt < Date.now() / 1000) return { state: 'expired' as const }
+  if (invite.expiresAt < Date.now()) return { state: 'expired' as const }
   return { state: 'valid' as const, invite }`,
  },
  {
    path: 'lib/invites.test.ts',
    previousPath: null,
    status: 'modified',
    additions: 6,
    deletions: 0,
    patch: `@@ -40,3 +40,9 @@ test('an invite can be used once', async () => {
   expect(await readInvite(token)).toMatchObject({ state: 'used' })
 })
+
+test('a new link is valid for 7 days', async () => {
+  const token = await createInvite('elena@monarch.test', 'member')
+  expect(await readInvite(token)).toMatchObject({ state: 'valid' })
+  vi.advanceTimersByTime(8 * DAY_MS)
+  expect(await readInvite(token)).toMatchObject({ state: 'expired' })
+})`,
  },
]

const PRICING_THEME: DiffFile[] = [
  {
    path: 'components/pricing-cards.tsx',
    previousPath: null,
    status: 'modified',
    additions: 4,
    deletions: 4,
    patch: `@@ -12,10 +12,10 @@ export function PricingCard({ plan, highlighted }: Props) {
   return (
     <div
       className={cn(
-        'rounded-xl border border-gray-200 bg-white p-6 text-gray-900',
-        highlighted && 'border-violet-500 ring-2 ring-violet-200',
+        'rounded-xl border bg-card p-6 text-card-foreground',
+        highlighted && 'border-primary ring-2 ring-primary/20',
       )}
     >
-      <h3 className="text-sm font-medium text-gray-500">{plan.name}</h3>
-      <p className="mt-2 text-3xl font-semibold text-gray-900">{plan.price}</p>
+      <h3 className="text-sm font-medium text-muted-foreground">{plan.name}</h3>
+      <p className="mt-2 text-3xl font-semibold">{plan.price}</p>`,
  },
]

const CSV: DiffFile[] = [
  {
    path: 'app/api/invoices/export/route.ts',
    previousPath: null,
    status: 'modified',
    additions: 1,
    deletions: 1,
    patch: `@@ -22,7 +22,7 @@ const row = (invoice: Invoice) => [
   invoice.number,
   invoice.customer.name,
   formatMoney(invoice.total),
-  invoice.dueAt.toISOString().slice(0, 10),
+  invoice.dueAt ? invoice.dueAt.toISOString().slice(0, 10) : '',
   invoice.status,
 ]`,
  },
]

const ANNUAL: DiffFile[] = [
  {
    path: 'components/billing-toggle.tsx',
    previousPath: null,
    status: 'added',
    additions: 24,
    deletions: 0,
    patch: `@@ -0,0 +1,24 @@
+'use client'
+import { cn } from '@/lib/utils'
+
+export type Period = 'monthly' | 'annual'
+
+/** Monthly or annual prices on the pricing page. */
+export function BillingToggle({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
+  return (
+    <div role="radiogroup" className="inline-flex rounded-full border bg-muted p-1 text-sm">
+      {(['monthly', 'annual'] as const).map((p) => (
+        <button
+          key={p}
+          role="radio"
+          aria-checked={value === p}
+          onClick={() => onChange(p)}
+          className={cn('rounded-full px-4 py-1.5', value === p && 'bg-background shadow-sm')}
+        >
+          {p === 'monthly' ? 'Monthly' : 'Annual'}
+        </button>
+      ))}
+    </div>
+  )
+}`,
  },
  {
    path: 'components/pricing-cards.tsx',
    previousPath: null,
    status: 'modified',
    additions: 9,
    deletions: 2,
    patch: `@@ -4,9 +4,16 @@ import { plans } from '@/lib/plans'
-export function PricingCards() {
+export function PricingCards({ period }: { period: Period }) {
   return (
     <div className="grid gap-6 md:grid-cols-3">
       {plans.map((plan) => (
-        <PricingCard key={plan.id} plan={plan} price={plan.monthly} />
+        <PricingCard
+          key={plan.id}
+          plan={plan}
+          // Annual: ten months' price over twelve, shown per month.
+          price={period === 'annual' ? (plan.monthly * 10) / 12 : plan.monthly}
+          note={period === 'annual' ? '2 months free' : undefined}
+        />
       ))}
     </div>`,
  },
  {
    path: 'components/pricing-cards.test.tsx',
    previousPath: null,
    status: 'added',
    additions: 8,
    deletions: 0,
    patch: `@@ -0,0 +1,8 @@
+import { render, screen } from '@testing-library/react'
+import { PricingCards } from './pricing-cards'
+
+test('annual prices are ten months over twelve', () => {
+  render(<PricingCards period="annual" />)
+  expect(screen.getByText('$20/mo')).toBeInTheDocument()
+  expect(screen.getAllByText('2 months free')).toHaveLength(3)
+})`,
  },
]

function make(spec: Spec): DemoPull {
  const summary: PullRequestSummary = {
    repository: 'acme/web',
    number: spec.number,
    title: spec.title,
    url: `https://github.com/acme/web/pull/${spec.number}`,
    author: 'brigade-app[bot]',
    draft: false,
    state: spec.merged ? 'merged' : 'open',
    head: spec.head,
    base: 'main',
    updatedAt: spec.merged ?? spec.updatedAt,
    tracking: {
      mergeStatus: 'none',
      note: null,
      sessionId: spec.session?.id ?? null,
      author: spec.author,
      review: spec.review,
      preview: null,
    },
  }
  const checks = [
    { name: 'test', status: 'success' as const, url: null },
    { name: 'lint', status: 'success' as const, url: null },
  ]
  const open = !spec.merged
  const sum = (k: 'additions' | 'deletions') => spec.files.reduce((n, f) => n + f[k], 0)
  return {
    number: spec.number,
    summary,
    session: spec.session,
    state: () => ({
      ...summary,
      mergeable: open ? true : null,
      mergeableState: open ? 'clean' : 'unknown',
      mergedAt: spec.merged ?? null,
      checks: open ? checks : [],
    }),
    detail: () => ({
      ...summary,
      body: spec.body,
      headSha: `${spec.number}a9c3e1f0b7d24c5e8f6a1b2c3d4e5f6a7b8c9d`.slice(0, 40),
      mergeable: open ? true : null,
      mergeableState: open ? 'clean' : 'unknown',
      additions: sum('additions'),
      deletions: sum('deletions'),
      changedFiles: spec.files.length,
      commits: 1,
      files: spec.files,
      filesCut: false,
      checks,
      reviews:
        spec.review?.state === 'approved'
          ? [
              {
                id: `review-${spec.number}`,
                teammate: spec.review.reviewer,
                verdict: 'approve',
                body: 'Approved: the cards use the theme tokens in both themes.',
                comments: [],
                sha: 'a9c3e1f',
                round: 1,
                url: null,
                createdAt: spec.review.at,
              },
            ]
          : [],
      githubReviews: [],
    }),
  }
}

type Attention = {
  pulls: {
    number: number
    title: string
    updatedAt: string
    session: { id: string; title: string } | null
    authorTeammate: Ref | null
    review: PullReview | null
  }[]
}

/** The sample workspace's pull requests, from what its Needs you list recorded. */
export function demoPulls(store: Map<string, { body: unknown }>) {
  const attention = (store.get('GET /pulls/attention')?.body as Attention | undefined)?.pulls ?? []
  const from = (n: number) => attention.find((p) => p.number === n)
  const pulls = new Map<number, DemoPull>()
  const invites = from(146)
  if (invites)
    pulls.set(
      146,
      make({
        ...invites,
        head: 'brigade/sam-invite-expiry',
        body: 'The expiry was saved in seconds and compared with Date.now() in milliseconds, so every link read as expired. Both are now milliseconds. Covered by a test.',
        files: INVITES,
        author: invites.authorTeammate,
      }),
    )
  const pricing = from(128)
  if (pricing)
    pulls.set(
      128,
      make({
        ...pricing,
        head: 'brigade/riley-pricing-dark',
        body: 'The pricing cards had fixed light colors, so in dark mode they stayed white. They now use the theme tokens, in both themes.',
        files: PRICING_THEME,
        author: pricing.authorTeammate,
      }),
    )
  const sam = invites?.authorTeammate ?? null
  const day = new Date(Date.now() - 26 * 3600_000).toISOString()
  pulls.set(
    141,
    make({
      number: 141,
      title: 'Invoice CSV export: leave the due date empty when there is none',
      head: 'brigade/sam-csv-due-date',
      body: 'Invoices without a due date made the CSV export throw. The column is now empty for them, with a test.',
      files: CSV,
      author: sam,
      session: null,
      review: null,
      updatedAt: day,
      merged: day,
    }),
  )
  return pulls
}

/** The pull request merged: what GitHub answers after. */
export function mergedPull(pull: DemoPull): DemoPull {
  const at = new Date().toISOString()
  const summary = { ...pull.summary, state: 'merged' as const, updatedAt: at }
  return {
    ...pull,
    summary,
    state: () => ({ ...pull.state(), ...summary, mergeable: null, mergedAt: at, checks: [] }),
    detail: () => ({ ...pull.detail(), ...summary, mergeable: null, mergeableState: 'unknown' }),
  }
}

/** The pull request Riley opens for the annual billing toggle. */
export function newPull(threadId: string, teammate: Ref, title = 'Pricing page: monthly or annual billing') {
  return make({
    number: 152,
    title,
    head: `brigade/${teammate.name.toLowerCase()}-annual-billing`,
    body: 'A Monthly / Annual toggle above the pricing cards. Annual prices are ten months over twelve, shown per month, with "2 months free" under them. Stripe already has the yearly prices. Covered by a test.',
    files: ANNUAL,
    author: teammate,
    session: { id: threadId, title: 'Annual billing toggle on the pricing page' },
    review: { state: 'skipped', reason: 'A small page change, covered by a test' },
    updatedAt: new Date().toISOString(),
  })
}
