// Sample mail for the Inbox: Riley's own address, with conversations in each state (unassigned,
// not verified, taken by a thread with replies and quoted text, done). Made up, as the rest of
// the sample: nothing is sent or received. Added once, to a sample workspace without mail yet,
// so a preview made before this file gets it on its next start too.
import { randomUUID } from 'node:crypto'
import { prisma, scoped } from '../src/db.js'
import { enableAgentAddress } from '../src/mail/addresses.js'
import { SAMPLE_ORGANIZATION } from './seed-workspace.js'

const minutes = (n: number) => new Date(Date.now() - n * 60_000)
const hours = (n: number) => minutes(n * 60)
const days = (n: number) => hours(n * 24)

const PASS = { spf: 'pass', dkim: 'pass', dmarc: 'pass' }

export async function seedInbox() {
  const organization = await prisma.organization.findFirst({
    where: { slug: SAMPLE_ORGANIZATION },
    select: { id: true },
  })
  if (!organization) return
  const workspace = await prisma.workspace.findFirst({
    where: { organizationId: organization.id },
    select: { id: true },
  })
  if (!workspace) return
  const inWorkspace = { organizationId: organization.id, workspaceId: workspace.id }
  if (await prisma.mailMessage.count({ where: { workspaceId: workspace.id } })) return

  const [ada, riley] = await Promise.all([
    prisma.member.findFirst({ where: { organizationId: organization.id, role: 'owner' } }),
    prisma.teammate.findFirst({ where: { workspaceId: workspace.id, name: 'Riley' } }),
  ])
  if (!ada || !riley) return
  const thread = await prisma.session.findFirst({
    where: { workspaceId: workspace.id, teammateId: riley.id },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  })

  const scope = { ...inWorkspace, userId: ada.userId, memberId: ada.id, role: 'owner' as const }
  const address = await enableAgentAddress(scoped(scope), scope as never, riley, 'acme-riley')
  const own = (await prisma.connection.findFirst({ where: { id: address.connectionId! } }))!
    .externalAccount!
  const box = `${address.id}:-`

  type Mail = {
    conversation: string
    direction?: 'in' | 'out'
    from: [name: string, address: string]
    subject: string
    text: string
    at: Date
    route?: string
    sessionId?: string | null
    authentication?: Record<string, string>
    sender?: 'contact' | 'unknown'
    doneAt?: Date
  }
  const mail = (m: Mail) => {
    const out = m.direction === 'out'
    return prisma.mailMessage.create({
      data: {
        ...inWorkspace,
        addressId: address.id,
        box,
        direction: out ? 'out' : 'in',
        status: out ? 'delivered' : 'done',
        messageId: `<${randomUUID()}@sample.test>`,
        conversationId: m.conversation,
        fromName: m.from[0],
        fromAddress: m.from[1],
        to: [out ? 'jordan@globex.test' : own],
        subject: m.subject,
        text: m.text,
        authentication: out ? undefined : (m.authentication ?? PASS),
        sender: out ? null : (m.sender ?? 'unknown'),
        route: out ? null : (m.route ?? 'box'),
        sessionId: m.sessionId ?? null,
        teammateId: out ? riley.id : null,
        doneAt: m.doneAt ?? null,
        doneByMemberId: m.doneAt ? ada.id : null,
        receivedAt: m.at,
        createdAt: m.at,
      },
    })
  }

  // Unassigned: nobody took it.
  await mail({
    conversation: randomUUID(),
    from: ['Jordan Lee', 'jordan@globex.test'],
    subject: 'Question about the Teams plan',
    text: 'Hi,\n\nWe are 12 people and looking at the Teams plan. Can we pay yearly, and is there a discount for nonprofits?\n\nThanks,\nJordan',
    at: minutes(12),
  })
  // Unassigned, and its sender's domain did not check out.
  await mail({
    conversation: randomUUID(),
    from: ['Billing', 'billing@initech-payments.test'],
    subject: 'Invoice INV-2041 overdue',
    text: 'Your invoice INV-2041 is overdue. Please pay within 24 hours to avoid suspension.',
    at: hours(3),
    authentication: { spf: 'fail', dkim: 'fail', dmarc: 'fail' },
  })

  // Taken by Riley's thread: a back and forth, the latest quoting the one before.
  const conversation = randomUUID()
  await mail({
    conversation,
    from: ['Priya Shah', 'priya@umbrella.test'],
    subject: 'Export to CSV is missing columns',
    text: 'Hello,\n\nWhen I export the orders to CSV, the "discount" and "tax" columns are empty. Is this a known issue?\n\nPriya',
    at: hours(26),
    route: 'rule',
    sessionId: thread?.id,
  })
  await mail({
    conversation,
    direction: 'out',
    from: ['Riley', own],
    subject: 'Re: Export to CSV is missing columns',
    text: 'Hi Priya,\n\nThanks for the report. I reproduced it: the export skips columns added after the order was created. A fix is on its way; I will write again once it is live.\n\nRiley',
    at: hours(25),
    sessionId: thread?.id,
  })
  await mail({
    conversation,
    from: ['Priya Shah', 'priya@umbrella.test'],
    subject: 'Re: Export to CSV is missing columns',
    text:
      'Great, thank you! Could you also add the currency column while you are at it?\n\nOn Sat, 24 Oct 2026 at 10:12, Riley <' +
      own +
      '> wrote:\n> Hi Priya,\n>\n> Thanks for the report. I reproduced it: the export skips columns added after the order was created.\n> A fix is on its way; I will write again once it is live.\n>\n> Riley',
    at: hours(2),
    route: 'conversation',
    sessionId: thread?.id,
  })

  // Done: a person marked it so.
  await mail({
    conversation: randomUUID(),
    from: ['Stripe', 'notifications@stripe.test'],
    subject: 'Your payout of $1,240.00 is on its way',
    text: 'A payout of $1,240.00 to your bank account ending in 4242 is on its way. It should arrive within 2 business days.',
    at: days(2),
    sender: 'unknown',
    doneAt: days(1),
  })

  console.log(`created: sample Inbox mail for ${own}`)
}
