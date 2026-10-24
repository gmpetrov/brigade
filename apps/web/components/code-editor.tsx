'use client'
// A code editor (CodeMirror) for a text file of a teammate's working folder, in
// the file panel. Loaded only when a file opens in it (components/file-panel.tsx).
// Colors come from the dashboard's code tokens (globals.css), in light and dark.
// Given the file as in the last commit, it shows what changed since, each change
// with a button that reverts it (@codemirror/merge's unified view).
import { indentWithTab } from '@codemirror/commands'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { yaml } from '@codemirror/lang-yaml'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { unifiedMergeView } from '@codemirror/merge'
import {
  Annotation,
  Compartment,
  EditorState,
  Transaction,
  type Extension,
} from '@codemirror/state'
import { openSearchPanel } from '@codemirror/search'
import { EditorView, keymap } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { basicSetup } from 'codemirror'
import { useEffect, useRef, type RefObject } from 'react'
import { codeSearch } from '@/components/code-search'
import { textChange } from '@/lib/text-diff'

/** The language of a file, by its extension. */
function language(path: string): Extension {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
  switch (extension) {
    case 'ts':
    case 'mts':
    case 'cts':
      return javascript({ typescript: true })
    case 'tsx':
      return javascript({ typescript: true, jsx: true })
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return javascript({ jsx: true })
    case 'css':
    case 'scss':
    case 'less':
      return css()
    case 'html':
    case 'htm':
    case 'vue':
    case 'svelte':
    case 'astro':
      return html()
    case 'json':
    case 'jsonc':
      return json()
    case 'md':
    case 'mdx':
      return markdown()
    case 'py':
      return python()
    case 'yml':
    case 'yaml':
      return yaml()
    default:
      return []
  }
}

const highlight = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.modifier, tags.operatorKeyword, tags.controlKeyword],
    color: 'var(--code-keyword)',
  },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--code-string)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--code-number)' },
  {
    tag: [tags.typeName, tags.className, tags.namespace, tags.standard(tags.name)],
    color: 'var(--code-number)',
  },
  {
    tag: [tags.propertyName, tags.attributeName, tags.tagName, tags.labelName],
    color: 'var(--code-key)',
  },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: 'var(--code-title)',
  },
  { tag: [tags.heading], color: 'var(--code-title)', fontWeight: '600' },
  { tag: [tags.comment, tags.meta], color: 'var(--code-comment)', fontStyle: 'italic' },
  { tag: tags.link, color: 'var(--code-key)', textDecoration: 'underline' },
  { tag: tags.invalid, color: 'var(--destructive-text)' },
])

const theme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '12px',
    backgroundColor: 'transparent',
    color: 'var(--foreground)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--foreground)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'color-mix(in oklch, var(--primary) 22%, transparent)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--card)',
    color: 'var(--muted-foreground)',
    borderRight: '1px solid var(--border)',
  },
  '.cm-activeLine': { backgroundColor: 'color-mix(in oklch, var(--muted) 55%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--muted)', color: 'var(--foreground)' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in oklch, var(--primary) 12%, transparent)' },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'color-mix(in oklch, var(--primary) 18%, transparent)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--card)',
    color: 'var(--foreground)',
    borderColor: 'var(--border)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--popover)',
    color: 'var(--popover-foreground)',
    border: '1px solid var(--border)',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--muted)',
    color: 'var(--muted-foreground)',
    border: 'none',
  },
  // What changed since the last commit: over the merge view's own colors, which know
  // no dark theme but CodeMirror's.
  '.cm-changedLine, .cm-inlineChangedLine': {
    backgroundColor: 'color-mix(in oklch, var(--success) 10%, transparent) !important',
  },
  '.cm-changedText': {
    background: 'color-mix(in oklch, var(--success) 24%, transparent) !important',
  },
  '.cm-deletedChunk': {
    // Its Revert button sits at its right, not the editor's top.
    position: 'relative',
    backgroundColor: 'color-mix(in oklch, var(--destructive-text) 10%, transparent) !important',
  },
  '.cm-deletedChunk .cm-deletedText': {
    background: 'color-mix(in oklch, var(--destructive-text) 24%, transparent) !important',
  },
  '.cm-changedLineGutter': { background: 'var(--success) !important' },
  '.cm-deletedLineGutter': { background: 'var(--destructive-text) !important' },
  '.cm-deletedChunk .cm-chunkButtons': { top: '2px', insetInlineEnd: '8px', zIndex: '1' },
  '.cm-deletedChunk .cm-chunkButtons button.cm-revert': {
    fontFamily: 'var(--font-sans)',
    fontSize: '11px',
    lineHeight: '16px',
    padding: '0 6px',
    margin: '0',
    border: '1px solid var(--border) !important',
    borderRadius: '6px',
    background: 'var(--card) !important',
    color: 'var(--foreground) !important',
  },
  '.cm-deletedChunk .cm-chunkButtons button.cm-revert:hover': {
    background: 'var(--muted) !important',
  },
})

/** A change's button: Revert, back as in the last commit (an edit, undone like any). No Accept. */
function chunkButton(type: 'accept' | 'reject', action: (e: MouseEvent) => void) {
  if (type === 'accept') {
    const none = document.createElement('span')
    none.hidden = true
    return none
  }
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'cm-revert'
  button.textContent = '↶ Revert'
  button.title = 'Put this back as in the last commit'
  button.onmousedown = action
  return button
}

/** What changed since `original`, with its Revert buttons when it may be edited; none without one. */
const changesSince = (original: string | null | undefined, readOnly: boolean): Extension =>
  original == null
    ? []
    : unifiedMergeView({
        original,
        gutter: true,
        highlightChanges: true,
        syntaxHighlightDeletions: true,
        mergeControls: readOnly ? false : chunkButton,
      })

/** What the editor's owner does in it: its search bar, a line, the file as changed elsewhere. */
export type CodeEditorControls = {
  search: () => void
  /** Puts the cursor on a line and shows it. */
  goto: (line: number) => void
  /** The file as it is now on the computer: one change, so the cursor and scroll stay. */
  replace: (text: string) => void
}

/** Changes that come from the computer, not from typing: not reported as edits, nor undone. */
const fromComputer = Annotation.define<boolean>()

export default function CodeEditor({
  path,
  initial,
  line,
  onChange,
  onSave,
  controls,
  readOnly = false,
  original,
}: {
  /** For its language. */
  path: string
  /** What it opens with; remount it (a new key) to start again from another text. */
  initial: string
  /** The line to show and put the cursor on. */
  line?: number
  onChange: (text: string) => void
  /** Mod-S. */
  onSave: () => void
  controls?: RefObject<CodeEditorControls | null>
  /** Shown, not edited: for whoever may not write to the thread. */
  readOnly?: boolean
  /** The file as in the last commit, to show what changed since; null or unset: nothing shown. */
  original?: string | null
}) {
  const host = useRef<HTMLDivElement>(null)
  const latest = useRef({ onChange, onSave })
  latest.current = { onChange, onSave }
  const editor = useRef<EditorView>(null)
  const changes = useRef(new Compartment())

  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initial,
        extensions: [
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                latest.current.onSave()
                return true
              },
            },
            indentWithTab,
          ]),
          // Before basicSetup: its search bar, not CodeMirror's.
          codeSearch,
          // Line numbers, undo, search keys, brackets, folding, completion from the file's words.
          basicSetup,
          language(path),
          syntaxHighlighting(highlight),
          theme,
          EditorState.readOnly.of(readOnly),
          changes.current.of(changesSince(original, readOnly)),
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              update.transactions.some((tr) => tr.docChanged && !tr.annotation(fromComputer))
            )
              latest.current.onChange(update.state.doc.toString())
          }),
        ],
      }),
    })
    const goto = (line: number) => {
      if (line < 1 || line > view.state.doc.lines) return
      const at = view.state.doc.line(line).from
      view.dispatch({
        selection: { anchor: at },
        effects: EditorView.scrollIntoView(at, { y: 'center' }),
      })
      view.focus()
    }
    if (line) goto(line)
    editor.current = view
    if (controls)
      controls.current = {
        search: () => openSearchPanel(view),
        goto,
        replace: (text) => {
          const change = textChange(view.state.doc.toString(), text)
          if (change.from === change.to && !change.insert) return
          view.dispatch({
            changes: change,
            annotations: [fromComputer.of(true), Transaction.addToHistory.of(false)],
          })
        },
      }
    return () => {
      if (controls) controls.current = null
      editor.current = null
      view.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one editor per file; a new key starts another
  }, [])

  // A commit made since, or the last commit read after the editor opened: changes against it.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    editor.current?.dispatch({
      effects: changes.current.reconfigure(changesSince(original, readOnly)),
    })
  }, [original, readOnly])

  // data-keyboard: Escape stays the editor's (its search, its completions), never closes the panel.
  return <div ref={host} data-keyboard className="code-editor h-full min-h-0" />
}
