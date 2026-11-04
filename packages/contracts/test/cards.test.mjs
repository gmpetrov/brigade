import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buttonText, replyCard, safeChoices, safeReplies, withoutCard } from '../dist/cards.js'

const reply = 'Je merge #148 et je teste la connexion BigQuery ?'

test('takes the replies block off the end of a reply', () => {
  assert.deepEqual(replyCard(`${reply}\n\n\`\`\`replies\nMerge #148\n- "Pas encore"\n\`\`\`\n`), {
    text: reply,
    replies: { replies: ['Merge #148', 'Pas encore'] },
  })
})

test('keeps three replies, cut at a word to fit a button', () => {
  const long = 'Merge #148 et teste BigQuery puis la tuile Google Cloud'
  const { replies } = replyCard(`${reply}\n\`\`\`replies\n${long}\nA\nB\nC\n\`\`\``)
  assert.deepEqual(replies?.replies, ['Merge #148 et teste BigQuery puis la', 'A', 'B'])
})

test('reads choices as JSON, and keeps designs only from one options folder', () => {
  const options = (a, b) => [
    { id: 'a', label: 'A · Bold', ...(a ? { design: a } : {}) },
    { id: 'b', label: 'B · Calm', ...(b ? { design: b } : {}) },
  ]
  const block = (opts) =>
    `Two directions.\n\`\`\`choices\n${JSON.stringify({ question: 'Which?', options: opts })}\n\`\`\``
  const same = options('acme/pricing.options/a.design', 'acme/pricing.options/b.design')
  assert.deepEqual(replyCard(block(same)), {
    text: 'Two directions.',
    choices: { question: 'Which?', options: same },
  })
  // One design missing or elsewhere: the cards show without pictures.
  assert.deepEqual(
    replyCard(block(options('acme/pricing.options/a.design', undefined))).choices?.options,
    options(),
  )
})

test('drops a block that does not read, and leaves a reply without one as it is', () => {
  assert.deepEqual(replyCard(`${reply}\n\`\`\`choices\n{not json\n\`\`\``), { text: reply })
  assert.deepEqual(replyCard(`${reply}\n\`\`\`replies\n\n\`\`\``), { text: reply })
  assert.deepEqual(replyCard('```ts\nconst a = 1\n```'), { text: '```ts\nconst a = 1\n```' })
})

test('a card still being written does not show', () => {
  assert.equal(withoutCard(`${reply}\n\n\`\`\`repl`), reply)
  assert.equal(withoutCard(`${reply}\n\n\`\`\`replies\nMerge`), reply)
  assert.equal(withoutCard(`${reply}\n\n\`\`\`replies\nMerge\n\`\`\``), reply)
})

test('leaves out a button whose click could do more than send its words', () => {
  const { replies } = replyCard(
    `${reply}\n\`\`\`replies\n@carol ship it\n/design a page\n!rm -rf\nSend\u200dit\nPas encore\n\`\`\``,
  )
  assert.deepEqual(replies, { replies: ['Pas encore'] })
  // A zero-width space shows nothing: it is dropped, and the button sends what it shows.
  assert.deepEqual(replyCard(`${reply}\n\`\`\`replies\nSend\u200b it\n\`\`\``).replies, {
    replies: ['Send it'],
  })
  // Nothing left: no buttons at all.
  assert.deepEqual(replyCard(`${reply}\n\`\`\`replies\n@carol\n\`\`\``), { text: reply })
})

test('keeps what shows of a button: no control characters or variation selectors', () => {
  const { replies } = replyCard(`${reply}\n\`\`\`replies\nShip  it ✔️\u0007\n\`\`\``)
  assert.deepEqual(replies?.replies, ['Ship it ✔'])
})

test('a [merge] line is the merge action, shown before the replies', () => {
  const { replies } = replyCard(
    `${reply}\n\`\`\`replies\n[merge] Merge #158\nJe teste d'abord\nPas encore\nAutre\n\`\`\``,
  )
  assert.deepEqual(replies, {
    replies: ["Je teste d'abord", 'Pas encore'],
    actions: [{ action: 'merge', label: 'Merge #158' }],
  })
})

test('a [preview] line is the preview action', () => {
  const { replies } = replyCard(
    `${reply}\n\`\`\`replies\n[preview] Lancer la preview\nPas encore\n\`\`\``,
  )
  assert.deepEqual(replies, {
    replies: ['Pas encore'],
    actions: [{ action: 'preview', label: 'Lancer la preview' }],
  })
})

test('an action this version does not know is left out, not its replies', () => {
  assert.deepEqual(
    safeReplies({ replies: ['Pas encore'], actions: [{ action: 'deploy', label: 'Deploy' }] }),
    { replies: ['Pas encore'] },
  )
})

test('a choice whose label could mention or command is left out', () => {
  const choices = {
    question: 'Which?',
    options: [
      { id: 'a', label: 'A · Bold' },
      { id: 'b', label: '@carol builds it' },
      { id: 'c', label: 'C · Calm' },
    ],
  }
  assert.deepEqual(
    replyCard(`${reply}\n\`\`\`choices\n${JSON.stringify(choices)}\n\`\`\``).choices?.options.map(
      (o) => o.id,
    ),
    ['a', 'c'],
  )
  assert.equal(safeChoices({ ...choices, options: choices.options.slice(0, 2) }), null)
})

test('a tool call written out as text at the end is cut, unless it sits in a code block', () => {
  assert.deepEqual(
    replyCard(`${reply}\n<invoke name="suggest_replies">\n<parameter name="replies">[]`),
    {
      text: reply,
    },
  )
  const code = '```xml\n<invoke name="x">\n```'
  assert.equal(replyCard(code).text, code)
  assert.equal(replyCard('Writes `<invoke>` inline.').text, 'Writes `<invoke>` inline.')
})

test('older suggest_replies calls are read the same way', () => {
  assert.deepEqual(safeReplies({ replies: ['Send it', '@bob send it'] }), { replies: ['Send it'] })
  assert.equal(safeReplies({ replies: ['/visual'] }), null)
  assert.ok(buttonText('Send it'))
})

test('a done block comes out of the reply as its line, beside its buttons', async () => {
  const { doneLine } = await import('../dist/thread-done.js')
  assert.deepEqual(replyCard(`${reply}\n\n\`\`\`done\nCSV export merged (#412)\n\`\`\`\n`), {
    text: reply,
    done: 'CSV export merged (#412)',
  })
  // After the buttons, or before them: both read, and the person sees neither block.
  const both = `${reply}\n\`\`\`replies\nMerge #148\n\`\`\`\n\`\`\`done\nAnswered\n\`\`\``
  assert.deepEqual(replyCard(both), {
    text: reply,
    replies: { replies: ['Merge #148'] },
    done: 'Answered',
  })
  const before = `${reply}\n\`\`\`done\nAnswered\n\`\`\`\n\`\`\`replies\nMerge #148\n\`\`\``
  assert.deepEqual(replyCard(before), replyCard(both))
  // Its line on several lines runs together; an empty block still declares done (doneLine).
  assert.equal(replyCard('Ok.\n```done\n  Shipped\n  and live \n```').done, 'Shipped and live')
  assert.equal(replyCard('Ok.\n```done\n```').done, '')
  // No block, nothing declared.
  assert.equal(replyCard(reply).done, undefined)
  // The line: its own, else the reply's first, cut at a word to fit.
  assert.equal(doneLine('Shipped', 'Long reply'), 'Shipped')
  assert.equal(doneLine('', '## Le paywall est en place\n\nDétails…'), 'Le paywall est en place')
  assert.equal(doneLine('', ''), 'Delivered')
  const long = doneLine(`${'mot '.repeat(100)}fin`, '')
  assert.ok(long.length <= 300 && !long.endsWith(' ') && long.startsWith('mot mot'))
})

test('a done block still being written does not show', () => {
  assert.equal(withoutCard(`${reply}\n\n\`\`\`do`), reply)
  assert.equal(withoutCard(`${reply}\n\n\`\`\`done\nShipp`), reply)
  assert.equal(withoutCard(`${reply}\n\n\`\`\`done\nShipped\n\`\`\``), reply)
})

// A teammate showing the syntax (as in a pull request's description) does not close its thread.
const QUOTED = [
  'Proposed syntax (nothing implemented yet):',
  '````markdown',
  '```done',
  'CSV export merged (#412) and live',
  '```',
  '````',
  'I still need to implement and test this.',
].join('\n')

test('a block inside another code block is its text: quoted, it declares nothing', () => {
  assert.deepEqual(replyCard(QUOTED), { text: QUOTED })
  // Nor are quoted buttons buttons, and a fence of tildes quotes as well.
  const buttons = `Buttons look like this:\n~~~\n\`\`\`replies\nSend it\n\`\`\`\n~~~`
  assert.deepEqual(replyCard(buttons), { text: buttons })
  // Still being written, the example shows as it comes.
  const writing = QUOTED.slice(0, QUOTED.indexOf('CSV') + 3)
  assert.equal(withoutCard(writing), writing)
})

test('a done block declares done at the end of the reply only', () => {
  // In the middle of an explanation, an example: it stays, and nothing is declared.
  const middle = 'The block is\n```done\nShipped\n```\nand it goes at the end.'
  assert.deepEqual(replyCard(middle), { text: middle })
  // At the end, after the buttons or before them: declared.
  assert.equal(replyCard(`Shipped.\n\`\`\`done\nShipped\n\`\`\`\n\n`).done, 'Shipped')
  // Two: the last one at the end counts, the other stays as written.
  const two = 'Like this:\n```done\nExample\n```\nDone now.\n```done\nShipped\n```'
  assert.deepEqual(replyCard(two), {
    text: 'Like this:\n```done\nExample\n```\nDone now.',
    done: 'Shipped',
  })
})

test('a block under a list item is the item’s: an example, read as text', () => {
  // Markdown reads the block as part of the item, not of the reply's end.
  const listed = [
    'Nothing has been implemented yet. Proposed success footer:',
    '',
    '- Example:',
    '',
    '  ```done',
    '  CSV export merged (#412) and live',
    '  ```',
  ].join('\n')
  assert.deepEqual(replyCard(listed), { text: listed })
  assert.equal(withoutCard(listed), listed)
  const buttons = '1. The buttons:\n   ```replies\n   Send it\n   ```'
  assert.deepEqual(replyCard(buttons), { text: buttons })
  // Still being written there, it shows as it comes.
  const writing = '- Example:\n  ```done\n  CSV exp'
  assert.equal(withoutCard(writing), writing)
  // At the start of its line, after the list, the block is the reply's own.
  assert.equal(replyCard('- Shipped the export.\n\n```done\nShipped\n```').done, 'Shipped')
})

// Where a done block is read, case by case, as the Markdown parser the dashboard renders replies
// with reads the reply (mdast-util-from-markdown 2.1): read where it is one of the reply's last
// root blocks, never where it is inside another (a list item, a quote, raw HTML, another code
// block). Each case was checked against that parser's tree on Nov 4, by hand-written readers
// before it, each of which a case below caught.
test('a done block is read where Markdown reads it as the reply’s own, and nowhere else', () => {
  const D = '```done\nShipped\n```'
  const R = '```replies\nSend it\n```'
  const cases = {
    plainEnd: `Done.\n\n${D}`,
    afterButtons: `Done.\n${R}\n${D}`,
    beforeButtons: `Done.\n${D}\n${R}`,
    middle: `See:\n${D}\nthen more.`,
    fourTicks: `Ex:\n\`\`\`\`md\n${D}\n\`\`\`\``,
    tildes: `Ex:\n~~~\n${D}\n~~~`,
    listIndented: `- Example:\n\n${D.replace(/^/gm, '  ')}`,
    listNoBlank: `- Example:\n${D.replace(/^/gm, '  ')}`,
    orderedList: `1. Example:\n${D.replace(/^/gm, '   ')}`,
    nestedList: `- a\n  - b\n\n${D.replace(/^/gm, '    ')}`,
    listThenRoot: `- shipped\n\n${D}`,
    listThenRootNoBlank: `- shipped\n${D}`,
    blockquote: `> Example:\n> ${D.replace(/\n/g, '\n> ')}`,
    blockquoteLazy: `> Example:\n${D}`,
    htmlDetails: `<details>\n\n${D}\n\n</details>`,
    htmlDetailsEnd: `<details>\n${D}`,
    indented1: `Done.\n\n ${D.replace(/\n/g, '\n ')}`,
    indented3: `Done.\n\n   ${D.replace(/\n/g, '\n   ')}`,
    indented4: `Done.\n\n    ${D.replace(/\n/g, '\n    ')}`,
    innerClosesOuter: `Ex:\n\`\`\`md\n${D}\n\`\`\``,
    unclosedOuter: `Ex:\n\`\`\`\`md\n${D}`,
    doneInTable: `| a |\n|---|\n| ${'```done'} |`,
    crlf: `Done.\r\n\r\n\`\`\`done\r\nShipped\r\n\`\`\``,
    trailingSpaces: `Done.\n\n${D}   \n\n  `,
    footnote: `Done.[^1]\n\n[^1]: note\n\n${D}`,
    fenceInListThenRoot: `- item\n  \`\`\`js\n  x\n  \`\`\`\n\n${D}`,
    htmlComment: `<!-- note\n${D}\n-->`,
    htmlCommentOneLine: `<!-- note -->\n${D}`,
    htmlCommentThenRoot: `<!-- a\nb -->\n\n${D}`,
    htmlPreBlank: `<pre>\n\n${D}\n</pre>`,
    htmlPreEnd: `<pre>\nx\n</pre>\n${D}`,
    htmlScript: `<script>\n${D}`,
    htmlType7: `<custom-tag>\n${D}`,
    htmlType7AfterPara: `Some text\n<custom-tag>\n${D}`,
    inlineHtmlPara: `<b>bold</b> text\n${D}`,
    htmlDivBlankRoot: `<div>\nx\n</div>\n\n${D}`,
    autolink: `<https://brigade.lol>\n${D}`,
    heading: `# Done\n${D}`,
    doctype: `<!DOCTYPE html>\n${D}`,
    // A list's code block that its list ends, then a bare fence: the done is that block's text.
    listCodeEndedByList: '- Example:\n  ```js\n  x\n```\n```done\nShipped\n```',
    // A code block opened on the bullet's line, then a bare fence: the same.
    bulletLineCode: '- ```js\n  x\n  ```\n\n```\n```done\nShipped\n```',
    // A non-breaking space is no blank line: raw HTML goes on, and the fence is in it.
    nbspInHtml: '<details>\n\u00a0\n```done\nShipped\n```',
    // Nor does it end a closing fence's line: the block goes on, the done inside it.
    nbspAfterFence: '```text\nexample\n```\u00a0\n```done\nShipped\n```',
  }
  const read = new Set([
    'afterButtons',
    'autolink',
    'beforeButtons',
    'blockquoteLazy',
    'crlf',
    'doctype',
    'fenceInListThenRoot',
    'footnote',
    'heading',
    'htmlCommentOneLine',
    'htmlCommentThenRoot',
    'htmlDivBlankRoot',
    'htmlPreEnd',
    'htmlType7AfterPara',
    'indented1',
    'indented3',
    'inlineHtmlPara',
    'listThenRoot',
    'listThenRootNoBlank',
    'plainEnd',
    'trailingSpaces',
  ])
  for (const [name, text] of Object.entries(cases))
    assert.equal(replyCard(text).done !== undefined, read.has(name), name)
})
