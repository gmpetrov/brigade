// Sample data for a local Brigade or a preview: the "Acme" organization, with
// Ada (owner), Bob (admin) and Carol (member) in its workspace, its teammates,
// projects, threads in each state, tasks in each column, tickets, library files,
// memory, connections, credentials, a schedule, a pull request and a playbook with
// its runs (seed-playbooks.ts). Nothing in it reaches an outside service:
// connection and credential secrets are placeholders.
// Called by seed.ts when the organization does not exist yet.
import { randomBytes, randomUUID } from 'node:crypto'
import {
  childPrompt,
  MemoryEdit,
  parentMessage,
  singleNote,
  SUGGEST_REPLIES_TOOL,
  type AgentEvent,
} from '@brigade/contracts'
import { audit, type Actor } from '../src/audit.js'
import { prisma, scoped, type Prisma } from '../src/db.js'
import { editMemory, saveLibraryFile, saveSummary, writeMemory } from '../src/library.js'
import { sealSecret } from '../src/vault.js'
import { seedPlaybooks } from './seed-playbooks.js'

export const SAMPLE_ORGANIZATION = 'acme'

const minutes = (n: number) => new Date(Date.now() - n * 60_000)
const hours = (n: number) => minutes(n * 60)
const days = (n: number) => hours(n * 24)
const id = () => randomBytes(8).toString('hex')

type Users = Record<'ada' | 'bob' | 'carol', { id: string }>
/** An event as the runner sends it, without its time: threads space them out. */
type Draft = {
  [T in AgentEvent['type']]: Omit<Extract<AgentEvent, { type: T }>, 'at'>
}[AgentEvent['type']]

export async function seedWorkspace(users: Users) {
  // -------------------------------------------------------------------------
  // Organization, members and the workspace
  // -------------------------------------------------------------------------
  const organization = await prisma.organization.create({
    data: { id: randomUUID(), name: 'Acme', slug: SAMPLE_ORGANIZATION, createdAt: days(30) },
  })
  const organizationId = organization.id
  const member = async (userId: string, role: string) =>
    prisma.member.create({
      data: { id: randomUUID(), organizationId, userId, role, createdAt: days(30) },
    })
  const ada = await member(users.ada.id, 'owner')
  const bob = await member(users.bob.id, 'admin')
  const carol = await member(users.carol.id, 'member')

  const workspace = await prisma.workspace.create({
    data: { organizationId, name: 'Acme', createdAt: days(30) },
  })
  const workspaceId = workspace.id
  const scope = { organizationId, workspaceId }
  const db = scoped(scope)
  const inWorkspace = { organizationId, workspaceId }
  const asAda: Actor = { type: 'member', id: ada.id }

  await audit({
    ...scope,
    actor: asAda,
    action: 'workspace.created',
    target: { type: 'workspace', id: workspaceId },
    data: { name: 'Acme' },
  })

  // The workspace's cloud computer. No runner answers in a preview, so it shows stopped.
  const computer = await prisma.computer.create({
    data: {
      ...inWorkspace,
      kind: 'cloud',
      name: 'Acme cloud',
      size: 'standard',
      status: 'stopped',
      createdAt: days(30),
    },
  })

  // A Claude account per member: onboarding is done, and threads show usage.
  const usage = [
    { window: 'five_hour', utilization: 0.32, resetsAt: hours(-3).toISOString() },
    { window: 'seven_day', utilization: 0.58, resetsAt: days(-4).toISOString() },
  ]
  const account = async (memberId: string, email: string, plan: string) =>
    prisma.account.create({
      data: {
        ...inWorkspace,
        memberId,
        computerId: computer.id,
        provider: 'claude_code',
        source: 'brigade',
        label: `Claude (${email})`,
        email,
        plan,
        status: 'ready',
        isDefault: true,
        lastUsage: usage,
        lastUsageAt: minutes(20),
        createdAt: days(30),
      },
    })
  const adaAccount = await account(ada.id, 'ada@example.com', 'max')
  const bobAccount = await account(bob.id, 'bob@example.com', 'pro')
  await account(carol.id, 'carol@example.com', 'pro')

  // -------------------------------------------------------------------------
  // Teammates
  // -------------------------------------------------------------------------
  const teammate = (data: {
    name: string
    kind?: 'chief' | 'teammate'
    instructions?: string
    caps?: object
    permissionPolicy?: object
    libraryAccess?: 'read' | 'read_write'
    archivedAt?: Date
  }) => prisma.teammate.create({ data: { ...inWorkspace, ...data, createdAt: days(29) } })
  const chief = await teammate({ name: 'Chief', kind: 'chief' })
  const riley = await teammate({
    name: 'Riley',
    instructions:
      'Full-stack engineer on the Acme web app (Next.js, Postgres).\nOpen a pull request for every change; never push to main.',
    libraryAccess: 'read_write',
    caps: { threadsPerDay: 40 },
  })
  const sam = await teammate({
    name: 'Sam',
    instructions:
      'Customer support: answers support@acme.test, looks customers up in Stripe.\nRefunds over $100 need a person to approve.',
    permissionPolicy: { connectorWrites: 'ask' },
    caps: { writeCallsPerConnectionPerDay: 20 },
  })
  const maya = await teammate({
    name: 'Maya',
    instructions:
      'Marketing: newsletter, launch posts and the blog, in the brand voice (Marketing/brand-voice.md).',
    libraryAccess: 'read_write',
  })
  await teammate({
    name: 'Quinn',
    instructions: 'Sales research for outbound. Archived when the pilot ended.',
    archivedAt: days(10),
  })

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------
  const project = async (data: {
    name: string
    icon: string
    brief: string
    folder: string
    repositories?: string[]
  }) => {
    const { repositories = [], ...rest } = data
    const row = await prisma.project.create({
      data: { ...inWorkspace, ...rest, createdAt: days(28) },
    })
    if (repositories.length)
      await prisma.projectRepository.createMany({
        data: repositories.map((repository) => ({ ...inWorkspace, projectId: row.id, repository })),
      })
    await prisma.libraryFolder.create({
      data: { ...inWorkspace, path: data.folder, createdByType: 'member', createdById: ada.id },
    })
    return row
  }
  const website = await project({
    name: 'Website',
    icon: 'W',
    brief:
      'acme.test: the marketing site and the customer dashboard. Next.js 15, Tailwind, Postgres on Neon. Deploys from main on Vercel.',
    folder: 'Projects/Website',
    repositories: ['acme/web'],
  })
  const support = await project({
    name: 'Support',
    icon: 'S',
    brief:
      'Customer support for Acme: the support@ inbox, refunds and plan changes in Stripe. Reply within a business day, in plain words.',
    folder: 'Projects/Support',
  })
  const launch = await project({
    name: 'Fall launch',
    icon: 'L',
    brief:
      'The October launch of Acme Teams: landing page, newsletter, launch post and the sales deck.',
    folder: 'Projects/Fall launch',
  })

  // -------------------------------------------------------------------------
  // Connections, credentials and triggers. Secrets are placeholders.
  // -------------------------------------------------------------------------
  // Each account belongs to its App: one per kind, and one per custom app.
  const apps = new Map<string, string>()
  const connection = async (data: {
    kind: 'gmail' | 'stripe' | 'webhook'
    label: string
    externalAccount?: string
    secret?: unknown
    by?: { id: string }
    reach?: 'mine' | 'workspace'
  }) => {
    const { secret, by = ada, ...rest } = data
    const id = randomUUID()
    const key = data.kind === 'webhook' ? `custom:${id}` : data.kind
    if (!apps.has(key)) {
      const app = await prisma.app.create({
        data: {
          ...inWorkspace,
          key,
          name: data.kind === 'webhook' ? data.label : null,
          createdByMemberId: by.id,
          createdAt: days(27),
        },
      })
      apps.set(key, app.id)
    }
    return prisma.connection.create({
      data: {
        ...inWorkspace,
        ...rest,
        id,
        appId: apps.get(key)!,
        vaultSecretId: secret === undefined ? null : await sealSecret(db, scope, secret),
        createdByMemberId: by.id,
        createdAt: days(27),
      },
    })
  }
  const gmail = await connection({
    kind: 'gmail',
    label: 'Support inbox',
    externalAccount: 'support@acme.test',
    secret: { accessToken: 'sample', refreshToken: 'sample', expiresAt: 0 },
  })
  const stripe = await connection({
    kind: 'stripe',
    label: 'Stripe (test mode)',
    externalAccount: 'Acme test account',
    secret: { apiKey: 'sk_test_sample' },
  })
  // Carol's own mailbox: a second account of the Gmail App, used only in her threads.
  const carolGmail = await connection({
    kind: 'gmail',
    label: 'carol@acme.test',
    externalAccount: 'carol@acme.test',
    secret: { accessToken: 'sample', refreshToken: 'sample', expiresAt: 0 },
    by: carol,
    reach: 'mine',
  })
  const webhook = await connection({ kind: 'webhook', label: 'Status page' })
  await prisma.grant.createMany({
    data: [
      { ...inWorkspace, teammateId: sam.id, connectionId: gmail.id, scope: 'read_write' },
      { ...inWorkspace, teammateId: sam.id, connectionId: stripe.id, scope: 'read_write' },
      { ...inWorkspace, teammateId: maya.id, connectionId: gmail.id, scope: 'read' },
      { ...inWorkspace, teammateId: maya.id, connectionId: carolGmail.id, scope: 'read' },
      { ...inWorkspace, teammateId: riley.id, connectionId: webhook.id, scope: 'read' },
    ],
  })

  const credential = async (data: {
    kind: 'website' | 'api_key' | 'database'
    name: string
    details: object
    access?: 'all' | 'selected'
  }) =>
    prisma.credential.create({
      data: {
        ...inWorkspace,
        ...data,
        vaultSecretId: await sealSecret(db, scope, { secret: 'sample' }),
        createdByMemberId: ada.id,
        createdAt: days(20),
      },
    })
  await credential({
    kind: 'website',
    name: 'Vercel',
    details: { url: 'https://vercel.com/login', username: 'ops@acme.test' },
  })
  const analytics = await credential({
    kind: 'api_key',
    name: 'Plausible',
    details: { url: 'https://plausible.io/api' },
    access: 'selected',
  })
  await credential({
    kind: 'database',
    name: 'Staging database',
    details: { host: 'staging.db.acme.test', port: '5432', database: 'acme', username: 'readonly' },
    access: 'selected',
  })
  await prisma.credentialGrant.create({
    data: { ...inWorkspace, credentialId: analytics.id, teammateId: maya.id, withoutAsking: true },
  })

  const supportTrigger = await prisma.trigger.create({
    data: {
      ...inWorkspace,
      connectionId: gmail.id,
      teammateId: sam.id,
      label: 'New email to support@',
      event: 'gmail.email_received',
      options: { query: 'to:support@acme.test' },
      createdByMemberId: ada.id,
      projectId: support.id,
      createdAt: days(26),
    },
  })
  await prisma.trigger.create({
    data: {
      ...inWorkspace,
      connectionId: webhook.id,
      teammateId: riley.id,
      label: 'Incident opened on the status page',
      event: 'webhook.received',
      pathToken: id() + id(),
      verification: 'none',
      createdByMemberId: ada.id,
      projectId: website.id,
      createdAt: days(26),
    },
  })

  const digest = await prisma.schedule.create({
    data: {
      ...inWorkspace,
      teammateId: sam.id,
      title: 'Weekly support digest',
      instructions:
        "Summarize last week's support emails: volume, top three topics, refunds given. Save it to Projects/Support/digests/ named by the week's Monday.",
      cron: '0 9 * * 1',
      timezone: 'Europe/Paris',
      ownerMemberId: ada.id,
      projectId: support.id,
      nextRunAt: nextMonday9(),
      createdAt: days(21),
    },
  })
  await prisma.schedule.create({
    data: {
      ...inWorkspace,
      teammateId: maya.id,
      title: 'Monthly blog ideas',
      instructions: 'Suggest five blog post ideas for next month, with a one-line pitch each.',
      cron: '0 10 1 * *',
      timezone: 'Europe/Paris',
      ownerMemberId: bob.id,
      pausedAt: days(5),
      nextRunAt: null,
      createdAt: days(21),
    },
  })

  // -------------------------------------------------------------------------
  // Threads, each with the events its timeline shows
  // -------------------------------------------------------------------------
  const thread = async (data: {
    title: string
    teammateId: string
    member: { id: string }
    accountId: string
    status: 'idle' | 'running' | 'waiting' | 'paused' | 'failed' | 'done'
    startedAt: Date
    events: Draft[]
    projectId?: string
    others?: string[]
    origin?: 'member' | 'trigger' | 'schedule' | 'child'
    triggerId?: string
    scheduleId?: string
    private?: boolean
    // A child thread (src/children.ts): shown in its parent, out of the sidebar.
    id?: string
    parentId?: string
    parentTeammateId?: string
    awaited?: boolean
    report?: Prisma.InputJsonValue
    reportDeliveredAt?: Date
  }) => {
    const { events, others = [], member: by, startedAt, ...rest } = data
    // Events a minute or so apart, from when it started.
    const at = (i: number) => new Date(startedAt.getTime() + i * 47_000)
    const session = await prisma.session.create({
      data: {
        ...inWorkspace,
        ...rest,
        startedByMemberId: by.id,
        computerId: computer.id,
        lastSeq: events.length,
        createdAt: startedAt,
        updatedAt: at(events.length),
      },
    })
    await prisma.threadTeammate.createMany({
      data: [data.teammateId, ...others].map((teammateId) => ({
        ...inWorkspace,
        sessionId: session.id,
        teammateId,
        joinedAt: startedAt,
        lastTurnAt: at(events.length),
      })),
    })
    await prisma.sessionEvent.createMany({
      data: events.map((event, i) => ({
        ...inWorkspace,
        sessionId: session.id,
        seq: i + 1,
        type: event.type,
        data: { ...event, at: at(i).toISOString() } as Prisma.InputJsonValue,
        at: at(i),
      })),
    })
    return session
  }

  // A member's message and the teammate's answer, as one turn.
  const turn = (
    teammateId: string,
    accountId: string,
    text: string,
    memberId: string | null,
    steps: Draft[],
    answer?: string,
  ): Draft[] => [
    { type: 'message.user', text, memberId },
    { type: 'turn.started', teammateId, accountId, turnId: id() },
    ...steps.map((s) => ({ ...s, teammateId })),
    ...(answer
      ? [
          { type: 'message.done', id: id(), text: answer, teammateId } as Draft,
          { type: 'turn.completed', finishReason: 'stop', teammateId } as Draft,
        ]
      : []),
  ]
  const tool = (toolName: string, input: unknown, output: unknown, isError = false): Draft[] => {
    const toolCallId = `call_${id()}`
    return [
      { type: 'tool.started', toolCallId, toolName, input },
      { type: 'tool.finished', toolCallId, toolName, output, isError },
    ]
  }
  const harness = (name: string) => `mcp__harness-tools__${name}`

  // Done, with a pull request waiting for review: its task is in Needs you.
  const darkMode = await thread({
    title: 'Add dark mode to the pricing page',
    teammateId: riley.id,
    member: ada,
    accountId: adaAccount.id,
    status: 'idle',
    startedAt: hours(5),
    projectId: website.id,
    events: [
      ...turn(
        riley.id,
        adaAccount.id,
        'The pricing page ignores dark mode: the cards stay white. Can you fix it and open a PR?',
        ada.id,
        [
          {
            type: 'plan.updated',
            items: [
              { content: 'Find where the pricing cards set their colors', status: 'completed' },
              { content: 'Switch them to the theme tokens', status: 'completed' },
              { content: 'Check both themes and open a pull request', status: 'completed' },
            ],
          },
          ...tool(
            harness('checkout_repository'),
            { repository: 'acme/web' },
            {
              directory: 'web',
              branch: 'brigade/riley-pricing-dark',
            },
          ),
          ...tool(
            'Bash',
            { command: 'grep -rn "bg-white" app/pricing' },
            'app/pricing/plan-card.tsx:14:  <div className="rounded-xl bg-white p-6 shadow">',
          ),
          { type: 'file.changed', path: 'web/app/pricing/plan-card.tsx', toolName: 'Edit' },
          ...tool('Bash', { command: 'pnpm test pricing' }, 'Tests: 12 passed, 12 total'),
          { type: 'repositories.changed', repositories: ['acme/web'] },
          ...tool(
            harness('github_create_pull_request'),
            {
              repository: 'acme/web',
              title: 'Pricing cards follow the theme',
              head: 'brigade/riley-pricing-dark',
            },
            { number: 128, url: 'https://github.com/acme/web/pull/128' },
          ),
          {
            type: 'usage.updated',
            inputTokens: 48_210,
            outputTokens: 3_904,
            status: 'allowed',
            limits: usage,
          },
        ],
        'Done: the pricing cards used `bg-white`, so they ignored the theme. They now use `bg-card` and `text-card-foreground`, and the tests pass.\n\nPull request: [acme/web#128](https://github.com/acme/web/pull/128).',
      ),
    ],
  })

  // Waits on an approval: Sam wants to refund a customer through Stripe.
  const refund = await thread({
    title: 'Refund request from Jamie Lee',
    teammateId: sam.id,
    member: ada,
    accountId: adaAccount.id,
    status: 'waiting',
    startedAt: minutes(40),
    projectId: support.id,
    origin: 'trigger',
    triggerId: supportTrigger.id,
    events: turn(
      sam.id,
      adaAccount.id,
      'New email to support@acme.test from Jamie Lee <jamie@example.org>:\n\nSubject: Charged twice\n\nHi, I was charged twice for my Pro plan this month ($149 each). Could you refund one of them? Thanks, Jamie',
      null,
      [
        ...tool(harness('stripe_search_customers'), { email: 'jamie@example.org' }, [
          { id: 'cus_Sample1', name: 'Jamie Lee', email: 'jamie@example.org' },
        ]),
        ...tool(harness('stripe_list_charges'), { customer: 'cus_Sample1' }, [
          { id: 'ch_Sample1', amount: 14900, created: '2026-10-01' },
          { id: 'ch_Sample2', amount: 14900, created: '2026-10-01' },
        ]),
        {
          type: 'message.delta',
          id: id(),
          text: 'Jamie was charged twice on October 1st. Refunding the second charge needs your approval.',
        },
        {
          type: 'tool.started',
          toolCallId: `call_${id()}`,
          toolName: harness('stripe_refund'),
          input: { charge: 'ch_Sample2', amount: 14900, reason: 'duplicate' },
        },
      ],
    ),
  })
  await prisma.ticket.create({
    data: {
      ...inWorkspace,
      sessionId: refund.id,
      type: 'approval',
      title: 'Sam: stripe refund (ch_Sample2, $149.00)',
      payload: {
        connectionId: stripe.id,
        connection: 'Acme test account',
        operation: 'stripe_refund',
        target: 'ch_Sample2, $149.00',
        input: { charge: 'ch_Sample2', amount: 14900, reason: 'duplicate' },
      },
      createdAt: minutes(38),
    },
  })
  await prisma.connectionCall.createMany({
    data: [
      ['stripe_search_customers', false, 'jamie@example.org', 'ok'],
      ['stripe_list_charges', false, 'cus_Sample1', 'ok'],
      ['stripe_refund', true, 'ch_Sample2, $149.00', 'awaiting_approval'],
    ].map(([operation, write, target, result]) => ({
      ...inWorkspace,
      sessionId: refund.id,
      connectionId: stripe.id,
      teammateId: sam.id,
      operation: operation as string,
      write: write as boolean,
      target: target as string,
      result: result as string,
      createdAt: minutes(39),
    })),
  })

  // Waits on a ticket Maya opened: sign-off on a newsletter draft.
  const newsletterDraft =
    '**Subject:** Meet Acme Teams\n\nHi {{first_name}},\n\nThis month we launch **Acme Teams**: shared workspaces, roles and one bill for the whole team.\n\n- Invite your team in one click\n- Owners, admins and members\n- One invoice, per seat\n\nTry it free for 30 days → acme.test/teams\n\nThe Acme team'
  const requestId = `call_${id()}`
  const newsletter = await thread({
    title: 'Draft the October newsletter',
    teammateId: maya.id,
    member: bob,
    accountId: bobAccount.id,
    status: 'waiting',
    startedAt: hours(2),
    projectId: launch.id,
    events: turn(
      maya.id,
      bobAccount.id,
      'Draft the October newsletter announcing Acme Teams. Keep it short; I want to see it before it goes out.',
      bob.id,
      [
        ...tool(
          'Read',
          { file_path: 'library/Marketing/brand-voice.md' },
          '# Brand voice\n\nPlain, warm, short...',
        ),
        {
          type: 'ticket.opened',
          requestId,
          title: 'Sign off on the October newsletter',
          asks: [
            { id: 'draft', type: 'approval', title: 'October newsletter', draft: newsletterDraft },
            {
              id: 'send-day',
              type: 'decision',
              question: 'When should it go out?',
              options: [
                { id: 'tue', label: 'Tuesday 10:00' },
                { id: 'thu', label: 'Thursday 10:00' },
              ],
            },
          ],
        },
      ],
    ),
  })
  await prisma.ticket.create({
    data: {
      ...inWorkspace,
      sessionId: newsletter.id,
      type: 'request',
      title: 'Maya: Sign off on the October newsletter',
      payload: {
        source: 'harness',
        teammateId: maya.id,
        requestId,
        asks: [
          { id: 'draft', type: 'approval', title: 'October newsletter', draft: newsletterDraft },
          {
            id: 'send-day',
            type: 'decision',
            question: 'When should it go out?',
            options: [
              { id: 'tue', label: 'Tuesday 10:00' },
              { id: 'thu', label: 'Thursday 10:00' },
            ],
          },
        ],
      },
      createdAt: hours(2),
    },
  })

  // Waits on a question the harness asked.
  const questionId = `q_${id()}`
  const questions = [
    {
      id: 'plan',
      question:
        'Globex asks to move from Pro to Business mid-cycle. Prorate the difference or start Business next month?',
      header: 'Plan change',
      options: [
        { id: 'prorate', label: 'Prorate now' },
        { id: 'next', label: 'From next month' },
      ],
    },
  ]
  const planChange = await thread({
    title: 'Globex plan upgrade',
    teammateId: sam.id,
    member: carol,
    accountId: adaAccount.id,
    status: 'waiting',
    startedAt: minutes(15),
    projectId: support.id,
    events: turn(
      sam.id,
      adaAccount.id,
      'Globex wants to upgrade to Business. Can you handle it?',
      carol.id,
      [{ type: 'question.asked', questionId, questions }],
    ),
  })
  await prisma.ticket.create({
    data: {
      ...inWorkspace,
      sessionId: planChange.id,
      type: 'question',
      title: `Sam asks: ${questions[0]!.question}`,
      payload: { source: 'harness', teammateId: sam.id, questionId, questions },
      createdAt: minutes(14),
    },
  })

  // Finished long ago, with a summary: its task is done.
  const checkout = await thread({
    title: 'Why is checkout slow on mobile?',
    teammateId: riley.id,
    member: ada,
    accountId: adaAccount.id,
    status: 'idle',
    startedAt: days(3),
    projectId: website.id,
    events: [
      ...turn(
        riley.id,
        adaAccount.id,
        'Checkout takes 6 seconds to show on phones. Find out why.',
        ada.id,
        [
          ...tool(
            'Bash',
            { command: 'pnpm lighthouse /checkout --preset=mobile' },
            'LCP 5.8 s, TBT 1,240 ms; largest script: stripe-js (412 kB)',
          ),
          ...tool(
            harness('save_to_library'),
            { path: 'Projects/Website/checkout-performance.md' },
            { saved: true },
          ),
        ],
        "Stripe's script loads on every page and blocks the checkout render. Loading it only on /checkout, after the form, brings LCP to 1.9 s on a mid-range phone. Notes in Projects/Website/checkout-performance.md.",
      ),
      ...turn(
        riley.id,
        adaAccount.id,
        'Great, ship it.',
        ada.id,
        [],
        'Merged in acme/web#121 and deployed.',
      ),
    ],
  })

  // The chief setting up the team, the first day.
  const setup = await thread({
    title: 'Set up the team',
    teammateId: chief.id,
    member: ada,
    accountId: adaAccount.id,
    status: 'idle',
    startedAt: days(29),
    events: turn(
      chief.id,
      adaAccount.id,
      'We are a 12-person SaaS. We need help with engineering, support and marketing.',
      ada.id,
      [],
      'I suggest three teammates: **Riley** for engineering, **Sam** for support and **Maya** for marketing. I created them; give Sam the support inbox and Stripe from Connections.',
    ),
  })

  // A run of the weekly schedule.
  await thread({
    title: 'Weekly support digest',
    teammateId: sam.id,
    member: ada,
    accountId: adaAccount.id,
    status: 'idle',
    startedAt: days(1),
    projectId: support.id,
    origin: 'schedule',
    scheduleId: digest.id,
    events: turn(
      sam.id,
      adaAccount.id,
      digest.instructions,
      null,
      [
        ...tool(
          harness('gmail_search'),
          { query: 'to:support@acme.test newer_than:7d' },
          { count: 64 },
        ),
      ],
      '64 emails last week (+12%). Top topics: billing (21), SSO setup (14), CSV export (9). Two refunds, $298 in all. Saved to Projects/Support/digests/2026-10-05.md.',
    ),
  })

  // Failed: the computer stopped mid-turn. Its task stays in Doing.
  const upgrade = await thread({
    title: 'Upgrade Next.js to 16',
    teammateId: riley.id,
    member: bob,
    accountId: bobAccount.id,
    status: 'failed',
    startedAt: hours(20),
    projectId: website.id,
    events: [
      ...turn(
        riley.id,
        bobAccount.id,
        'Upgrade acme/web to Next.js 16 and fix what breaks.',
        bob.id,
        [
          ...tool(
            'Bash',
            { command: 'pnpm up next@16' },
            'ERR_PNPM_PEER_DEP_ISSUES  Unmet peer dependencies',
            true,
          ),
        ],
      ),
      { type: 'error', message: 'The computer stopped answering during the turn.' },
    ],
  })

  // A private thread, with two teammates.
  await thread({
    title: 'Launch post outline',
    teammateId: maya.id,
    member: bob,
    accountId: bobAccount.id,
    status: 'idle',
    startedAt: hours(30),
    projectId: launch.id,
    others: [riley.id],
    private: true,
    events: [
      ...turn(
        maya.id,
        bobAccount.id,
        'Outline the launch post for Acme Teams.',
        bob.id,
        [],
        '1. The problem: one login per person, five bills\n2. Teams: shared workspaces and roles\n3. Billing per seat\n4. How to start',
      ),
      ...turn(
        riley.id,
        bobAccount.id,
        '@Riley anything technical worth adding?',
        bob.id,
        [],
        'SSO (SAML) comes with Business, and the API gets team-scoped tokens: worth a line in section 2.',
      ),
    ],
  })

  // -------------------------------------------------------------------------
  // Tasks, one per column
  // -------------------------------------------------------------------------
  const task = (data: {
    title: string
    description: string
    priority?: 'low' | 'medium' | 'high' | 'urgent'
    teammateId?: string
    projectId?: string
    createdByMemberId?: string
    completedAt?: Date
    archivedAt?: Date
    trashedAt?: Date
    summary?: string
    deliverables?: { label: string; url: string }[]
    sessionId?: string
    parentId?: string
    createdAt: Date
  }) => {
    const { sessionId, ...rest } = data
    return prisma.task
      .create({ data: { ...inWorkspace, createdByMemberId: ada.id, ...rest } })
      .then(async (row) => {
        if (sessionId)
          await prisma.session.update({
            where: { id: sessionId },
            // Keep when it last moved: thread lists sort by it.
            data: {
              taskId: row.id,
              updatedAt: (await prisma.session.findUniqueOrThrow({ where: { id: sessionId } }))
                .updatedAt,
            },
          })
        return row
      })
  }
  await task({
    title: 'Add CSV export to the billing page',
    description:
      'Customers ask for their invoices as CSV. One button on /billing, all invoices of the year.',
    priority: 'medium',
    projectId: website.id,
    createdAt: days(4),
  })
  // A mission: one card on the board for the launch's tasks.
  const launchMission = await task({
    title: 'Launch Acme Teams',
    description:
      'Everything for the Teams launch on November 4: the sales deck, the newsletter and the blog post.',
    priority: 'medium',
    projectId: launch.id,
    createdByMemberId: bob.id,
    createdAt: days(3),
  })
  await task({
    title: 'Publish the launch blog post',
    description:
      'A post on acme.com/blog announcing Teams, with the pricing and two customer quotes.',
    priority: 'medium',
    projectId: launch.id,
    createdByMemberId: bob.id,
    parentId: launchMission.id,
    createdAt: days(2),
  })
  await task({
    title: 'Write the Acme Teams sales deck',
    description: '10 slides for sales calls: problem, Teams, pricing, security, customer quotes.',
    priority: 'low',
    projectId: launch.id,
    createdByMemberId: bob.id,
    parentId: launchMission.id,
    createdAt: days(2),
  })
  await task({
    title: 'Add dark mode to the pricing page',
    description: 'The pricing cards stay white in dark mode. Done when the PR is merged.',
    priority: 'high',
    teammateId: riley.id,
    projectId: website.id,
    sessionId: darkMode.id,
    createdAt: hours(5),
  })
  await task({
    title: 'Upgrade Next.js to 16',
    description: 'Move acme/web to Next.js 16 and fix what breaks; the tests must pass.',
    priority: 'medium',
    teammateId: riley.id,
    projectId: website.id,
    createdByMemberId: bob.id,
    sessionId: upgrade.id,
    createdAt: hours(20),
  })
  await task({
    title: 'October newsletter',
    description: 'Announce Acme Teams to the newsletter list, approved by Bob before sending.',
    priority: 'medium',
    teammateId: maya.id,
    projectId: launch.id,
    createdByMemberId: bob.id,
    sessionId: newsletter.id,
    parentId: launchMission.id,
    createdAt: hours(2),
  })
  await task({
    title: 'Speed up checkout on mobile',
    description: 'Checkout takes 6 s to show on phones; get it under 2.5 s LCP.',
    priority: 'urgent',
    teammateId: riley.id,
    projectId: website.id,
    sessionId: checkout.id,
    completedAt: days(2),
    summary:
      'Stripe.js now loads only on /checkout, after the form: LCP 1.9 s on a mid-range phone.',
    deliverables: [
      { label: 'acme/web#121', url: 'https://github.com/acme/web/pull/121' },
      { label: 'Checkout performance notes', url: 'Projects/Website/checkout-performance.md' },
    ],
    createdAt: days(3),
  })
  await task({
    title: 'Set up the team',
    description: 'Teammates for engineering, support and marketing.',
    teammateId: chief.id,
    sessionId: setup.id,
    completedAt: days(29),
    archivedAt: days(20),
    summary: 'Riley, Sam and Maya created.',
    createdAt: days(29),
  })
  await task({
    title: 'Try a chatbot on the docs',
    description: 'Dropped: the docs search is enough for now.',
    priority: 'low',
    trashedAt: days(6),
    createdAt: days(12),
  })

  // -------------------------------------------------------------------------
  // The pull request Riley opened, approved by a review
  // -------------------------------------------------------------------------
  const pull = await prisma.pullRequest.create({
    data: {
      ...inWorkspace,
      repository: 'acme/web',
      number: 128,
      title: 'Pricing cards follow the theme',
      headRef: 'brigade/riley-pricing-dark',
      baseRef: 'main',
      sessionId: darkMode.id,
      authorTeammateId: riley.id,
      reviewerTeammateId: chief.id,
      reviewStatus: 'approved',
      round: 1,
      reviewedSha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
      requestedByMemberId: ada.id,
      createdAt: hours(4),
    },
  })
  await prisma.pullRequestReview.create({
    data: {
      ...inWorkspace,
      pullRequestId: pull.id,
      teammateId: chief.id,
      verdict: 'approve',
      body: 'Looks right: the cards use the theme tokens and both themes were checked.',
      sha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
      round: 1,
      createdAt: hours(3),
    },
  })

  // -------------------------------------------------------------------------
  // Library and memory
  // -------------------------------------------------------------------------
  const file = (path: string, text: string, actor: Actor = asAda) =>
    saveLibraryFile(db, scope, actor, { path, bytes: new TextEncoder().encode(text) })
  const asRiley: Actor = { type: 'teammate', id: riley.id }
  const asMaya: Actor = { type: 'teammate', id: maya.id }
  await file(
    'Company/handbook.md',
    '# Acme handbook\n\n## Who we are\n\nAcme makes project tracking for small teams. 12 people, remote, in Paris and Lisbon.\n\n## How we work\n\n- Write things down; decisions go in the library.\n- Customers hear back within one business day.\n- Ship small, ship often: main deploys on every merge.\n',
  )
  await file(
    'Projects/Website/launch-checklist.md',
    '# Launch checklist\n\n- [x] Pricing page with the Teams plan\n- [x] Dark mode on every page\n- [ ] Status page linked from the footer\n- [ ] Open Graph images\n',
  )
  await file(
    'Projects/Website/checkout-performance.md',
    '# Checkout performance\n\nMeasured on a Moto G Power, 4G throttled.\n\n| | Before | After |\n|---|---|---|\n| LCP | 5.8 s | 1.9 s |\n| TBT | 1,240 ms | 180 ms |\n\nStripe.js was loaded on every page. It now loads on /checkout only, after the form renders.\n',
    asRiley,
  )
  await file(
    'Projects/Support/refund-policy.md',
    '# Refund policy\n\n- Duplicate charges: refund at once, no questions.\n- Within 14 days of a renewal: full refund on request.\n- Refunds over $100 need a person to approve.\n',
  )
  await file(
    'Projects/Support/macros.md',
    '# Reply macros\n\n## Duplicate charge\n\nSorry about that! I refunded the second charge; it shows on your statement in 5 to 10 days.\n\n## SSO setup\n\nSSO comes with the Business plan. Here is the guide: acme.test/docs/sso\n',
  )
  await file(
    'Projects/Fall launch/newsletter-draft.md',
    `# October newsletter (draft)\n\n${newsletterDraft}\n`,
    asMaya,
  )
  await file(
    'Marketing/brand-voice.md',
    '# Brand voice\n\nPlain, warm, short. Say what it does, not how great it is.\n\n**Do:** "Invite your team in one click."\n**Don\'t:** "Revolutionize your collaboration paradigm."\n',
  )
  await file(
    'Data/customers.csv',
    'name,email,plan,seats,mrr\nGlobex,ops@globex.test,pro,18,342\nInitech,it@initech.test,business,40,1560\nUmbrella,billing@umbrella.test,pro,7,133\nHooli,team@hooli.test,business,95,3705\n',
  )
  // A restricted folder: only teammates with a grant reach it.
  const finance = await prisma.libraryFolder.create({
    data: {
      ...inWorkspace,
      path: 'Finance',
      restricted: true,
      createdByType: 'member',
      createdById: ada.id,
    },
  })
  await prisma.libraryFolderGrant.create({
    data: { ...inWorkspace, folderId: finance.id, teammateId: sam.id, access: 'read' },
  })
  await file(
    'Finance/q3-revenue.csv',
    'month,mrr,new,churned\n2026-07,48200,3100,900\n2026-08,51900,4500,800\n2026-09,55400,4300,800\n',
  )

  await writeMemory(
    db,
    scope,
    asAda,
    { kind: 'workspace_memory' },
    '# Workspace memory\n\n- Acme is a 12-person SaaS selling project tracking to small teams.\n- Customers are answered within one business day.\n- Refunds over $100 need a person to approve.\n- main deploys to production on every merge.\n',
  )
  // A core every thread in the project loads, and topics read when the work touches them.
  await writeMemory(
    db,
    scope,
    asAda,
    { kind: 'project_memory', projectId: website.id },
    [
      '# Website memory',
      '',
      '- Use the theme tokens (bg-card, text-foreground), never raw colors.',
      '- Run `pnpm test` before opening a pull request.',
      '',
      '## Checkout',
      '',
      'Read before touching the checkout or payments.',
      '',
      '- Previews use Stripe in test mode; production is the live account: never test there.',
      '- Only the checkout page loads Stripe.js.',
      '',
      '## Pricing page',
      '',
      'Read before changing prices or plans.',
      '',
      '- Prices come from the Stripe catalog; the page never hard-codes them.',
      '- Annual plans show the monthly price, billed yearly.',
      '',
    ].join('\n'),
  )
  // A thread corrected a line: the old one is in the archive, with why.
  await editMemory(
    db,
    scope,
    { type: 'teammate', id: riley.id },
    { kind: 'project_memory', projectId: website.id, name: website.name },
    MemoryEdit.parse({
      replace: [
        {
          from: 'Annual plans show the monthly price, billed yearly.',
          to: 'Annual plans show the yearly price, with the monthly equivalent under it.',
        },
      ],
    }),
    checkout.id,
  )
  await writeMemory(
    db,
    scope,
    asAda,
    { kind: 'teammate_memory', teammateId: riley.id },
    '# What Riley has learned\n\n- Stripe.js is heavy: load it only on the pages that pay.\n- Bob reviews pull requests on acme/web in the afternoon.\n',
  )
  await saveSummary(
    db,
    scope,
    checkout,
    'Stripe.js blocked the mobile checkout render; loading it only on /checkout brought LCP from 5.8 s to 1.9 s. Merged in acme/web#121.',
  )
  await saveSummary(
    db,
    scope,
    setup,
    'Created Riley (engineering), Sam (support) and Maya (marketing).',
  )

  // Child threads: Riley split an investigation in two and was woken once both reported;
  // one still waits on a person. A schedule made there reports its runs to it.
  const parentId = `seed-parent-${id()}`
  const bisectAgain = [
    'Found the cause and a workaround; nothing pushed.',
    '',
    '- **First bad:** `16.3.0-canary.34` (vercel/next.js#94062)',
    '- **Cause:** the client router cache keeps the payload of a page reached by `<Link>`, so an edit never reaches it',
    '- **Workaround:** `experimental.staleTimes.dynamic = 0` in `next.config.ts`',
    '',
    'A page opened by its URL is not cached that way, which is why it still updates.',
  ].join('\n')
  // Ids like production's (letters and digits): a report note names its child by id.
  const bisectId = `seedchild${id()}`
  const upgradeId = `seedchild${id()}`
  const started = (threadId: string, title: string, instructions: string) =>
    tool(
      harness('start_child'),
      { title, instructions, wait: true },
      { threadId, title, teammate: riley.name },
    )
  await thread({
    id: parentId,
    title: 'Live reload stops after navigating in the dashboard',
    teammateId: riley.id,
    member: ada,
    accountId: adaAccount.id,
    status: 'idle',
    startedAt: days(3),
    projectId: website.id,
    events: [
      ...turn(
        riley.id,
        adaAccount.id,
        'Editing a file no longer updates a page reached by a link, only one opened by its URL. Find out why.',
        ada.id,
        [
          ...started(
            bisectId,
            'Bisect the Next.js versions',
            'Find the first Next.js version where a page reached by a link stops updating on edit.',
          ),
          ...started(
            upgradeId,
            'Try Next 16.4.2 on acme/web',
            'Upgrade acme/web to Next 16.4.2 and check whether a page reached by a link updates on edit.',
          ),
        ],
        'I started two threads beside this one: a bisect of Next.js, and a try of 16.4.2 on acme/web. I will be back here with both answers.',
      ),
      ...turn(
        riley.id,
        adaAccount.id,
        `2 child threads you were waiting for have finished:\n- Riley · “Bisect the Next.js versions” (${bisectId}): reports. It broke in 16.3.0-canary.34 (vercel/next.js#94062); 16.3.0-canary.33 works.\n- Riley · “Try Next 16.4.2 on acme/web” (${upgradeId}): needs a person (a ticket is open in it). The upgrade does not fix it.`,
        null,
        [],
        'Found it: live reload broke in Next 16.3.0-canary.34 (vercel/next.js#94062), and 16.4.2 does not fix it. Its upgrade thread asks you whether to keep 16.4.2 anyway.',
      ),
      // Asked again (message_thread), the bisect reports once more, in Markdown.
      ...turn(
        riley.id,
        adaAccount.id,
        singleNote({
          id: bisectId,
          title: 'Bisect the Next.js versions',
          teammate: riley.name,
          schedule: null,
          report: { status: 'report', summary: bisectAgain, at: days(2).toISOString() },
        }),
        null,
        [],
        'Until the fix ships, `experimental.staleTimes.dynamic = 0` brings live reload back. Want me to add it to acme/web?',
      ),
    ],
  })
  await thread({
    id: bisectId,
    title: 'Bisect the Next.js versions',
    teammateId: riley.id,
    member: ada,
    accountId: adaAccount.id,
    status: 'idle',
    startedAt: days(3),
    projectId: website.id,
    origin: 'child',
    parentId,
    parentTeammateId: riley.id,
    awaited: true,
    report: {
      status: 'report',
      summary: 'It broke in 16.3.0-canary.34 (vercel/next.js#94062); 16.3.0-canary.33 works.',
      at: days(3).toISOString(),
    },
    reportDeliveredAt: days(3),
    events: [
      ...turn(
        riley.id,
        adaAccount.id,
        childPrompt({
          from: riley.name,
          parentTitle: 'Live reload stops after navigating in the dashboard',
          instructions:
            'Find the first Next.js version where a page reached by a link stops updating on edit.',
        }),
        null,
        [
          ...tool(
            'Bash',
            { command: 'node bisect.mjs 16.2.12 16.4.2' },
            'first bad: 16.3.0-canary.34',
          ),
          ...tool(
            harness('report'),
            { status: 'report', summary: 'It broke in 16.3.0-canary.34 (vercel/next.js#94062).' },
            { ok: true },
          ),
        ],
        'Reported: 16.3.0-canary.34 is the first version that breaks.',
      ),
      ...turn(
        riley.id,
        adaAccount.id,
        parentMessage({
          from: riley.name,
          parentTitle: 'Live reload stops after navigating in the dashboard',
          text: 'Thanks. Please find **why** it broke in `16.3.0-canary.34`, and whether a setting in `next.config.ts` works around it. Then report again.',
        }),
        null,
        [...tool(harness('report'), { status: 'report', summary: bisectAgain }, { ok: true })],
        'Reported the cause and a workaround.',
      ),
    ],
  })
  const upgradeRequest = `call_${id()}`
  const upgradeAsks = [
    {
      id: 'keep',
      type: 'decision',
      question: '16.4.2 does not fix live reload. Keep the upgrade anyway?',
      options: [
        { id: 'keep', label: 'Keep 16.4.2' },
        { id: 'revert', label: 'Stay on 16.4.0' },
      ],
    },
  ]
  await thread({
    id: upgradeId,
    title: 'Try Next 16.4.2 on acme/web',
    teammateId: riley.id,
    member: ada,
    accountId: adaAccount.id,
    status: 'waiting',
    startedAt: days(3),
    projectId: website.id,
    origin: 'child',
    parentId,
    parentTeammateId: riley.id,
    awaited: true,
    report: {
      status: 'needs_person',
      summary: 'The upgrade does not fix it. Asked whether to keep 16.4.2 anyway.',
      at: days(3).toISOString(),
    },
    reportDeliveredAt: days(3),
    events: turn(
      riley.id,
      adaAccount.id,
      'Riley started this thread from the thread “Live reload stops after navigating in the dashboard” and waits for your report.\n\nUpgrade acme/web to Next 16.4.2 and check whether a page reached by a link updates on edit.',
      null,
      [
        ...tool('Bash', { command: 'pnpm add next@16.4.2' }, 'next 16.4.2'),
        {
          type: 'ticket.opened',
          requestId: upgradeRequest,
          title: 'Keep Next 16.4.2?',
          asks: upgradeAsks,
        },
      ],
    ),
  })
  await prisma.ticket.create({
    data: {
      ...inWorkspace,
      sessionId: upgradeId,
      type: 'request',
      title: 'Riley: Keep Next 16.4.2?',
      payload: {
        source: 'harness',
        teammateId: riley.id,
        requestId: upgradeRequest,
        asks: upgradeAsks,
      },
      createdAt: days(3),
    },
  })
  const watch = await prisma.schedule.create({
    data: {
      ...inWorkspace,
      teammateId: riley.id,
      title: 'Watch the Next.js live reload fix',
      instructions:
        'Check whether vercel/next.js#99550 is merged and in a release. Report nothing when it is not.',
      cron: '0 9 * * *',
      timezone: 'Europe/Paris',
      ownerMemberId: ada.id,
      createdByTeammateId: riley.id,
      // Reporting to a thread, it is in that thread's project.
      projectId: website.id,
      parentSessionId: parentId,
      nextRunAt: new Date(Date.now() + 86_400_000),
      createdAt: days(3),
    },
  })
  for (const [n, ago] of [
    [1, days(2)],
    [2, days(1)],
  ] as const)
    await thread({
      title: `Watch the Next.js live reload fix · run ${n}`,
      teammateId: riley.id,
      member: ada,
      accountId: adaAccount.id,
      status: 'idle',
      startedAt: ago,
      projectId: website.id,
      origin: 'schedule',
      scheduleId: watch.id,
      parentId,
      parentTeammateId: riley.id,
      report: { status: 'nothing', summary: 'Not merged yet.', at: ago.toISOString() },
      reportDeliveredAt: ago,
      events: turn(
        riley.id,
        adaAccount.id,
        'Scheduled run of "Watch the Next.js live reload fix". Check whether vercel/next.js#99550 is merged.',
        null,
        [],
        'Not merged yet.',
      ),
    })

  // -------------------------------------------------------------------------
  // Home's loose ends for Ada (src/home.ts): a proposal nobody answered, a running
  // thread gone quiet, an automation that could not start.
  // -------------------------------------------------------------------------
  await thread({
    title: 'Annual billing toggle on the pricing page',
    teammateId: riley.id,
    member: ada,
    accountId: adaAccount.id,
    status: 'idle',
    startedAt: hours(2),
    projectId: website.id,
    events: [
      ...turn(
        riley.id,
        adaAccount.id,
        'Can we offer annual billing on the pricing page, with two months free?',
        ada.id,
        [],
        'Yes: a Monthly / Annual toggle above the cards, annual prices shown per month with "2 months free" under them. Stripe already has the yearly prices, so it is only the page.',
      ),
      // Its buttons, as the runner records a replies block (apps/runner/src/harness/events.ts).
      ...tool(
        SUGGEST_REPLIES_TOOL,
        { replies: ['Build it and open a PR', 'Not yet'] },
        { shown: 2 },
      ),
    ],
  })
  await thread({
    title: 'Move the blog to MDX',
    teammateId: riley.id,
    member: ada,
    accountId: adaAccount.id,
    status: 'running',
    startedAt: hours(3),
    projectId: website.id,
    events: [
      ...turn(riley.id, adaAccount.id, 'Move the blog posts from Markdown to MDX.', ada.id, [
        ...tool('Bash', { command: 'pnpm add @next/mdx' }, 'Done in 4.2s'),
        {
          type: 'tool.started',
          toolCallId: `call_${id()}`,
          toolName: 'Bash',
          input: { command: 'pnpm build' },
        },
      ]),
    ],
  })
  await prisma.schedule.create({
    data: {
      ...inWorkspace,
      teammateId: maya.id,
      title: 'Daily signups report',
      instructions: "Count yesterday's signups by source and post the numbers to #growth.",
      cron: '0 8 * * *',
      timezone: 'Europe/Paris',
      ownerMemberId: ada.id,
      nextRunAt: new Date(Date.now() + 86_400_000),
      lastError: "None of Ada's computers was online.",
      createdAt: days(10),
    },
  })

  // The support playbook Sam runs, with its runs, approvals and dry run (seed-playbooks.ts).
  await seedPlaybooks({
    organizationId,
    workspaceId,
    ada: { memberId: ada.id, userId: users.ada.id },
    bob: { memberId: bob.id },
    chief: { id: chief.id, name: chief.name },
    sam: { id: sam.id, name: sam.name },
    computerId: computer.id,
    accountId: adaAccount.id,
    gmail,
    stripeId: stripe.id,
    projectId: support.id,
    repository: 'acme/web',
  })

  console.log('created: sample organization Acme (ada owner, bob admin, carol member)')
}

/** The next Monday at 9:00, roughly: the schedule's own computation runs when it fires. */
function nextMonday9() {
  const next = new Date()
  next.setUTCDate(next.getUTCDate() + ((8 - next.getUTCDay()) % 7 || 7))
  next.setUTCHours(7, 0, 0, 0)
  return next
}
