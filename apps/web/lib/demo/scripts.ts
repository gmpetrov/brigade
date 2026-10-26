// What teammates answer in the demo: a few tasks scripted step by step, played as a runner
// streams a real turn (lib/demo/server.ts), and a friendly reply with suggestions for
// anything else. They only do what Brigade does: a write to an App waits for a person's
// approval when the teammate's permissions ask for it, and a merge is a person's call.
import type { DemoPull, NewPull } from './pulls'

export type Step =
  | {
      tool: string
      input: unknown
      output: unknown
      /** Before it starts, and how long it runs (ms). */
      ms?: number
      takes?: number
      /** Done to the workspace once it finished. */
      then?: () => void
      /** Finishes this call, started before (one an approval held), rather than a new one. */
      toolCallId?: string
      isError?: boolean
    }
  | { file: string; ms?: number }
  | { say: string; ms?: number }
  /**
   * A write to an App that waits for a person: its call starts, its ticket opens and the run
   * stops there, waiting. Approving it goes on as afterDecision says.
   */
  | {
      approval: { tool: string; input: unknown; operation: string; target: string }
      ms?: number
    }

export type Run = {
  steps: Step[]
  /** Buttons under the reply; `merge` puts Brigade's own merge button first. */
  replies?: string[]
  merge?: string
  /** The thread's status after it (idle unless it waits on a person). */
  status?: string
  teammateId?: string
  /** Goes on with the turn that waited, rather than starting one. */
  continues?: boolean
  done?: () => void
}

type Ref = { id: string; name: string }
export type Context = {
  threadId: string
  thread?: { title: string; teammate?: Ref }
  teammates: Ref[]
  actions: {
    /** Opens the pull request; `merged` is the run its merge starts in the thread. */
    openPull: (threadId: string, teammate: Ref, kind?: NewPull, merged?: Run) => DemoPull
    /** A routine the teammate made, shown in Routines. */
    addRoutine: (routine: {
      title: string
      cron: string
      instructions: string
      teammateId: string
    }) => void
    openTickets: () => { title: string; session?: { title: string } }[]
    playbook: () =>
      { count: number; onItsOwn: number; approvedByYou: number; withPerson: number } | undefined
  }
}

const tool = (name: string) => `mcp__harness-tools__${name}`
const bash = (command: string, output: string, takes = 1600): Step => ({
  tool: 'Bash',
  input: { command },
  output,
  takes,
})

/** What a visitor may click to see a teammate at work, in this thread. */
export function suggestions(ctx: Pick<Context, 'thread'>) {
  const out: string[] = []
  if (/annual|billing|pricing/i.test(ctx.thread?.title ?? '')) out.push('Build it and open a PR')
  out.push('Summarize this thread', 'What’s waiting on me?', 'Write the weekly support digest')
  return out.slice(0, 3)
}

const norm = (text: string) =>
  text
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9' #]+/g, ' ')
    .trim()

/** The run that answers a message. */
export function replyTo(text: string, ctx: Context): Run {
  const said = norm(text)
  const teammate = ctx.thread?.teammate ?? ctx.teammates[0] ?? { id: '', name: 'Riley' }
  if (/csv export|asked for csv/.test(said)) return shipFeature(ctx, teammate)
  if (/build it|open a pr|annual billing|billing toggle/.test(said))
    return buildToggle(ctx, teammate)
  if (/^not yet/.test(said))
    return { steps: [{ say: 'Fine, I’ll leave it here. Say the word when you want it built.' }] }
  if (/export button|export is broken|export doesn't work/.test(said))
    return fixExport(ctx, teammate)
  if (/every bug report|each bug report/.test(said)) return bugRoutine(ctx, teammate)
  if (/prep me|call with northwind|brief me/.test(said)) return prepCall(teammate)
  if (/payment failed|card was declined|failed payment/.test(said)) return failedPayment(teammate)
  if (/summar/.test(said)) return summarize(ctx)
  if (/waiting on me|needs me|my tickets|what's waiting/.test(said)) return waiting(ctx)
  if (/digest|support/.test(said)) return digest(ctx)
  return {
    steps: [
      {
        say: `In the demo, ${teammate.name} knows a few tasks: fixing the export button on Reports, building the CSV export Northwind asked for, prepping your call with Northwind, chasing Globex’s failed payment, building the annual billing toggle on Acme’s pricing page, summarizing a thread, listing what waits on you, and writing the weekly support digest. Pick one below.\n\nIn your own workspace, teammates work on what you ask, on your own computer or a cloud computer, with your own Claude or Codex subscription.`,
        ms: 700,
      },
    ],
    replies: suggestions(ctx),
  }
}

function buildToggle(ctx: Context, teammate: Ref): Run {
  const number = 152
  return {
    steps: [
      {
        say: 'On it: the toggle above the cards, annual prices per month, then a pull request.',
        ms: 600,
      },
      {
        tool: tool('checkout_repository'),
        input: { repository: 'acme/web' },
        output: {
          directory: 'web',
          branch: `brigade/${teammate.name.toLowerCase()}-annual-billing`,
        },
        takes: 1400,
      },
      {
        tool: 'Read',
        input: { file_path: 'web/components/pricing-cards.tsx' },
        output:
          'export function PricingCards() {\n  return (\n    <div className="grid gap-6 md:grid-cols-3">…',
        takes: 700,
      },
      {
        tool: 'Grep',
        input: { pattern: 'price_.*_yearly', path: 'web/lib' },
        output:
          'web/lib/plans.ts:14:  yearly: "price_team_yearly",\nweb/lib/plans.ts:22:  yearly: "price_business_yearly",',
        takes: 700,
      },
      { file: 'web/components/billing-toggle.tsx', ms: 1200 },
      { file: 'web/components/pricing-cards.tsx', ms: 900 },
      { file: 'web/components/pricing-cards.test.tsx', ms: 900 },
      bash(
        'pnpm test pricing',
        '✓ pricing-cards › annual prices are ten months over twelve\nTests: 34 passed, 34 total',
        2200,
      ),
      bash('pnpm typecheck', 'Done in 6.1s', 1400),
      bash(
        'git commit -am "Pricing page: monthly or annual billing" && git push -u origin HEAD',
        `To acme/web\n * [new branch]      brigade/${teammate.name.toLowerCase()}-annual-billing -> brigade/${teammate.name.toLowerCase()}-annual-billing`,
        1500,
      ),
      {
        tool: tool('github_create_pull_request'),
        input: {
          repository: 'acme/web',
          title: 'Pricing page: monthly or annual billing',
          head: `brigade/${teammate.name.toLowerCase()}-annual-billing`,
          base: 'main',
          review: { wanted: false, reason: 'A small page change, covered by a test' },
        },
        output: { number: 152, url: 'https://github.com/acme/web/pull/152', state: 'open' },
        takes: 1200,
        then: () => void ctx.actions.openPull(ctx.threadId, teammate),
      },
      {
        say: `Done: [acme/web#${number}](https://github.com/acme/web/pull/${number}) adds a Monthly / Annual toggle above the pricing cards. Annual prices show per month with “2 months free” under them, using the yearly prices Stripe already has. Tests and typecheck pass.`,
      },
    ],
    merge: `Merge #${number}`,
    replies: ['Not yet'],
  }
}

/**
 * The landing page's walkthrough (lib/demo/tour.ts): a customer reports the export button does
 * nothing. The teammate fixes it and opens a pull request; once a person merges it, it drafts
 * the replies to the customers who asked, which wait for the person's OK before they go.
 */
function fixExport(ctx: Context, teammate: Ref): Run {
  const slug = teammate.name.toLowerCase()
  const customers = ['jo@northwind.test', 'mia@lumen.test', 'sara@globex.test']
  const replies: Run = {
    teammateId: teammate.id,
    steps: [
      { say: 'Merged: the fix ships with main. Now the customers who asked.', ms: 500 },
      {
        tool: tool('gmail_search_support_acme_test'),
        input: { query: 'export button newer_than:14d' },
        output: { messages: 3, from: customers },
        takes: 1100,
      },
      {
        say: 'Three customers wrote about it: Northwind, Lumen and Globex. I drafted a short reply to each, saying it’s fixed. Sending waits for your OK.',
      },
      {
        approval: {
          tool: tool('gmail_send_support_acme_test'),
          operation: 'gmail_send',
          input: {
            to: customers,
            subject: 'Re: Export button',
            body: 'Hi,\n\nThanks for telling us: the export button on Reports works again. It was a bug on our side, now fixed and covered by a test.\n\nThe Acme team',
          },
          target: `email ${customers.join(', ')}: “Re: Export button”`,
        },
        ms: 600,
      },
    ],
  }
  return {
    steps: [
      {
        say: 'On it: I’ll find why the export button does nothing, fix it and open a pull request.',
        ms: 500,
      },
      {
        tool: tool('checkout_repository'),
        input: { repository: 'acme/web' },
        output: { directory: 'web', branch: `brigade/${slug}-export-button` },
        takes: 900,
      },
      {
        tool: 'Grep',
        input: { pattern: 'onExport', path: 'web/app/reports' },
        output:
          "web/app/reports/export-button.tsx:9:  const onExport = () => download(toCsv(rows), 'report.csv')",
        takes: 600,
      },
      {
        tool: 'Read',
        input: { file_path: 'web/app/reports/export-button.tsx' },
        output:
          '<Button variant="outline" disabled={!rows.length}>\n  <Download /> Export\n</Button>',
        takes: 500,
      },
      { file: 'web/app/reports/export-button.tsx', ms: 700 },
      { file: 'web/app/reports/export-button.test.tsx', ms: 600 },
      bash(
        'pnpm test reports',
        '✓ export-button › export downloads the rows as CSV\nTests: 41 passed, 41 total',
        1300,
      ),
      bash(
        'git commit -am "Reports: the export button exports again" && git push -u origin HEAD',
        `To acme/web\n * [new branch]      brigade/${slug}-export-button -> brigade/${slug}-export-button`,
        900,
      ),
      {
        tool: tool('github_create_pull_request'),
        input: {
          repository: 'acme/web',
          title: 'Reports: the export button exports again',
          head: `brigade/${slug}-export-button`,
          base: 'main',
          review: { wanted: false, reason: 'A one-line fix, covered by a test' },
        },
        output: { number: 153, url: 'https://github.com/acme/web/pull/153', state: 'open' },
        takes: 900,
        then: () => void ctx.actions.openPull(ctx.threadId, teammate, 'export', replies),
      },
      {
        say: 'Found it: the button lost its click handler when Reports moved to the new table, so it did nothing. Fixed in [acme/web#153](https://github.com/acme/web/pull/153), with a test. Once it’s merged, I’ll tell the customers who asked.',
      },
    ],
    merge: 'Merge #153',
  }
}

/**
 * A walkthrough: a customer's request, shipped and announced. Jo at Northwind asked for CSV
 * export on Invoices; the teammate builds it and opens a pull request. Once a person merges it,
 * it records a short demo in its browser, saves it to Drive and drafts the email to Jo, which
 * waits for the person's OK.
 */
function shipFeature(ctx: Context, teammate: Ref): Run {
  const slug = teammate.name.toLowerCase()
  const jo = 'jo@northwind.test'
  const announce: Run = {
    teammateId: teammate.id,
    steps: [
      { say: 'Merged: CSV export ships with main. Now a short demo for Jo.', ms: 500 },
      bash(
        'pnpm playwright test demo/invoices-export --video on',
        '✓ invoices › export as CSV (28s)\nVideo: demo/csv-export.webm',
        1600,
      ),
      {
        tool: tool('google_drive_upload_file'),
        input: { path: 'demo/csv-export.webm', folder: 'Product demos' },
        output: { name: 'csv-export.webm', link: 'https://drive.google.com/file/d/demo' },
        takes: 1000,
      },
      {
        say: 'Recorded a 28-second demo of the export and saved it to Drive. I drafted the email to Jo with the link. Sending waits for your OK.',
      },
      {
        approval: {
          tool: tool('gmail_send_support_acme_test'),
          operation: 'gmail_send',
          input: {
            to: jo,
            subject: 'CSV export is live',
            body: 'Hi Jo,\n\nYou asked for it, it’s live: Invoices now has an Export as CSV button. Here’s a 28-second demo: https://drive.google.com/file/d/demo\n\nThe Acme team',
          },
          target: `email ${jo}: “CSV export is live”`,
        },
        ms: 600,
      },
    ],
  }
  return {
    steps: [
      { say: 'On it: CSV export on Invoices, then a pull request.', ms: 500 },
      {
        tool: tool('gmail_search_support_acme_test'),
        input: { query: 'from:jo@northwind.test csv' },
        output: { messages: 1, subject: 'Can we export invoices as CSV?' },
        takes: 800,
      },
      {
        tool: tool('checkout_repository'),
        input: { repository: 'acme/web' },
        output: { directory: 'web', branch: `brigade/${slug}-invoices-csv` },
        takes: 800,
      },
      { file: 'web/app/invoices/export-csv.ts', ms: 900 },
      { file: 'web/app/invoices/invoices-toolbar.tsx', ms: 700 },
      { file: 'web/app/invoices/export-csv.test.ts', ms: 600 },
      bash(
        'pnpm test invoices',
        '✓ export-csv › one row per invoice, totals in cents\nTests: 38 passed, 38 total',
        1300,
      ),
      {
        tool: tool('github_create_pull_request'),
        input: {
          repository: 'acme/web',
          title: 'Invoices: export as CSV',
          head: `brigade/${slug}-invoices-csv`,
          base: 'main',
          review: { wanted: false, reason: 'A new button and a tested helper' },
        },
        output: { number: 154, url: 'https://github.com/acme/web/pull/154', state: 'open' },
        takes: 900,
        then: () => void ctx.actions.openPull(ctx.threadId, teammate, 'csv', announce),
      },
      {
        say: 'Done: [acme/web#154](https://github.com/acme/web/pull/154) adds Export as CSV on Invoices, one row per invoice, with a test. Once it’s merged, I’ll record a demo and tell Jo.',
      },
    ],
    merge: 'Merge #154',
  }
}

/**
 * A walkthrough: a brief before a sales call, from the calendar, the inbox, Stripe and usage.
 * It ends on the agenda for Jo, which waits for the person's OK.
 */
function prepCall(teammate: Ref): Run {
  const jo = 'jo@northwind.test'
  return {
    teammateId: teammate.id,
    steps: [
      { say: 'On it: your call with Northwind.', ms: 500 },
      {
        tool: tool('google_calendar_list_events'),
        input: { query: 'Northwind', days: 2 },
        output: { events: [{ title: 'Northwind · renewal', start: 'tomorrow 10:00' }] },
        takes: 800,
      },
      {
        tool: tool('gmail_search_support_acme_test'),
        input: { query: 'from:northwind.test newer_than:30d' },
        output: { messages: 6 },
        takes: 900,
      },
      {
        tool: tool('stripe_api_read'),
        input: { customer: 'Northwind' },
        output: { plan: 'Pro', seats: 12, renews: 'in 3 weeks' },
        takes: 800,
      },
      {
        tool: tool('posthog_query'),
        input: { query: 'weekly active users, Northwind, last 30 days' },
        output: { change: '+32%' },
        takes: 900,
      },
      {
        say: '**Northwind, tomorrow 10:00**\n\n- On **Pro**, 12 seats, renews in 3 weeks.\n- Usage is **up 32%** this month.\n- Jo asked about **SSO** twice in their last 6 emails.\n\nA good moment to offer Business, which has SSO. I drafted a short agenda for Jo. Sending waits for your OK.',
      },
      {
        approval: {
          tool: tool('gmail_send_support_acme_test'),
          operation: 'gmail_send',
          input: {
            to: jo,
            subject: 'Agenda for tomorrow',
            body: 'Hi Jo,\n\nFor tomorrow at 10:00: your renewal, how the team uses Acme today, and SSO, which you asked about.\n\nSee you then,\nAda',
          },
          target: `email ${jo}: “Agenda for tomorrow”`,
        },
        ms: 600,
      },
    ],
  }
}

/**
 * A walkthrough: Stripe says a customer's payment failed. The teammate finds why and drafts
 * the email with a link to update the card, which waits for the person's OK.
 */
function failedPayment(teammate: Ref): Run {
  const sara = 'sara@globex.test'
  return {
    teammateId: teammate.id,
    steps: [
      { say: 'On it: Globex’s payment.', ms: 500 },
      {
        tool: tool('stripe_api_read'),
        input: { customer: 'Globex', resource: 'invoices', status: 'open' },
        output: {
          invoice: 'in_1Demo',
          amount: '$490.00',
          failure: 'card_declined: expired card',
          hosted_invoice_url: 'https://invoice.stripe.com/i/demo',
        },
        takes: 1000,
      },
      {
        tool: tool('gmail_search_support_acme_test'),
        input: { query: 'from:globex.test billing' },
        output: { messages: 1, contact: sara },
        takes: 800,
      },
      {
        say: 'The card on file expired, so October’s $490 invoice failed. I drafted a short email to Sara at Globex with the link to pay it with a new card. Sending waits for your OK.',
      },
      {
        approval: {
          tool: tool('gmail_send_support_acme_test'),
          operation: 'gmail_send',
          input: {
            to: sara,
            subject: 'Your card expired',
            body: 'Hi Sara,\n\nOctober’s invoice ($490) didn’t go through: the card on file expired. You can pay it with a new card here: https://invoice.stripe.com/i/demo\n\nThanks,\nThe Acme team',
          },
          target: `email ${sara}: “Your card expired”`,
        },
        ms: 600,
      },
    ],
  }
}

function bugRoutine(ctx: Context, teammate: Ref): Run {
  const routine = {
    title: 'Morning bug reports',
    cron: '0 8 * * 1-5',
    instructions:
      'Read the support inbox for new bug reports. Fix each one in acme/web with a pull request, and draft a reply to the customers who reported it. Merging and sending wait for a person.',
    teammateId: teammate.id,
  }
  return {
    steps: [
      {
        tool: tool('create_schedule'),
        input: { title: routine.title, cron: routine.cron, instructions: routine.instructions },
        output: { id: 'routine-morning-bugs', nextRunAt: 'tomorrow 08:00' },
        takes: 900,
        ms: 600,
        then: () => ctx.actions.addRoutine(routine),
      },
      {
        say: 'Done: every weekday at 8:00, I read the support inbox, fix each new bug report the same way and draft the replies. Merging and sending still wait for you. It’s in Routines as “Morning bug reports”.',
      },
    ],
  }
}

function summarize(ctx: Context): Run {
  const title = ctx.thread?.title ?? 'this thread'
  return {
    steps: [
      {
        say: `**${title}**, in short: what was asked is at the top, every step I took is folded in between (open one to see its input and output), and what’s left for a person shows as a ticket or the buttons under my last reply. Nothing here ran on a real computer: it’s the demo workspace.`,
        ms: 800,
      },
    ],
    replies: suggestions(ctx).filter((s) => !s.startsWith('Summarize')),
  }
}

function waiting(ctx: Context): Run {
  const open = ctx.actions.openTickets()
  const lines = open
    .slice(0, 6)
    .map((t) => `- ${t.title}${t.session ? ` (in “${t.session.title}”)` : ''}`)
  return {
    steps: [
      {
        tool: tool('list_tasks'),
        input: { column: 'needs_you' },
        output: { tickets: open.length },
        takes: 900,
      },
      {
        say: open.length
          ? `${open.length} ${open.length === 1 ? 'thing waits' : 'things wait'} on you:\n\n${lines.join('\n')}\n\nEach one is in Tickets, and in its thread.`
          : 'Nothing waits on you right now.',
      },
    ],
    replies: suggestions(ctx).filter((s) => !s.startsWith('What')),
  }
}

function digest(ctx: Context): Run {
  // The sample's own numbers: the Support and bugs playbook's week, as Home shows it.
  const week = ctx.actions.playbook()
  const volume = week
    ? `- **${week.count} support mails** went through the Support and bugs playbook: ${week.onItsOwn} answered on its own, ${week.approvedByYou} approved by you, ${week.withPerson} with a person.`
    : '- Support mails went through the Support and bugs playbook.'
  const open = ctx.actions.openTickets().length
  return {
    steps: [
      {
        tool: tool('gmail_search_support_acme_test'),
        input: { query: 'to:support@acme.test newer_than:7d' },
        output: { messages: week?.count ?? 0 },
        takes: 1400,
      },
      {
        tool: 'Read',
        input: { file_path: 'library/Support/digest-template.md' },
        output: '# Weekly support digest\n\n## Volume\n## Themes\n## Waiting on us',
        takes: 700,
      },
      {
        tool: tool('save_to_library'),
        input: { path: 'Projects/Support/digests/this-week.md' },
        output: { saved: 'Projects/Support/digests/this-week.md' },
        takes: 800,
      },
      {
        say: `**Support, this week**\n\n${volume}\n- **Themes**: invite links that expired at once (fixed in acme/web#146), the invoice CSV export (fixed in #141), plan changes.\n- **Waiting on us**: ${open} ${open === 1 ? 'ticket' : 'tickets'} in Tickets.\n\nSaved to the library as Projects/Support/digests/this-week.md.`,
      },
    ],
    replies: suggestions(ctx).filter((s) => !s.includes('digest')),
  }
}

type Ticket = { type: string; title: string; payload: Record<string, unknown> }
type Decision = {
  asked?: Record<string, unknown>
  pending?: { toolCallId: string; toolName: string; input: unknown }
  merge: (number: number) => boolean
}

/** How a thread goes on once a person approved, declined or answered what it waited on. */
export function afterDecision(
  ticket: Ticket,
  outcome: { approved?: boolean; answer?: unknown },
  ctx: Decision,
): Run | undefined {
  const operation = String(ticket.payload?.operation ?? '')
  const input = (ticket.payload?.input ?? {}) as Record<string, unknown>
  if (ticket.type === 'approval' && ctx.pending) {
    const toolName = ctx.pending.toolName
    // The call the approval held finishes, as the runner finishes it.
    const held = { toolCallId: ctx.pending.toolCallId }
    if (outcome.approved === false)
      return {
        steps: [
          {
            ...held,
            ms: 300,
            tool: toolName,
            input: ctx.pending.input,
            output: 'Declined by a person',
            isError: true,
            takes: 0,
          },
          {
            say: `Understood: I didn’t do it (${String(ticket.payload?.target ?? operation)}). Tell me what to do instead.`,
            ms: 500,
          },
        ],
        status: 'idle',
      }
    if (operation === 'github_merge_pull_request') {
      const number = Number(input.number)
      return {
        steps: [
          {
            ...held,
            ms: 400,
            tool: toolName,
            input: ctx.pending.input,
            output: { merged: true, sha: '3f9c2a1' },
            takes: 900,
            then: () => void ctx.merge(number),
          },
          {
            say: `Merged acme/web#${number} (squash). It deploys with main; I’ll tell the customer in the support thread once it’s live.`,
          },
        ],
      }
    }
    if (operation === 'stripe_api_write')
      return {
        steps: [
          {
            ...held,
            ms: 400,
            tool: toolName,
            input: ctx.pending.input,
            output: {
              id: 're_3SampleDemo',
              object: 'refund',
              status: 'succeeded',
              livemode: false,
            },
            takes: 1000,
          },
          {
            say: 'Refunded the duplicate charge (test mode). I’ll reply to Jamie with the refund and when it shows on their statement.',
          },
        ],
      }
    if (operation === 'gmail_send')
      return {
        steps: [
          {
            ...held,
            ms: 400,
            tool: toolName,
            input: ctx.pending.input,
            output: { id: '18f2c0a9d3', labelIds: ['SENT'] },
            takes: 900,
          },
          {
            say:
              Array.isArray(input.to) && input.to.length > 1
                ? `Sent to the ${input.to.length} customers: “${String(input.subject ?? 'the reply')}”. I’ll watch for their answers.`
                : `Sent: “${String(input.subject ?? 'the reply')}”. I’ll watch the thread for an answer.`,
          },
        ],
      }
    return {
      steps: [
        {
          ...held,
          ms: 400,
          tool: toolName,
          input: ctx.pending.input,
          output: { ok: true },
          takes: 900,
        },
        { say: 'Done.' },
      ],
    }
  }
  if (ctx.asked?.type === 'question.asked') {
    const answer = outcome.answer as
      { answers?: Record<string, { optionIds: string[]; freeform?: string }> } | undefined
    const questions = (ctx.asked.questions ?? []) as {
      id: string
      options?: { id: string; label: string }[]
    }[]
    const picked = questions
      .map((q) => {
        const a = answer?.answers?.[q.id]
        return a?.freeform || q.options?.find((o) => a?.optionIds.includes(o.id))?.label
      })
      .filter(Boolean)
    return {
      steps: [
        {
          say: picked.length
            ? `Going with “${picked.join(', ')}”. I’ll make the change and write to the customer.`
            : 'Understood, I’ll leave it there.',
          ms: 600,
        },
      ],
    }
  }
  if (ctx.asked?.type === 'ticket.opened') {
    const answer = outcome.answer as
      | {
          action: string
          replies?: Record<string, { type: string; approved?: boolean; optionId?: string }>
        }
      | undefined
    const asks = (ctx.asked.asks ?? []) as {
      id: string
      type: string
      options?: { id: string; label: string }[]
    }[]
    if (answer?.action === 'declined')
      return { steps: [{ say: 'Understood, I’ve dropped it.', ms: 500 }] }
    const parts = asks.map((ask) => {
      const reply = answer?.replies?.[ask.id]
      if (reply?.type === 'approval') return reply.approved ? 'Approved' : 'Not approved'
      if (reply?.type === 'decision')
        return ask.options?.find((o) => o.id === reply.optionId)?.label ?? 'Noted'
      return 'Noted'
    })
    return {
      steps: [
        {
          say: `Thanks: ${parts.join(', ').toLowerCase()}. I’ll take it from here and report back in this thread.`,
          ms: 600,
        },
      ],
    }
  }
  return undefined
}
