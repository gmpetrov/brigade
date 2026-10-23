// The code editor's search bar (components/code-editor.tsx), as Claude's: one field at
// the top with its options inside it (match case, whole word, regular expression), the
// match it is on out of how many, previous, next and close. Matches are found as you type.
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  search,
  SearchQuery,
  setSearchQuery,
} from '@codemirror/search'
import { EditorSelection, type EditorState } from '@codemirror/state'
import { EditorView, type Panel, type ViewUpdate } from '@codemirror/view'

/** Counting stops here: past it, the bar says "1000+". */
const COUNT_MAX = 1000

// Lucide's arrow-up, arrow-down and x, as the dashboard's icons.
const svg = (paths: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
const UP = svg('<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>')
const DOWN = svg('<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>')
const CLOSE = svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>')

/** Which match the selection is on, out of how many (both 0 when none). */
export function countMatches(state: EditorState, query: SearchQuery) {
  if (!query.valid) return { index: 0, total: 0, more: false }
  const { from, to } = state.selection.main
  const cursor = query.getCursor(state)
  let total = 0
  let index = 0
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    total++
    if (next.value.from === from && next.value.to === to) index = total
    if (total >= COUNT_MAX) return { index, total, more: !cursor.next().done }
  }
  return { index, total, more: false }
}

/** Selects the first match at or after `from`, else the first one: as you type. */
function jump(view: EditorView, query: SearchQuery, from: number) {
  if (!query.valid) return
  const cursor = query.getCursor(view.state, from)
  let match = cursor.next()
  if (match.done) match = query.getCursor(view.state).next()
  if (match.done) return
  view.dispatch({
    selection: EditorSelection.single(match.value.from, match.value.to),
    effects: EditorView.scrollIntoView(match.value.from, { y: 'center' }),
    userEvent: 'select.search',
  })
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  el.className = className
  el.append(...children)
  return el
}

function searchBar(view: EditorView): Panel {
  let query = getSearchQuery(view.state)

  const input = element('input', 'cm-bsearch-input')
  input.type = 'text'
  input.value = query.search
  input.placeholder = 'Find'
  input.spellcheck = false
  input.autocomplete = 'off'
  input.setAttribute('aria-label', 'Find in the file')
  input.setAttribute('main-field', 'true')

  const toggle = (label: string, title: string, key: 'caseSensitive' | 'wholeWord' | 'regexp') => {
    const button = element('button', 'cm-bsearch-option')
    button.type = 'button'
    button.title = title
    button.textContent = label
    button.setAttribute('aria-label', title)
    button.addEventListener('mousedown', (e) => e.preventDefault())
    button.addEventListener('click', () => {
      commit({ [key]: !query[key] })
      // Back to typing, at the end of what is there.
      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
    })
    return button
  }
  const matchCase = toggle('Aa', 'Match case', 'caseSensitive')
  const wholeWord = toggle('ab', 'Whole word', 'wholeWord')
  wholeWord.classList.add('cm-bsearch-word')
  const regexp = toggle('.*', 'Regular expression', 'regexp')

  const count = element('span', 'cm-bsearch-count')
  count.setAttribute('aria-live', 'polite')

  const icon = (html: string, title: string, run: () => void) => {
    const button = element('button', 'cm-bsearch-icon')
    button.type = 'button'
    button.title = title
    button.innerHTML = html
    button.setAttribute('aria-label', title)
    button.addEventListener('mousedown', (e) => e.preventDefault())
    button.addEventListener('click', run)
    return button
  }
  const previous = icon(UP, 'Previous match (Shift+Enter)', () => findPrevious(view))
  const next = icon(DOWN, 'Next match (Enter)', () => findNext(view))
  const close = icon(CLOSE, 'Close (Esc)', () => {
    closeSearchPanel(view)
    view.focus()
  })

  const field = element('div', 'cm-bsearch-field', input, matchCase, wholeWord, regexp)
  const dom = element('div', 'cm-bsearch', field, count, previous, next, close)
  dom.setAttribute('role', 'search')

  /** A new query from the field and its options, found from where the selection starts. */
  function commit(change: Partial<ConstructorParameters<typeof SearchQuery>[0]> = {}) {
    const fresh = new SearchQuery({
      search: input.value,
      caseSensitive: query.caseSensitive,
      wholeWord: query.wholeWord,
      regexp: query.regexp,
      ...change,
    })
    if (fresh.eq(query)) return
    query = fresh
    view.dispatch({ effects: setSearchQuery.of(fresh) })
    jump(view, fresh, view.state.selection.main.from)
  }

  function show() {
    matchCase.setAttribute('aria-pressed', String(query.caseSensitive))
    wholeWord.setAttribute('aria-pressed', String(query.wholeWord))
    regexp.setAttribute('aria-pressed', String(query.regexp))
    const invalid = query.search !== '' && !query.valid
    field.classList.toggle('cm-bsearch-invalid', invalid)
    const { index, total, more } = countMatches(view.state, query)
    count.textContent = !query.search
      ? ''
      : invalid
        ? 'Invalid'
        : total === 0
          ? 'No results'
          : `${index || '?'} of ${total}${more ? '+' : ''}`
    count.classList.toggle('cm-bsearch-none', !!query.search && total === 0)
    previous.disabled = next.disabled = total === 0
  }

  input.addEventListener('input', () => commit())
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) findPrevious(view)
      else findNext(view)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeSearchPanel(view)
      view.focus()
    }
  })

  show()
  return {
    dom,
    top: true,
    mount: () => input.select(),
    update(update: ViewUpdate) {
      // Opened again with another query (Mod-F on a selection): the field follows it.
      for (const tr of update.transactions)
        for (const effect of tr.effects)
          if (effect.is(setSearchQuery) && !effect.value.eq(query)) {
            query = effect.value
            input.value = query.search
          }
      if (
        update.docChanged ||
        update.selectionSet ||
        update.transactions.some((t) => t.effects.length)
      )
        show()
    },
  }
}

/** Its search, with the bar above; Mod-F opens it (basicSetup's keys). */
export const codeSearch = [
  search({ top: true, createPanel: searchBar }),
  EditorView.theme({
    '.cm-panels-top': { borderBottom: '1px solid var(--border)' },
    '.cm-bsearch': {
      display: 'flex',
      alignItems: 'center',
      gap: '4px',
      padding: '8px 10px',
      fontFamily: 'var(--font-sans)',
      fontSize: '13px',
    },
    '.cm-bsearch-field': {
      flex: '1',
      minWidth: '0',
      display: 'flex',
      alignItems: 'center',
      gap: '2px',
      height: '32px',
      padding: '0 4px 0 10px',
      borderRadius: '8px',
      border: '1px solid var(--border)',
      backgroundColor: 'var(--background)',
    },
    '.cm-bsearch-field:focus-within': {
      borderColor: 'var(--primary)',
      boxShadow: '0 0 0 3px color-mix(in oklch, var(--primary) 20%, transparent)',
    },
    '.cm-bsearch-field.cm-bsearch-invalid': { borderColor: 'var(--destructive)' },
    '.cm-bsearch-input': {
      flex: '1',
      minWidth: '0',
      border: 'none',
      outline: 'none',
      background: 'transparent',
      color: 'var(--foreground)',
      font: 'inherit',
    },
    '.cm-bsearch-input::placeholder': { color: 'var(--muted-foreground)' },
    '.cm-bsearch-option': {
      height: '24px',
      minWidth: '26px',
      padding: '0 5px',
      borderRadius: '5px',
      border: 'none',
      background: 'transparent',
      color: 'var(--muted-foreground)',
      fontFamily: 'var(--font-mono)',
      fontSize: '12px',
      cursor: 'pointer',
    },
    '.cm-bsearch-word': { textDecoration: 'underline', textUnderlineOffset: '3px' },
    '.cm-bsearch-option:hover': { color: 'var(--foreground)', backgroundColor: 'var(--muted)' },
    '.cm-bsearch-option[aria-pressed="true"]': {
      color: 'var(--primary)',
      backgroundColor: 'color-mix(in oklch, var(--primary) 14%, transparent)',
    },
    '.cm-bsearch-count': {
      minWidth: '64px',
      padding: '0 6px',
      textAlign: 'right',
      whiteSpace: 'nowrap',
      color: 'var(--muted-foreground)',
      fontVariantNumeric: 'tabular-nums',
    },
    '.cm-bsearch-none': { color: 'var(--destructive-text)' },
    '.cm-bsearch-icon': {
      display: 'grid',
      placeItems: 'center',
      width: '28px',
      height: '28px',
      borderRadius: '6px',
      border: 'none',
      background: 'transparent',
      color: 'var(--muted-foreground)',
      cursor: 'pointer',
    },
    '.cm-bsearch-icon:hover:not(:disabled)': {
      color: 'var(--foreground)',
      backgroundColor: 'var(--muted)',
    },
    '.cm-bsearch-icon:disabled': { opacity: '0.4', cursor: 'default' },
    '.cm-searchMatch': {
      backgroundColor: 'color-mix(in oklch, var(--warning) 22%, transparent)',
      borderRadius: '2px',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'color-mix(in oklch, var(--warning) 45%, transparent)',
      outline: '1px solid color-mix(in oklch, var(--warning) 70%, transparent)',
    },
  }),
]
