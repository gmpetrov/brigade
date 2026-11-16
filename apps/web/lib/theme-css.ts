// A theme's stylesheet, checked rule by rule as the browser parsed it, before it applies
// (docs/themes.md). The API checked its text already; escapes can hide from a check of the
// text, so this is the guard: a declaration that could load from anywhere but the theme's own
// files, inline data or a #fragment is dropped, and so is any kind of rule not known to be
// safe. `url("theme:<file>")` becomes the file's signed address in the bucket.
import { THEME_FILE_SCHEME, themeValueLoads, urlTargets } from '@brigade/contracts'

/** What this needs of a CSSStyleDeclaration. */
export type Declarations = {
  readonly length: number
  item(index: number): string
  getPropertyValue(property: string): string
  getPropertyPriority(property: string): string
  setProperty(property: string, value: string, priority?: string): void
  removeProperty(property: string): string
}

/** What this needs of a CSSRule. */
export type RuleLike = {
  readonly constructor: { readonly name: string }
  readonly style?: Declarations
  readonly cssRules?: ArrayLike<RuleLike>
  deleteRule?(index: number): void
  /** @property's. */
  readonly initialValue?: string | null
}

export type RuleParent = { readonly cssRules: ArrayLike<RuleLike>; deleteRule(index: number): void }

/**
 * Rules that may stay: style rules and the groups and at-rules around them. Any other kind
 * (@counter-style, whose symbols can be images; @font-feature-values; one a browser adds later)
 * is dropped.
 */
const KEPT = new Set([
  'CSSStyleRule',
  'CSSNestedDeclarations',
  'CSSMediaRule',
  'CSSSupportsRule',
  'CSSContainerRule',
  'CSSLayerBlockRule',
  'CSSLayerStatementRule',
  'CSSScopeRule',
  'CSSStartingStyleRule',
  'CSSKeyframesRule',
  'CSSKeyframeRule',
  'CSSFontFaceRule',
  'CSSPropertyRule',
  'CSSPageRule',
])

/** A value with its theme files named by their signed addresses; null when one has none. */
export function withFiles(value: string, files: Readonly<Record<string, string>>): string | null {
  const targets = urlTargets(value)
  if (!targets) return null
  let out = value
  for (const target of targets) {
    if (!target.startsWith(THEME_FILE_SCHEME)) continue
    const address = files[target.slice(THEME_FILE_SCHEME.length)]
    if (!address) return null
    // As the browser serializes a url(): quoted, with its quotes and backslashes escaped.
    const quoted = `url("${address.replace(/["\\]/g, (c) => `\\${c}`)}")`
    for (const written of [`url("${target}")`, `url('${target}')`, `url(${target})`])
      out = out.split(written).join(quoted)
  }
  return out
}

/** One rule's declarations: those that load from elsewhere go, theme files get their address. */
export function cleanDeclarations(style: Declarations, files: Readonly<Record<string, string>>) {
  const properties: string[] = []
  for (let i = 0; i < style.length; i++) properties.push(style.item(i))
  for (const property of properties) {
    const value = style.getPropertyValue(property)
    if (themeValueLoads(value)) {
      style.removeProperty(property)
      continue
    }
    if (!value.toLowerCase().includes(THEME_FILE_SCHEME)) continue
    // A file it does not have: the declaration goes rather than load nothing, or something else.
    const resolved = withFiles(value, files)
    if (resolved === null) style.removeProperty(property)
    else style.setProperty(property, resolved, style.getPropertyPriority(property))
  }
}

/** Every rule under `parent`, checked; what may not stay is deleted. */
export function cleanRules(parent: RuleParent, files: Readonly<Record<string, string>>) {
  for (let i = parent.cssRules.length - 1; i >= 0; i--) {
    const rule = parent.cssRules[i]!
    const kind = rule.constructor.name
    if (!KEPT.has(kind)) {
      parent.deleteRule(i)
      continue
    }
    if (kind === 'CSSPropertyRule' && rule.initialValue && themeValueLoads(rule.initialValue)) {
      parent.deleteRule(i)
      continue
    }
    if (rule.style) cleanDeclarations(rule.style, files)
    if (!rule.cssRules?.length) continue
    if (kind === 'CSSKeyframesRule') {
      // Its frames are deleted by their key, not their place: each is checked, none deleted.
      for (let f = 0; f < rule.cssRules.length; f++) {
        const frame = rule.cssRules[f]!
        if (frame.style) cleanDeclarations(frame.style, files)
      }
    } else if (typeof rule.deleteRule === 'function') cleanRules(rule as RuleParent, files)
    // A group whose rules cannot be checked one by one: it goes whole.
    else parent.deleteRule(i)
  }
}

let sheet: CSSStyleSheet | null = null

/**
 * Apply a theme's stylesheet after the dashboard's own, checked; an empty one takes it away.
 * A constructed sheet loads no @import, whatever it says.
 */
export function applyThemeCss(css: string, files: Readonly<Record<string, string>>) {
  if (typeof document === 'undefined' || typeof CSSStyleSheet === 'undefined') return
  if (!css.trim()) {
    if (sheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet)
    sheet = null
    return
  }
  const next = new CSSStyleSheet()
  try {
    next.replaceSync(css)
  } catch {
    return
  }
  cleanRules(next as unknown as RuleParent, files)
  const others = document.adoptedStyleSheets.filter((s) => s !== sheet)
  sheet = next
  document.adoptedStyleSheets = [...others, next]
}
