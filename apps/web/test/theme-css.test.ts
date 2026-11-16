// A theme's stylesheet, checked rule by rule as the browser parsed it (lib/theme-css).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  cleanRules,
  withFiles,
  type Declarations,
  type RuleLike,
  type RuleParent,
} from '../lib/theme-css'

/** A CSSStyleDeclaration as the browser gives it: properties in order, values as serialized. */
class Style implements Declarations {
  values = new Map<string, { value: string; priority: string }>()
  constructor(entries: Record<string, string>) {
    for (const [k, v] of Object.entries(entries)) this.values.set(k, { value: v, priority: '' })
  }
  get length() {
    return this.values.size
  }
  item(index: number) {
    return [...this.values.keys()][index] ?? ''
  }
  getPropertyValue(property: string) {
    return this.values.get(property)?.value ?? ''
  }
  getPropertyPriority(property: string) {
    return this.values.get(property)?.priority ?? ''
  }
  setProperty(property: string, value: string, priority = '') {
    this.values.set(property, { value, priority })
  }
  removeProperty(property: string) {
    const was = this.getPropertyValue(property)
    this.values.delete(property)
    return was
  }
  toJSON() {
    return Object.fromEntries([...this.values].map(([k, v]) => [k, v.value]))
  }
}

const named = (name: string) => ({ name })
const rule = (kind: string, extra: Partial<RuleLike> = {}): RuleLike => ({
  constructor: named(kind),
  ...extra,
})
class Group implements RuleParent {
  constructor(public rules: RuleLike[]) {}
  get cssRules() {
    return this.rules
  }
  deleteRule(index: number) {
    this.rules.splice(index, 1)
  }
}
const group = (kind: string, rules: RuleLike[]) => {
  const g = new Group(rules)
  return Object.assign(g, { constructor: named(kind) }) as unknown as RuleLike & Group
}

const FILES = { 'paper.png': 'https://bucket.example/paper?X-Amz-Signature=abc' }

test('a declaration that loads from elsewhere goes; the others stay', () => {
  const style = new Style({
    color: 'red',
    'background-image': 'url("https://evil.example/leak.png")',
    'border-image-source': 'url("data:image/png;base64,AAAA")',
    '--x': '\\75 rl(https://evil.example)',
    cursor: 'image-set("a.png" 1x), auto',
  })
  const sheet = new Group([rule('CSSStyleRule', { style })])
  cleanRules(sheet, FILES)
  assert.deepEqual(style.toJSON(), {
    color: 'red',
    'border-image-source': 'url("data:image/png;base64,AAAA")',
  })
})

test("a theme's own file gets its signed address, with its priority; a missing one goes", () => {
  const style = new Style({
    'background-image': 'url("theme:paper.png")',
    'list-style-image': 'url("theme:gone.png")',
  })
  style.values.get('background-image')!.priority = 'important'
  cleanRules(new Group([rule('CSSStyleRule', { style })]), FILES)
  assert.deepEqual(style.toJSON(), {
    'background-image': `url("${FILES['paper.png']}")`,
  })
  assert.equal(style.getPropertyPriority('background-image'), 'important')
})

test('rules of a kind not known to be safe go whole; groups are checked inside', () => {
  const inside = new Style({ background: 'url("https://evil.example/a.png")', color: 'blue' })
  const media = group('CSSMediaRule', [rule('CSSStyleRule', { style: inside })])
  const sheet = new Group([
    rule('CSSCounterStyleRule'),
    media,
    rule('CSSImportRule'),
    rule('CSSPropertyRule', { initialValue: 'url("https://evil.example/p.png")' }),
    rule('CSSPropertyRule', { initialValue: '0px' }),
  ])
  cleanRules(sheet, FILES)
  assert.deepEqual(
    sheet.rules.map((r) => r.constructor.name),
    ['CSSMediaRule', 'CSSPropertyRule'],
  )
  assert.deepEqual(inside.toJSON(), { color: 'blue' })
})

test('keyframes and font faces are checked, frame by frame', () => {
  const frame = new Style({ 'background-image': 'url("https://evil.example/f.png")', opacity: '1' })
  const face = new Style({ 'font-family': 'Paper', src: 'url("https://evil.example/f.woff2")' })
  const keyframes = Object.assign(
    { cssRules: [rule('CSSKeyframeRule', { style: frame })] },
    {
      constructor: named('CSSKeyframesRule'),
      deleteRule: () => assert.fail('a frame is deleted by its key, never its place'),
    },
  ) as RuleLike
  cleanRules(new Group([keyframes, rule('CSSFontFaceRule', { style: face })]), FILES)
  assert.deepEqual(frame.toJSON(), { opacity: '1' })
  assert.deepEqual(face.toJSON(), { 'font-family': 'Paper' })
})

test('nested style rules are checked too', () => {
  const nested = new Style({ background: 'url(https://evil.example/n.png)' })
  const parent = group('CSSStyleRule', [rule('CSSNestedDeclarations', { style: nested })])
  Object.assign(parent, { style: new Style({ color: 'red' }) })
  cleanRules(new Group([parent]), FILES)
  assert.deepEqual(nested.toJSON(), {})
})

test('withFiles names each file by its address, quoted', () => {
  assert.equal(
    withFiles('url("theme:paper.png") center, url(theme:paper.png)', FILES),
    `url("${FILES['paper.png']}") center, url("${FILES['paper.png']}")`,
  )
  assert.equal(withFiles('url("theme:gone.png")', FILES), null)
})
