// A received mail's text as the Inbox shows it (lib/mail-text): paragraphs, forwards, links.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { forwardSummary, readMailText, shownLink, tokens, unwrap } from '../lib/mail-text'

// Gmail's plain text of a forward, as it came in (cut at its width, blank lines kept).
const FORWARD = `Test



*Georges Petrov*

---------- Forwarded message ---------
From: Agence Deblieux <agence.deblieux@gmail.com>
Date: Mon, Nov 2, 2026 at 17:58
Subject: Retouche Video
To: georgesm.petrov@gmail.com <georgesm.petrov@gmail.com>


Hello Amore,

Pourrais-tu m'aider s'il te plait pour supprimer le cure dent qui est
planté dans la figue du haut ? Le but étant que l'on ne voit plus le
curedent sans toucher à la qualité de la vidéo, ni sa colorimétrie, ni
l'apparence des figues.

Voici la vidéo dans le lien ci dessous :
https://we.tl/t-BFPpxLMNPSfkjsLQ

Un grand merci à toi,
`

test('a forward: its own words, then the forwarded header block apart, then its paragraphs', () => {
  const mail = readMailText(FORWARD)
  assert.equal(mail.text, 'Test\n\n*Georges Petrov*')
  assert.deepEqual(mail.forwarded?.headers, [
    ['From', 'Agence Deblieux <agence.deblieux@gmail.com>'],
    ['Date', 'Mon, Nov 2, 2026 at 17:58'],
    ['Subject', 'Retouche Video'],
    ['To', 'georgesm.petrov@gmail.com <georgesm.petrov@gmail.com>'],
  ])
  assert.equal(
    mail.forwarded?.body.text,
    [
      'Hello Amore,',
      '',
      "Pourrais-tu m'aider s'il te plait pour supprimer le cure dent qui est planté dans la figue du haut ? Le but étant que l'on ne voit plus le curedent sans toucher à la qualité de la vidéo, ni sa colorimétrie, ni l'apparence des figues.",
      '',
      'Voici la vidéo dans le lien ci dessous :',
      'https://we.tl/t-BFPpxLMNPSfkjsLQ',
      '',
      'Un grand merci à toi,',
    ].join('\n'),
  )
})

test('a header put on two lines joins back', () => {
  const mail = readMailText(
    'FYI\n\n-------- Original Message --------\nFrom: Ada\n<ada@example.com>\nSubject: Hi\n\nHello',
  )
  assert.deepEqual(mail.forwarded?.headers, [
    ['From', 'Ada <ada@example.com>'],
    ['Subject', 'Hi'],
  ])
  assert.equal(mail.forwarded?.body.text, 'Hello')
})

test('a mail with long lines was not cut: its short lines stay as they are', () => {
  const lines = [
    'This line is long enough to be past any width a mail program cuts its plain text at, so nothing was cut.',
    'Thanks for the quick answer, the invoice from last month is attached here',
    'Ada',
  ]
  assert.deepEqual(unwrap(lines), lines)
})

test('lists, quotes and short lines are never joined', () => {
  const lines = [
    'Here is what we need from your side before the launch at the end of the',
    'week:',
    '- the logo in high resolution, and the copy for the landing page hero',
    '- the pricing',
    '> a quoted line that goes on for quite a while, longer than sixty chars',
    '> and its next line',
  ]
  assert.deepEqual(unwrap(lines), [
    'Here is what we need from your side before the launch at the end of the week:',
    ...lines.slice(2),
  ])
})

test('links, addresses and *bold* are found; punctuation after a link stays out of it', () => {
  assert.deepEqual(tokens('See https://example.com/a?b=1. Or write ada@example.com, *now*!'), [
    { kind: 'text', text: 'See ' },
    { kind: 'link', text: 'https://example.com/a?b=1', href: 'https://example.com/a?b=1' },
    { kind: 'text', text: '. Or write ' },
    { kind: 'link', text: 'ada@example.com', href: 'mailto:ada@example.com' },
    { kind: 'text', text: ', ' },
    { kind: 'bold', text: 'now' },
    { kind: 'text', text: '!' },
  ])
  // An address in a link is the link's; a lone star is not bold.
  assert.deepEqual(tokens('https://x.test/u/ada@example.com 2 * 3'), [
    {
      kind: 'link',
      text: 'https://x.test/u/ada@example.com',
      href: 'https://x.test/u/ada@example.com',
    },
    { kind: 'text', text: ' 2 * 3' },
  ])
})

test("a forward's one-line summary: the sender's name, its subject and its date", () => {
  const summary = forwardSummary(readMailText(FORWARD).forwarded!)
  assert.equal(summary.from, 'Agence Deblieux')
  assert.equal(summary.subject, 'Retouche Video')
  assert.equal(summary.date?.getFullYear(), 2026)
  assert.equal(summary.date?.getMonth(), 10)
  assert.equal(summary.date?.getDate(), 2)
})

test("a forward's summary takes the address when there is no name, and no date it cannot read", () => {
  const mail = readMailText(
    'Look\n\n-------- Message transféré --------\nDe : <ada@example.com>\nDate : demain\nObjet : Bonjour\n\nSalut',
  )
  assert.deepEqual(forwardSummary(mail.forwarded!), {
    from: 'ada@example.com',
    subject: 'Bonjour',
    date: null,
  })
})

test('a long link shows as the site it leads to, a short one whole', () => {
  // A newsletter's tracked link (Amazon SES), its destination encoded in its path.
  assert.equal(
    shownLink(
      'https://ls833qgf.r.us-east-1.awstrack.me/L0/https:%2F%2Faiagentstore.ai%2FclickToSee%3Femail=riley%2540mails.brigade.lol%26target=https%253A%252F%252Faiagentstore.ai%252Fagent-teams/1/010001a1c946716a-05aeb78f/tH120hPZ=473',
    ),
    'aiagentstore.ai',
  )
  // Encoded twice, in a query.
  assert.equal(
    shownLink(
      'https://click.example.com/track?u=https%253A%252F%252Fwww.shop.example%252Fitem%252F42&id=abcdefghijklmnop',
    ),
    'shop.example',
  )
  // Long with no destination in it: its own site.
  assert.equal(
    shownLink('https://www.example.com/a/very/long/path/that/goes/on/and/on/for/a/while'),
    'example.com',
  )
  assert.equal(shownLink('https://example.com/pricing'), 'https://example.com/pricing')
})
