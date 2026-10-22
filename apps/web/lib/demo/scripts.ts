// What teammates answer in the demo: a few tasks scripted step by step, played as a runner
// streams a real turn (lib/demo/server.ts), and a friendly reply with suggestions for
// anything else. They only do what Brigade does: a write to an App waits for a person's
// approval when the teammate's permissions ask for it, and a merge is a person's call.
import type { DemoPull } from './pulls'

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
    }
  | { file: string; ms?: number }
  | { say: string; ms?: number }

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
    openPull: (threadId: string, teammate: Ref) => DemoPull
    openTickets: () => { title: string; session?: { title: string } }[]
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
  if (/build it|open a pr|annual billing|billing toggle/.test(said)) return buildToggle(ctx, teammate)
  if (/^not yet/.test(said))
    return { steps: [{ say: 'Fine, I’ll leave it here. Say the word when you want it built.' }] }
  if (/summar/.test(said)) return summarize(ctx)
  if (/waiting on me|needs me|my tickets|what's waiting/.test(said)) return waiting(ctx)
  if (/digest|support/.test(said)) return digest(ctx)
  return {
    steps: [
      {
        say: `In the demo, ${teammate.name} knows a few tasks: building the annual billing toggle on Acme’s pricing page and opening its pull request, summarizing a thread, listing what waits on you, and writing the weekly support digest. Pick one below.\n\nIn your own workspace, a teammate works on anything you ask, on your Mac or a cloud computer, with your Claude or Codex subscription.`,
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
      { say: 'On it: the toggle above the cards, annual prices per month, then a pull request.', ms: 600 },
      {
        tool: tool('checkout_repository'),
        input: { repository: 'acme/web' },
        output: { directory: 'web', branch: `brigade/${teammate.name.toLowerCase()}-annual-billing` },
        takes: 1400,
      },
      {
        tool: 'Read',
        input: { file_path: 'web/components/pricing-cards.tsx' },
        output: 'export function PricingCards() {\n  return (\n    <div className="grid gap-6 md:grid-cols-3">…',
        takes: 700,
      },
      {
        tool: 'Grep',
        input: { pattern: 'price_.*_yearly', path: 'web/lib' },
        output: 'web/lib/plans.ts:14:  yearly: "price_team_yearly",\nweb/lib/plans.ts:22:  yearly: "price_business_yearly",',
        takes: 700,
      },
      { file: 'web/components/billing-toggle.tsx', ms: 1200 },
      { file: 'web/components/pricing-cards.tsx', ms: 900 },
      { file: 'web/components/pricing-cards.test.tsx', ms: 900 },
      bash('pnpm test pricing', '✓ pricing-cards › annual prices are ten months over twelve\nTests: 34 passed, 34 total', 2200),
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
  const lines = open.slice(0, 6).map((t) => `- ${t.title}${t.session ? ` (in “${t.session.title}”)` : ''}`)
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
  return {
    steps: [
      {
        tool: tool('gmail_search_support_acme_test'),
        input: { query: 'to:support@acme.test newer_than:7d' },
        output: { messages: 41 },
        takes: 1400,
      },
      {
        tool: 'Read',
        input: { file_path: 'library/Support/digest-template.md' },
        output: '# Weekly support digest\n\n## Volume\n## Themes\n## Bugs filed\n## Waiting on us',
        takes: 700,
      },
      {
        say: '**Support, this week**\n\n- **41 conversations**, 34 answered on their own by the Support and bugs playbook, 7 with a person.\n- **Themes**: invite links (fixed in acme/web#146, waiting on merge), CSV export (fixed in #141), plan changes.\n- **Waiting on us**: Globex’s plan change, Jamie Lee’s duplicate charge.\n\nSaved to the library as Support/digests/this-week.md.',
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
    if (outcome.approved === false)
      return {
        steps: [
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
          { ms: 400, tool: toolName, input: ctx.pending.input, output: { merged: true, sha: '3f9c2a1' }, takes: 900, then: () => void ctx.merge(number) },
          { say: `Merged acme/web#${number} (squash). It deploys with main; I’ll tell the customer in the support thread once it’s live.` },
        ],
      }
    }
    if (operation === 'stripe_api_write')
      return {
        steps: [
          { ms: 400, tool: toolName, input: ctx.pending.input, output: { id: 're_3SampleDemo', object: 'refund', status: 'succeeded', livemode: false }, takes: 1000 },
          { say: 'Refunded the duplicate charge (test mode). I’ll reply to Jamie with the refund and when it shows on their statement.' },
        ],
      }
    if (operation === 'gmail_send')
      return {
        steps: [
          { ms: 400, tool: toolName, input: ctx.pending.input, output: { id: '18f2c0a9d3', labelIds: ['SENT'] }, takes: 900 },
          { say: `Sent: “${String(input.subject ?? 'the reply')}”. I’ll watch the thread for an answer.` },
        ],
      }
    return {
      steps: [
        { ms: 400, tool: toolName, input: ctx.pending.input, output: { ok: true }, takes: 900 },
        { say: 'Done.' },
      ],
    }
  }
  if (ctx.asked?.type === 'question.asked') {
    const answer = outcome.answer as { answers?: Record<string, { optionIds: string[]; freeform?: string }> } | undefined
    const questions = (ctx.asked.questions ?? []) as { id: string; options?: { id: string; label: string }[] }[]
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
    const answer = outcome.answer as { action: string; replies?: Record<string, { type: string; approved?: boolean; optionId?: string }> } | undefined
    const asks = (ctx.asked.asks ?? []) as { id: string; type: string; options?: { id: string; label: string }[] }[]
    if (answer?.action === 'declined')
      return { steps: [{ say: 'Understood, I’ve dropped it.', ms: 500 }] }
    const parts = asks.map((ask) => {
      const reply = answer?.replies?.[ask.id]
      if (reply?.type === 'approval') return reply.approved ? 'Approved' : 'Not approved'
      if (reply?.type === 'decision') return ask.options?.find((o) => o.id === reply.optionId)?.label ?? 'Noted'
      return 'Noted'
    })
    return {
      steps: [{ say: `Thanks: ${parts.join(', ').toLowerCase()}. I’ll take it from here and report back in this thread.`, ms: 600 }],
    }
  }
  return undefined
}
