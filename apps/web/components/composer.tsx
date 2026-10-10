'use client'
import { formatMention, parseMentions, type Mention, type MentionKind } from '@brigade/contracts'
import { Extension, type JSONContent } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import HardBreak from '@tiptap/extension-hard-break'
import MentionNode from '@tiptap/extension-mention'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { Placeholder, UndoRedo } from '@tiptap/extensions'
import {
  EditorContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  ReactRenderer,
  useEditor,
  type ReactNodeViewProps,
} from '@tiptap/react'
import type { SuggestionProps } from '@tiptap/suggestion'
import { useEffect, useMemo, useRef } from 'react'
import { useDashboard } from '@/components/dashboard'
import { credentialHint, MentionChip, MentionIcon, type ConnectionKind } from '@/components/mention'
import {
  computerName,
  useApi,
  type ComputersResponse,
  type ConnectionsResponse,
  type Credential,
  type ThreadSummary,
} from '@/lib/api'
import { cn } from '@/lib/utils'

/** Something to mention, with what the menu shows beside it. */
type Option = Mention & { hint?: string; connectionKind?: ConnectionKind }

const groups: { kind: MentionKind; title: string; max: number }[] = [
  { kind: 'teammate', title: 'Teammates', max: 5 },
  { kind: 'connection', title: 'Connections', max: 5 },
  { kind: 'credential', title: 'Credentials', max: 5 },
  { kind: 'thread', title: 'Threads', max: 4 },
  { kind: 'computer', title: 'Computers', max: 3 },
]

/** Everything in the workspace a message can mention. */
function useMentionOptions(threadId?: string): Option[] {
  const { teammates } = useDashboard()
  const connections = useApi<ConnectionsResponse>('/connections')
  const threads = useApi<ThreadSummary[]>('/threads')
  const computers = useApi<ComputersResponse>('/computers')
  const credentials = useApi<Credential[]>('/credentials')
  return useMemo(
    () => [
      ...teammates.map((t) => ({
        kind: 'teammate' as const,
        id: t.id,
        label: t.name,
        hint: 'AI teammate',
      })),
      ...(connections.data?.connections ?? [])
        // A custom app only sends events: there is nothing for a teammate to use.
        .filter((c) => c.status !== 'removed' && c.kind !== 'webhook')
        .map((c) => ({
          kind: 'connection' as const,
          id: c.id,
          label: c.label,
          hint: c.externalAccount ?? undefined,
          connectionKind: c.kind,
        })),
      ...(credentials.data ?? []).map((c) => ({
        kind: 'credential' as const,
        id: c.id,
        label: c.name,
        hint: credentialHint(c),
      })),
      ...(threads.data ?? [])
        .filter((t) => t.id !== threadId)
        .map((t) => ({
          kind: 'thread' as const,
          id: t.id,
          label: t.title,
          hint: t.teammate.name,
        })),
      ...(computers.data?.computers ?? [])
        .filter((c) => c.status !== 'destroyed')
        .map((c) => ({ kind: 'computer' as const, id: c.id, label: computerName(c) })),
    ],
    [teammates, connections.data, credentials.data, threads.data, computers.data, threadId],
  )
}

/** Matches for a query, grouped by kind; names that start with it first. */
function search(options: Option[], query: string) {
  const q = query.trim().toLowerCase()
  return groups.flatMap((g) =>
    options
      .filter((o) => o.kind === g.kind && o.label.toLowerCase().includes(q))
      .sort(
        (a, b) =>
          Number(!a.label.toLowerCase().startsWith(q)) -
          Number(!b.label.toLowerCase().startsWith(q)),
      )
      .slice(0, g.max),
  )
}

type MenuProps = {
  items: Option[]
  selected: number
  query: string
  onPick: (option: Option) => void
  onHover: (index: number) => void
}

/** max-h-80, in px: whether the menu fits above the composer. */
const MENU_MAX_HEIGHT = 320

const menuClass =
  'max-h-80 w-full overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg'

function MentionMenu({ items, selected, query, onPick, onHover }: MenuProps) {
  // Only a moving pointer selects: rows scrolling under a still one (arrow keys) do not.
  const pointer = useRef('')
  if (!items.length)
    return (
      <div className={menuClass}>
        <p className="px-2 py-1.5 text-sm text-muted-foreground">Nothing matches “{query}”</p>
      </div>
    )
  return (
    <div className={menuClass} role="listbox">
      {items.map((o, i) => (
        <div key={`${o.kind}:${o.id}`}>
          {o.kind !== items[i - 1]?.kind && (
            <div className="px-2 pt-2 pb-0.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
              {groups.find((g) => g.kind === o.kind)?.title}
            </div>
          )}
          <button
            type="button"
            role="option"
            aria-selected={i === selected}
            className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm aria-selected:bg-primary/15 aria-selected:shadow-[inset_2px_0_0_var(--primary)]"
            // Keep the editor's selection: pick on mousedown, before it blurs.
            onMouseDown={(e) => {
              e.preventDefault()
              onPick(o)
            }}
            onMouseMove={(e) => {
              const at = `${e.clientX},${e.clientY}`
              if (at === pointer.current) return
              pointer.current = at
              if (i !== selected) onHover(i)
            }}
            ref={(el) => {
              if (i === selected) el?.scrollIntoView({ block: 'nearest' })
            }}
          >
            <span className="inline-flex text-muted-foreground group-aria-selected:text-primary">
              <MentionIcon kind={o.kind} connectionKind={o.connectionKind} />
            </span>
            <span className="min-w-0 flex-1 truncate">{o.label}</span>
            {o.hint && (
              <span className="max-w-[45%] flex-none truncate text-xs text-muted-foreground">
                {o.hint}
              </span>
            )}
          </button>
        </div>
      ))}
    </div>
  )
}

function MentionView({ node, selected }: ReactNodeViewProps) {
  const { kind, id, label } = node.attrs as Mention
  return (
    <NodeViewWrapper as="span">
      <MentionChip
        mention={{ kind, id, label }}
        className={selected ? 'rounded-md outline-2 outline-offset-1 outline-primary' : undefined}
      />
    </NodeViewWrapper>
  )
}

/** The `@` menu: arrows move, Enter or Tab picks, Escape closes. */
function renderMenu() {
  let component: ReactRenderer<unknown, MenuProps> | undefined
  let unmount: (() => void) | undefined
  let current: SuggestionProps<Option, Mention>
  let selected = 0
  const menuProps = (): MenuProps => ({
    items: current.items,
    selected,
    query: current.query,
    onPick: ({ kind, id, label }) => current.command({ kind, id, label }),
    onHover: (index) => {
      selected = index
      component?.updateProps(menuProps())
    },
  })
  return {
    onStart(props: SuggestionProps<Option, Mention>) {
      current = props
      selected = 0
      component = new ReactRenderer(MentionMenu, { props: menuProps(), editor: props.editor })
      // Like a chat app's command menu: docked to the composer's frame, full width, above
      // it (below when there's no room above), rather than floating at the caret.
      const editorDom = props.editor.view.dom
      const frame =
        editorDom.closest<HTMLElement>('[data-composer-frame]') ?? editorDom.parentElement!
      const above = frame.getBoundingClientRect().top > MENU_MAX_HEIGHT + 16
      component.element.className = cn(
        'absolute inset-x-0 z-50',
        above ? 'bottom-full mb-2' : 'top-full mt-2',
      )
      frame.append(component.element)
      unmount = () => component?.element.remove()
    },
    onUpdate(props: SuggestionProps<Option, Mention>) {
      current = props
      selected = 0
      component?.updateProps(menuProps())
    },
    onKeyDown({ event }: { event: KeyboardEvent }) {
      const n = current.items.length
      if (!n) return false
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        selected = (selected + (event.key === 'ArrowDown' ? 1 : n - 1)) % n
        component?.updateProps(menuProps())
        return true
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        menuProps().onPick(current.items[selected]!)
        return true
      }
      return false
    },
    onExit() {
      unmount?.()
      component?.destroy()
      component = undefined
    },
  }
}

/** Message text, one paragraph per line, mentions as nodes. */
function toDoc(text: string): JSONContent {
  return {
    type: 'doc',
    content: text.split('\n').map((line) => ({
      type: 'paragraph',
      content: parseMentions(line)
        .filter((part) => part !== '')
        .map((part) =>
          typeof part === 'string'
            ? { type: 'text', text: part }
            : { type: 'mention', attrs: { ...part, mentionSuggestionChar: '@' } },
        ),
    })),
  }
}

/**
 * A message box where `@` mentions teammates, connections, credentials, threads
 * and computers. Its value is plain text; mentions are `@[Label](kind:id)` in it.
 * Mentioning a credential lets the thread's teammate use it there.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled,
  rows = 3,
  name,
  id,
  threadId,
  bare,
}: {
  value: string
  onChange: (text: string) => void
  /** Cmd/Ctrl+Enter. */
  onSubmit?: () => void
  placeholder?: string
  disabled?: boolean
  rows?: number
  /** Posts the text with its form, as a hidden input. */
  name?: string
  id?: string
  /** The thread being replied in, left out of the menu. */
  threadId?: string
  /** No border of its own: the surrounding card frames it. */
  bare?: boolean
}) {
  const options = useMentionOptions(threadId)
  // The editor is built once; these keep its callbacks current.
  const latest = useRef({ options, onChange, onSubmit, placeholder })
  latest.current = { options, onChange, onSubmit, placeholder }
  const text = useRef(value)

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      Document,
      Paragraph,
      Text,
      HardBreak,
      UndoRedo,
      Placeholder.configure({ placeholder: () => latest.current.placeholder ?? '' }),
      MentionNode.extend({
        addAttributes() {
          return {
            ...this.parent?.(),
            kind: {
              default: 'teammate',
              parseHTML: (el) => el.getAttribute('data-kind'),
              renderHTML: (attrs) => ({ 'data-kind': attrs.kind }),
            },
          }
        },
        addNodeView() {
          return ReactNodeViewRenderer(MentionView, { as: 'span' })
        },
      }).configure({
        renderText: ({ node }) => formatMention(node.attrs as Mention),
        suggestion: {
          char: '@',
          items: ({ query }) => search(latest.current.options, query),
          render: renderMenu,
        },
      }),
      Extension.create({
        name: 'submit',
        addKeyboardShortcuts: () => ({
          'Mod-Enter': () => {
            latest.current.onSubmit?.()
            return true
          },
        }),
      }),
    ],
    content: toDoc(value),
    editorProps: {
      attributes: {
        // `composer-input` hooks the placeholder rule in globals.css (ProseMirror markup).
        class: cn(
          'composer-input max-h-[40vh] overflow-y-auto text-sm wrap-anywhere whitespace-pre-wrap outline-none [&[contenteditable=false]]:opacity-60',
          bare
            ? 'px-2 py-1.5 text-[0.9375rem]'
            : 'rounded-md border border-input bg-transparent px-3 py-2 shadow-xs transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30',
        ),
        role: 'textbox',
        'aria-multiline': 'true',
        ...(id ? { id } : {}),
        ...(placeholder ? { 'aria-label': placeholder } : {}),
        style: `min-height: ${rows * 1.5 + 1.25}em`,
      },
    },
    onUpdate: ({ editor }) => {
      text.current = editor.getText({ blockSeparator: '\n' })
      latest.current.onChange(text.current)
    },
  })

  // A value set from outside (cleared after sending, a draft) replaces the content.
  useEffect(() => {
    if (!editor || value === text.current) return
    text.current = value
    editor.commands.setContent(toDoc(value), { emitUpdate: false })
  }, [editor, value])

  useEffect(() => {
    editor?.setEditable(!disabled)
  }, [editor, disabled])

  // The placeholder reads `latest`; redraw when it changes.
  useEffect(() => {
    if (editor) editor.view.dispatch(editor.state.tr)
  }, [editor, placeholder])

  return (
    // `relative`: the mention menu docks here unless an ancestor is marked
    // `data-composer-frame` (a card around a bare composer).
    <div className="relative">
      <EditorContent editor={editor} />
      {name && <input type="hidden" name={name} value={value} />}
    </div>
  )
}
