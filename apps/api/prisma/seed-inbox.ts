// Sample mail for the Inbox: Riley's own address, with conversations in each state (unassigned,
// not verified, taken by a thread with replies and quoted text and a reply waiting for approval,
// one with a reply set to leave on Monday, done, and two with HTML: a forward and a receipt). Made up, as the rest of the sample: nothing is
// sent or received. Each part is added once, so a preview made before it gets it on its next
// start too.
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
  const [mails, scheduled, withHtml] = await Promise.all([
    prisma.mailMessage.count({ where: { workspaceId: workspace.id } }),
    prisma.mailMessage.count({
      where: { workspaceId: workspace.id, direction: 'out', status: 'scheduled' },
    }),
    prisma.mailHtml.count({ where: { workspaceId: workspace.id } }),
  ])
  if (mails && scheduled && withHtml) return

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
  const added = mails > 0
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
    to?: string
    /** Sent mail set to leave later. */
    sendAt?: Date
    /** Received mail's HTML, for the Inbox's HTML view. */
    html?: string
  }
  const mail = (m: Mail) => {
    const out = m.direction === 'out'
    return prisma.mailMessage.create({
      data: {
        ...inWorkspace,
        addressId: address.id,
        box,
        direction: out ? 'out' : 'in',
        status: out ? (m.sendAt ? 'scheduled' : 'delivered') : 'done',
        messageId: `<${randomUUID()}@sample.test>`,
        conversationId: m.conversation,
        fromName: m.from[0],
        fromAddress: m.from[1],
        to: [out ? m.to! : own],
        subject: m.subject,
        text: m.text,
        authentication: out ? undefined : (m.authentication ?? PASS),
        sender: out ? null : (m.sender ?? 'unknown'),
        route: out ? null : (m.route ?? 'box'),
        sessionId: m.sessionId ?? null,
        teammateId: out ? riley.id : null,
        doneAt: m.doneAt ?? null,
        doneByMemberId: m.doneAt ? ada.id : null,
        sendAt: m.sendAt ?? null,
        receivedAt: m.at,
        createdAt: m.at,
        ...(m.html ? { htmlBody: { create: { ...inWorkspace, html: m.html } } } : {}),
      },
    })
  }
  const conversation = randomUUID()
  if (!added) await firstMail()
  if (!scheduled) await nextSteps()
  if (!withHtml) await withHtmlMail()
  console.log(`created: sample Inbox mail for ${own}`)

  async function firstMail() {
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
      to: 'priya@umbrella.test',
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
  }

  /** Riley's reply to Priya, waiting for approval, and a reply set to leave on Monday. */
  async function nextSteps() {
    const priya = await prisma.mailMessage.findFirst({
      where: { box, fromAddress: 'priya@umbrella.test', direction: 'in' },
      orderBy: { receivedAt: 'desc' },
    })
    if (thread && priya)
      await prisma.ticket.create({
        data: {
          ...inWorkspace,
          sessionId: thread.id,
          type: 'approval',
          title: `Riley: email send (email to priya@umbrella.test: "(reply)")`,
          payload: {
            connectionId: address.connectionId,
            connection: own,
            operation: 'email_send',
            target: 'email to priya@umbrella.test: "(reply)"',
            reason: 'An email to someone outside the workspace waits for a person to approve it.',
            input: {
              to: ['priya@umbrella.test'],
              subject: '',
              text: 'Hi Priya,\n\nYes: the currency column ships with the fix on Monday, next to discount and tax. I will write as soon as it is live.\n\nRiley',
              replyTo: priya.id,
            },
          },
          createdAt: minutes(40),
        },
      })

    // Taken by Riley's thread, its reply set to leave Monday morning.
    const crews = randomUUID()
    await mail({
      conversation: crews,
      from: ['Maple & Stone Landscaping', 'hello@maplestone.test'],
      subject: 'Overflow crews for November',
      text: 'Hi,\n\nWe can hold Oct 28 through Nov 15 for you until Friday. Do you want us to confirm the two crews?\n\nMaple & Stone',
      at: days(1),
      route: 'conversation',
      sessionId: thread?.id,
      sender: 'contact',
    })
    const monday = new Date()
    monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7))
    monday.setHours(9, 0, 0, 0)
    await mail({
      conversation: crews,
      direction: 'out',
      from: ['Riley', own],
      to: 'hello@maplestone.test',
      subject: 'Re: Overflow crews for November',
      text: 'Hi,\n\nYes, please confirm both crews for Oct 28 to Nov 15. We will send the site plans by Thursday.\n\nRiley',
      at: hours(20),
      sessionId: thread?.id,
      sendAt: monday,
    })
  }

  /** Mail with HTML: a person's forward, cut at 76 characters as Gmail does, and a receipt. */
  async function withHtmlMail() {
    await mail({
      conversation: randomUUID(),
      from: ['Ada Lovelace', 'ada@example.com'],
      subject: 'Fwd: Video touch-up',
      text: [
        'Can you take this one?',
        '',
        '',
        '',
        '*Ada Lovelace*',
        '',
        '---------- Forwarded message ---------',
        'From: Studio Deblieux <studio@deblieux.test>',
        'Date: Mon, Nov 2, 2026 at 17:58',
        'Subject: Video touch-up',
        'To: ada@example.com <ada@example.com>',
        '',
        '',
        'Hello Ada,',
        '',
        'Could you help us remove the toothpick stuck in the top fig? The goal is that',
        'nobody can see the toothpick any more, without touching the quality of the',
        'video, its colors, or how the figs look.',
        '',
        'Here is the video: https://files.example.com/t/fig-video',
        '',
        'Thanks a lot,',
        'Studio Deblieux',
      ].join('\n'),
      html:
        '<div dir="ltr">Can you take this one?<br><br><div><b>Ada Lovelace</b></div><br>' +
        '<div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>' +
        'From: <strong class="gmail_sendername" dir="auto">Studio Deblieux</strong> <span dir="auto">&lt;<a href="mailto:studio@deblieux.test">studio@deblieux.test</a>&gt;</span><br>' +
        'Date: Mon, Nov 2, 2026 at 17:58<br>Subject: Video touch-up<br>To: &lt;<a href="mailto:ada@example.com">ada@example.com</a>&gt;<br></div><br><br>' +
        '<div dir="ltr"><div style="color:rgb(34,34,34)">Hello Ada,</div><br><div>Could you help us remove the toothpick stuck in the top fig? ' +
        'The goal is that nobody can see the toothpick any more, without touching the quality of the video, its colors, or how the figs look.</div><br>' +
        '<div>Here is the video: <a href="https://files.example.com/t/fig-video">https://files.example.com/t/fig-video</a></div><br>' +
        '<div>Thanks a lot,<br>Studio Deblieux</div></div></div></div>',
      at: minutes(30),
      sender: 'contact',
    })
    await mail({
      conversation: randomUUID(),
      from: ['Globex Cloud', 'receipts@globex.test'],
      subject: 'Your receipt from Globex Cloud',
      text: 'Globex Cloud\n\nReceipt #1042\n\nTeams plan, November: $96.00\nTax: $19.20\nTotal: $115.20\n\nView it online: https://globex.test/receipts/1042',
      html:
        '<body bgcolor="#f4f4f7" style="margin:0;padding:24px 0;font-family:Helvetica,Arial,sans-serif">' +
        '<table width="560" align="center" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px">' +
        '<tr><td style="padding:24px 32px;background:#4f46e5;color:#ffffff;border-radius:8px 8px 0 0">' +
        '<img src="https://globex.test/logo.png" alt="Globex Cloud" height="24" style="vertical-align:middle"> ' +
        '<strong style="font-size:18px">Globex Cloud</strong></td></tr>' +
        '<tr><td style="padding:24px 32px;color:#111827"><h1 style="font-size:20px;margin:0 0 16px">Receipt #1042</h1>' +
        '<table width="100%" style="font-size:14px;color:#374151">' +
        '<tr><td>Teams plan, November</td><td align="right">$96.00</td></tr>' +
        '<tr><td>Tax</td><td align="right">$19.20</td></tr>' +
        '<tr><td style="padding-top:8px;border-top:1px solid #e5e7eb"><strong>Total</strong></td>' +
        '<td align="right" style="padding-top:8px;border-top:1px solid #e5e7eb"><strong>$115.20</strong></td></tr></table>' +
        '<p style="margin:24px 0 0"><a href="https://globex.test/receipts/1042" style="display:inline-block;padding:10px 16px;background:#4f46e5;color:#ffffff;border-radius:6px;text-decoration:none">View receipt</a></p>' +
        '<img src="https://track.globex.test/open.gif" width="1" height="1" alt=""></td></tr></table></body>',
      at: hours(5),
    })
  }
}
