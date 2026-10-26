# Email

Brigade's own addresses for agents and projects, on its mail domain (`MAIL_DOMAIN`,
`mails.brigade.lol` in production) and on the workspace's own domains, received and sent through
Resend: the **Email App** (`apps/api/src/mail/`, `connectors/email.ts`, `routes/email.ts`). The decision record is
`Projects/Brigade/decisions/agent-email-spec.md` in the library.

## Addresses

- **An agent's address** (`MailAddress` kind `agent`): `riley@`. Off by default; an owner or admin
  turns the App on for the workspace (`POST /api/email/enable`), then each agent's address from its
  page (`POST /api/email/agents/:teammateId`).
  - `riley@` is used by Riley's threads without a project;
  - `riley.<project>@` by its threads in that project (`MailProject`: a project's slug, set the first
    time it is needed, kept when the project is renamed or deleted, never another project's);
  - `riley.<project>.<token>@` is a sign-up address a thread made (`MailAlias`, `email_new_address`).
    The token starts with a digit, so it never reads as a project.
- **A project's shared mailbox** (kind `inbox`): a generated name (`support-lovarank-7f3k@`).
- **An address on the workspace's own domain** (`publicAddress`, `riley@acme.com`,
  `support@acme.com`): any mailbox, an agent's or a project's, may have one, set when it is made or
  later (`PATCH /api/email/addresses/:id`, null for Brigade's domain only). It is the address shown,
  received and sent as; the name on Brigade's domain stays underneath (`internalAddress`), for the
  forwarding. Its domain is added first (see Domains). Projects' variants and sign-up addresses stay
  on Brigade's domain.
- **Names are unique across Brigade and never given again.** `MailAddress.name` is unique, and its
  row has no link that a workspace's, teammate's or project's deletion would remove: turned off, it
  keeps its name (`releasedAt`), and turned on again, the same agent gets it back. A taken name is
  offered as `name-2`, `name-3`… Names are 2 to 30 lowercase letters, digits and hyphens, never a
  reserved word (the domain's roles such as `postmaster`, shared desks such as `support` or `sales`,
  Brigade's own such as `brigade` or `chief`, and its people's names: `RESERVED` in `mail/names.ts`).
- **Each address is an account of the Email App** (a `Connection` of kind `email`, auth `brigade`:
  no credential, Brigade's Resend key). An agent's address is granted to that agent alone and cannot
  be granted to another; an inbox is used only in its project's threads, by the teammates given it
  (a rule's teammate gets it when the rule is made).

## Domains

`/app/inbox/domains` (`apps/web/components/mail-domains.tsx`, `mail/domains.ts`,
`GET|POST /api/email/domains`, `DELETE /api/email/domains/:id`): an owner or admin adds a domain
once, then its mailboxes' addresses. One workspace per domain across Brigade (`MailDomain.name` is
unique). Adding it reads its MX first (`GET /api/email/domains/lookup`, Cloudflare's DNS over HTTPS)
and asks how its mail reaches Brigade (`MailDomain.receiving`):

- **`forward`** (suggested when its MX points elsewhere, Google's say): its mail stays with its
  provider, and each address is forwarded there to its mailbox's address on Brigade's domain. The
  mailbox's page says what to forward where and shows Google's confirmation code. The domain is
  added to Resend for sending only.
- **`direct`** (suggested when it has no MX, or Resend's): its MX points to Resend's receiving, which
  it is added to Resend for too, and mail to its addresses arrives as is. Refused while its MX points
  to another provider: that would take its mail away from there. A subdomain (`team.acme.com`) is
  the way to have both.

Its DNS records (`MailDomain.records`, Resend's) are checked every ten minutes for three days, or at
once with Check now. **A mailbox on a domain whose records are not in yet sends nothing**: the send
is refused (409) and never goes out from its address on Brigade's domain instead, so replies always
come from the address people wrote to. A domain is removed once no mailbox has an address on it.

## Receiving

Resend's webhook (`POST /events/resend`, Svix-signed with `RESEND_WEBHOOK_SECRET`) applies to the
whole Resend account, which other products share: only recipients on `MAIL_DOMAIN`, and addresses
of mailboxes on a workspace's domain that receives directly (`directBoxOf`), are kept, and nothing of
the others' mail is stored. A forwarded mail is kept for the Brigade address it was forwarded to, and
an address on a direct domain arrives in its mailbox's box with no project, as Brigade's own does. Each box among the recipients gets one `MailMessage`, kept
at once (`status: pending`); its text, headers and SPF/DKIM/DMARC results are then read from Resend
(`GET /emails/receiving/:id`) and it is delivered, in the background. A minute tick tries again what
did not finish, waiting longer each time, and marks a mail failed after 8 tries. Calls to Resend go
through one queue at 4 a second (the account allows 10 for everyone).

Each mail goes to **one** place, in this order (`mail/inbound.ts`), kept in `route`, which is the
address's journal (`GET /api/email/addresses/:id/journal`):

1. **A thread waiting on it**: mail to a sign-up address while it waits (`awaited`, even machine
   mail), or a reply in a conversation the thread sent mail in (`ReplyWatch`, as for Gmail). It is a
   `Wakeup` of kind `reply`, fired at once, or handed to `email_wait` when the thread is waiting in
   that call. A delivery failure of the thread's mail comes back the same way (`bounce`).
2. **Its conversation's thread** (`conversation`): a thread a member's mail or a rule started for it.
3. **A member's request** (`member`): mail from a member of the workspace whose DKIM or DMARC passed,
   to an agent's address, starts (or continues) a thread for that member with that agent, in the
   variant's project, as if they had typed it.
4. **The address's rules** (`rule`): triggers `email.email_received` in their order
   (`Trigger.position`, `PUT /api/email/rules/order`). The first that matches takes it; an agent's
   rule watches its project's variant only.
5. **Its box** (`box`): read on demand with `email_list`; deleted after 30 days (`sweepMail`), but a
   sign-up's mail whose conversation has mail that stays: it marks the conversation as its thread's.

Before these: a copy of a reply a person sent from the mailbox itself (`own_copy`, its From is the
inbox's public address), the same `Message-ID` already delivered from another address of the
workspace (`duplicate`), a conversation that sent mail to threads 8 times within the hour (`loop`),
and Brigade's test mail (`test`, `X-Brigade-Test`). A rule past its threads for the day (`perDay`,
50 by default) leaves the mail in the box and opens one ticket (`cap`).

Who wrote it (`MailSender`): `member` (verified), `contact` (someone the workspace exchanged mail
with: they were written to, or their mail went to a thread; `Contact`, `ContactHandle`), `brigade`
(one of its own addresses), or `unknown`. The thread is told, with the contact's earlier threads.
A reply in a conversation the thread has gives it the new words only; `email_read` has the quote.

## Sending

`email_send` (a connector write) sends from the thread's box: the agent's variant, shown as
"Riley · Lovarank", or the shared mailbox. A mailbox with an address on the workspace's domain
sends as that address only, in every project, once its domain is verified, and refuses until then
(`senderOfBox`). Before anyone is asked
(`Operation.check`) and again after a person changed the draft (`mail/outbound.ts`):

- a reply goes to its conversation's people only, unless `newRecipients` says so;
- the files are this thread's own; no secret in the text (`secretIn`);
- at most 100 mails a day from an address, 50 recipients, 10 files, 25 MB;
- no reply after someone already answered from the mailbox itself (`own_copy`).

A mail to anyone outside the workspace waits for a person (`Operation.asks`), unless the teammate's
`permissionPolicy.emailSends` is `allow` or a playbook's action lets it go; the approval card lets
the person edit the draft first (`ResolveApproval.edited`, `Operation.editable`), or approve it for
later ("Send later", which sets `sendAt`). It is handed to Resend scheduled 30 seconds ahead, or at
`sendAt` when later (the teammate's own, "send it Monday at 9", or the approver's; up to 30 days,
`SEND_LATER_MAX_DAYS`, as Resend holds mail): until then it can be cancelled from the thread's panel
or the Inbox (`POST /api/email/messages/:id/cancel`) or with `email_cancel`. Its replies are followed
from when it leaves. Gmail cannot send later: its API has no scheduled send. Resend's events (`email.sent`,
`delivered`, `bounced`, `failed`) give its `Message-ID` and its fate; a bounce wakes the thread.

## Gmail follows the same rules

Gmail's `email_received` is exclusive too: a mailbox's rules are tried in their order and the first
that matches takes the mail. On every trigger: a conversation a person took over stays theirs (the
event waits in the thread as a wake-up until they hand it back, `triggers.ts`), a conversation with
8 events within the hour is a loop, and a mailbox rule's threads stay out of the sidebar
(`Session.quiet`) until a person takes part or a ticket opens. A Gmail delivery failure in a watched
conversation wakes the thread.

## Agents' tools

`email_list`, `email_read`, `email_read_attachment`, `email_new_address`, `email_wait` (up to two
minutes in one call), `email_send`, `email_cancel`. Everything read is untrusted input.

## The Inbox

`/app/inbox`, under Home in the sidebar (`apps/api/src/inbox.ts`, `routes/inbox.ts`): every mail
the workspace's mailboxes received, across agents, projects and sources, in one list, one row per
conversation (a box's `conversationId`, a Gmail thread). Every source keeps its mail in the same
table, `MailMessage`, so one query lists, filters and pages them all; a new source (a chat) only
has to keep its messages there.

- **Sources**: Brigade's addresses, as they receive mail; and Gmail accounts, as their inbox reader
  reads them (`src/mail/gmail-inbox.ts`: `connectionId`, `sourceId`, box `gmail:<connection id>`).
  A shared account its owner or an admin put in the Inbox (`Connection.inbox`, "Show all its mail
  in the Inbox" in the account's menu) shows all its mail, without promotions and social, and is
  read even without triggers. Any other account, a member's own included, shows only the mail that
  went to a thread (`TAKEN_ROUTES`: a rule's or a playbook's, one waiting on a reply in its
  conversation, one a person handed it to); the rest, personal mail, is never kept. A member's own
  account shows to them alone; a shared one to everyone.
- **A conversation** shows as its latest received mail (its head), with its number of mails. Its
  status is the head's, in the query (SQL, `DISTINCT ON` box and conversation, so paging is right
  whatever the view): `waiting` (nobody took it: `box`, `cap`, `loop`, or not delivered yet, and not
  done), `handled` (a thread has it, or its route needs nobody), `done` (`MailMessage.doneAt`, set on
  all its received mails; its next mail waits again).
- **Its next step** (`InboxItem.next`), on its row: a teammate's reply waiting for approval (an open
  `email_send` ticket of its thread answering one of its mails), else the next reply set to leave
  later (sent, `scheduled`, past the 30 seconds to cancel any mail).
- **Tabs**: To do (`waiting`: nobody took it, or a reply waits for this member's approval: they
  started its thread, or are an admin, as `decide.ts` says), With teammates (`handled`, but those),
  Scheduled (a reply set for later), Done, All. The sidebar counts the To do, last 30 days.
- **Filters**: source, agent, project, words; a conversation shows when any of its mails matches
  (words: its senders, or the words of its mails received or sent).
  Pages of 50, newest first.
- **Opened** (by any of its mails' ids): each mail, received and sent from Brigade's address
  (Gmail's sent mail is not kept), oldest first, with its words (the quote apart), files,
  authentication. A sign-up's conversation, with the replies sent in it (they can quote its code),
  is shown and searched only for its thread's starter and admins; others see that it came.
- **Files** open from the page (`/api/inbox/items/:id/files/:fileId`), never through the API's
  memory: Brigade's address's redirect to Resend's short-lived link; Gmail's, which has none, are
  copied once to the bucket as they stream (Gmail's base64 decoded on the way, `src/json-base64.ts`)
  and redirect to the bucket's link. Programs and installers do not open. Sent files open as Brigade
  keeps them.
- **Taking a received file in** (a rule's thread, `email_read_attachment`, `gmail_read_attachment`,
  the Inbox): its bytes go from the source to the bucket as they arrive (`storeStream`, a signed PUT
  of its exact length), its hash read on the way; only a file of 1 MB or less is also kept whole a
  moment, for its text. A taker of a file whose copy is under way waits for it (a retryable 409
  after 20 seconds); a copy stopped halfway is made again. A copy no thread has goes after 30 days
  (`sweepUploads`), its bytes before its row, so a failed delete is tried again.
- **A reply to approve** shows at the end of its conversation, as the thread's approval card does:
  approve and send, send later, edit, or discard (`POST /api/tickets/:id/resolve`). Who may not
  decide sees it, and who may.
- **Nobody on it** (a callout above the conversation): the item says why nobody took it (from outside the workspace with no rule matching, a rule over its cap, a loop,
  not delivered yet) and, for Brigade's mail, lets an owner or admin add a rule on its mailbox
  (its project's variant, its agent first picked) for the mail that comes next.
- **Hand to**: a thread of the member with a teammate given the mailbox, in the item's project,
  with their note, the latest mail and the conversation's earlier ones. The mail then belongs to that thread (`route: handed`): Brigade's
  next mail in its conversation goes there; a Gmail conversation's reply wakes it (`ReplyWatch`).
  The thread shows the note as the person's message and the mail as a card (`handedEmail`, trigger
  `Inbox`), whose header, sender and subject open the conversation here (`inboxItem` in the event).
  Like a mailbox rule's, the thread stays out of the sidebar and Home (`Session.quiet`) until a person
  writes in it, pins it or a ticket opens; the Inbox links to it.

## Mailboxes

`/app/inbox/mailboxes` (`apps/web/components/mailboxes.tsx`, `apps/api/src/mailboxes.ts`,
`GET /api/inbox/mailboxes[/:id]`): the one place mail is set up. A mailbox is whatever receives mail
for the workspace, whatever it is underneath: an agent's address, a project's shared mailbox (an
inbox address, usually with the address customers write to forwarded to it), a Gmail account. Its
id is the Inbox's source id (`email:<address id>`, `gmail:<connection id>`).

- **The list**, under Mail settings › Mailboxes (Domains is the other tab), in three groups:
  agents', shared, connected Gmail. Each with its address, how many rules handle it (or that its
  domain waits for its records), and "Only you" for a member's own Gmail (another member's never
  shows).
- **Add a mailbox** is one form: an address, its name `@` a domain (Brigade's or one of the
  workspace's), for an agent or for a project (shared). On Brigade's domain an agent keeps the name
  it had before, and a shared mailbox gets a generated one. A Gmail account is connected in
  Settings › Apps. It turns the Email App on first when needed.
- **A mailbox's page** answers three questions: where its mail arrives (its address, changed to
  another domain there; whether it receives, directly or once forwarded, with what to forward where
  and Google's confirmation code; whether it sends, and as what; a test mail; Turn off; a Gmail
  account's "Show all its mail in the Inbox"), who handles it
  (its rules and its playbooks' rules in one list, in the order they apply, reordered there, a
  playbook's changed in the playbook; then what happens to the rest), and who reads and replies (the
  teammates given it, and who sees its mail in the Inbox). A Brigade mailbox's page also has its
  journal (its latest mail both ways and where each went, never its text). Rules are an owner's or admin's to change; a Gmail account's own member
  chooses whether all its mail shows.
- The other places only link here: a project's settings list its mailboxes, a teammate's Access card
  shows its address (or Give an address), the Email App's sheet turns it on, a Gmail account's menu
  opens its mailbox. Projects' variants of an agent's address and sign-up addresses stay out of
  sight.
