// Stands in for jsdom on Workers (wrangler.jsonc alias), where jsdom does not run:
// @blocknote/server-util only needs `new JSDOM().window`, for the collab
// conversions in src/collab.ts. linkedom is a DOM in plain JavaScript; what
// BlockNote uses that it lacks or gets wrong is added here.
import { parseHTML } from 'linkedom'

const page = (title = '') =>
  `<!doctype html><html><head><title>${title}</title></head><body></body></html>`

const FILTER_ACCEPT = 1
const FILTER_REJECT = 2

type Filter = ((node: Node) => number) | { acceptNode(node: Node): number } | null

/**
 * A TreeWalker that honours its filter, which linkedom's ignores: BlockNote
 * rejects the text inside <pre> and <code> so that their whitespace is kept.
 */
function createTreeWalker(root: Node, whatToShow = 0xffffffff, filter: Filter = null) {
  const accept =
    typeof filter === 'function' ? filter : filter ? (n: Node) => filter.acceptNode(n) : null
  const step = (node: Node, skipChildren: boolean): Node | null => {
    if (!skipChildren && node.firstChild) return node.firstChild
    for (let n: Node | null = node; n && n !== root; n = n.parentNode)
      if (n.nextSibling) return n.nextSibling
    return null
  }
  let current = root
  return {
    root,
    whatToShow,
    filter,
    get currentNode() {
      return current
    },
    nextNode() {
      let node: Node | null = current
      let skipChildren = false
      for (;;) {
        node = step(node, skipChildren)
        if (!node) return null
        skipChildren = false
        if (!((whatToShow >> (node.nodeType - 1)) & 1)) continue
        const result = accept ? accept(node) : FILTER_ACCEPT
        if (result === FILTER_ACCEPT) return (current = node)
        if (result === FILTER_REJECT) skipChildren = true
      }
    },
  }
}

/** An input's `checked`, which linkedom does not reflect from its attribute (checklists). */
function reflectChecked(input: object | undefined) {
  if (!input || Object.getOwnPropertyDescriptor(input, 'checked')) return
  Object.defineProperty(input, 'checked', {
    configurable: true,
    get(this: Element) {
      return this.hasAttribute('checked')
    },
    set(this: Element, value: boolean) {
      if (value) this.setAttribute('checked', '')
      else this.removeAttribute('checked')
    },
  })
}

function windowOf(html: string) {
  const { window } = parseHTML(html)
  reflectChecked(
    (window as { HTMLInputElement?: { prototype: object } }).HTMLInputElement?.prototype,
  )
  const document = window.document
  Object.defineProperties(document, {
    implementation: {
      value: { createHTMLDocument: (title?: string) => windowOf(page(title)).document },
    },
    createTreeWalker: { value: createTreeWalker },
  })
  return window as unknown as Window & typeof globalThis
}

export class JSDOM {
  readonly window: Window & typeof globalThis

  constructor(html = page()) {
    this.window = windowOf(html)
  }
}
