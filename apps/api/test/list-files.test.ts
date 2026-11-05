// A list line's files (docs/lists.md) survive the editor: Markdown to the live document and back,
// as the collab server does with every save. A file indented under a line stays under it, and is
// the line's for the list (parseList); one at the margin stays a block of its own.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ServerBlockNoteEditor } from '@blocknote/server-util'
import { parseList } from '@brigade/contracts'
import { blocksToMarkdown, documentSchema, markdownToBlocks } from '@brigade/editor'

process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
const { normalizeMarkdown } = await import('../src/collab.js')

type Block = {
  type: string
  props?: Record<string, unknown>
  content?: unknown
  children?: Block[]
}
const shape = (blocks: Block[]): unknown[] =>
  blocks.map((b) => [
    b.type,
    typeof b.props?.url === 'string' ? b.props.url : null,
    ...(b.children?.length ? [shape(b.children)] : []),
  ])

test('files put under a line in the editor are written under it, and read back there', async () => {
  const editor = ServerBlockNoteEditor.create({ schema: documentSchema })
  const text = (t: string) => [{ type: 'text', text: t, styles: {} }]
  const blocks = [
    {
      type: 'checkListItem',
      props: { checked: false },
      content: [
        ...text('Voice: Cartesia or Georges '),
        { type: 'item', props: { id: 'aaaaaaaaaaaaaaaa' } },
      ],
      children: [
        { type: 'image', props: { url: 'asset:cmshot', name: 'Screenshot 1.png' } },
        { type: 'file', props: { url: 'asset:cmbrief', name: 'brief.pdf', caption: 'Q3' } },
        {
          type: 'checkListItem',
          props: { checked: false },
          content: text('Ask Georges'),
          children: [{ type: 'video', props: { url: 'asset:cmclip', name: 'clip.mp4' } }],
        },
      ],
    },
    { type: 'checkListItem', props: { checked: false }, content: text('References') },
    { type: 'image', props: { url: 'asset:cmloose', name: 'loose.png' } },
  ]
  const markdown = await blocksToMarkdown(editor, blocks as never)
  assert.equal(
    markdown.trim(),
    [
      '* [ ] Voice: Cartesia or Georges <!-- item:aaaaaaaaaaaaaaaa -->',
      '',
      '  ![Screenshot 1.png](asset:cmshot)',
      '',
      '  [brief.pdf](asset:cmbrief "file: Q3")',
      '',
      '  * [ ] Ask Georges',
      '',
      '    [clip.mp4](asset:cmclip "video")',
      '',
      '* [ ] References',
      '',
      '![loose.png](asset:cmloose)',
    ].join('\n'),
  )
  const back = (await markdownToBlocks(editor, markdown)) as Block[]
  assert.deepEqual(shape(back), [
    [
      'checkListItem',
      null,
      [
        ['image', 'asset:cmshot'],
        ['file', 'asset:cmbrief'],
        ['checkListItem', null, [['video', 'asset:cmclip']]],
      ],
    ],
    ['checkListItem', null],
    ['image', 'asset:cmloose'],
  ])
  assert.equal(await blocksToMarkdown(editor, back as never), markdown, 'the same text again')
  assert.deepEqual(
    parseList(markdown).lines.map((l) => [l.text, l.id, l.files.map((f) => f.id)]),
    [
      ['Voice: Cartesia or Georges', 'aaaaaaaaaaaaaaaa', ['cmshot', 'cmbrief']],
      ['Ask Georges', null, ['cmclip']],
      ['References', null, []],
    ],
  )
})

test('a file stays under its line through the edits Brigade makes to a list, and a margin one stays free', async () => {
  // As insertLine writes what remains of a line: right under its text, before its files.
  const text = [
    '# Launch',
    '',
    '* [ ] Voice <!-- item:aaaaaaaaaaaaaaaa -->',
    '  * [ ] Ask Georges <!-- item:bbbbbbbbbbbbbbbb -->',
    '',
    '  ![shot.png](asset:cmshot)',
    '* [ ] Second',
    '',
    '  ![second.png](asset:cmsecond)',
    '',
    '![at the margin.png](asset:cmmargin)',
    '',
  ].join('\n')
  const once = await normalizeMarkdown(text)
  assert.equal(await normalizeMarkdown(once), once, 'stable')
  assert.deepEqual(
    parseList(once).lines.map((l) => [l.text, l.files.map((f) => f.id)]),
    [
      ['Voice', ['cmshot']],
      ['Ask Georges', []],
      ['Second', ['cmsecond']],
    ],
  )
  assert.match(once, /\n!\[at the margin\.png\]\(asset:cmmargin\)/)
})
