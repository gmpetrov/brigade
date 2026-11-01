import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mentionsToText } from '../dist/mentions.js'
import {
  PreviewElement,
  formatPreviewElement,
  splitPreviewElements,
} from '../dist/preview-elements.js'

const hero = {
  label: 'HeroCopy › h1.title',
  page: '/?plan="pro"&x=1',
  selector: 'main > div.hero > h1.title',
  components: ['Landing', 'HeroCopy'],
  props: { pagePath: 'page.tsx', title: 'Say "hi"' },
  size: '672×419',
  text: 'One team builds it, sells it',
  image: 'element-1.png',
  html: '<h1 class="title">One team builds it,\nsells it</h1>',
}

test('an element written into a message reads back as it was, apart from its text', () => {
  const text = `Make this bigger\n\n${formatPreviewElement(hero)}\n\n${formatPreviewElement({ label: 'button', page: hero.page, selector: hero.selector, html: hero.html })}`
  const { text: rest, elements } = splitPreviewElements(text)
  assert.equal(rest, 'Make this bigger')
  assert.deepEqual(elements[0], hero)
  assert.deepEqual(elements[1], {
    label: 'button',
    page: hero.page,
    selector: hero.selector,
    html: hero.html,
  })
  assert.ok(PreviewElement.safeParse(elements[0]).success)
})

test('a page whose HTML closes the block does not end it early', () => {
  const html = '<p>see </preview-element> here</p>'
  const { text, elements } = splitPreviewElements(formatPreviewElement({ ...hero, html }))
  assert.equal(text, '')
  assert.equal(elements.length, 1)
  assert.ok(elements[0].html.includes('here'))
})

test('previews and titles show an element by its label', () => {
  assert.equal(
    mentionsToText(`Fix @[Cody](teammate:cody) ${formatPreviewElement(hero)}`),
    'Fix @Cody [HeroCopy › h1.title]',
  )
  assert.equal(splitPreviewElements('plain').text, 'plain')
})

test('a note written beside an element goes with it, line breaks and quotes kept', () => {
  const note = 'Make it "violet"\nand bold & bigger'
  const { elements } = splitPreviewElements(formatPreviewElement({ ...hero, note: `  ${note} ` }))
  assert.equal(elements[0].note, note)
  assert.ok(PreviewElement.safeParse(elements[0]).success)
  assert.equal(
    mentionsToText(formatPreviewElement({ ...hero, note })),
    '[HeroCopy › h1.title: Make it "violet" and bold & bigger]',
  )
})

test('an empty note is left out', () => {
  const block = formatPreviewElement({ ...hero, note: '  ' })
  assert.ok(!block.includes('note='))
  assert.equal(splitPreviewElements(block).elements[0].note, undefined)
})
