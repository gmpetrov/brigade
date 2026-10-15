'use client'
import {
  designFolderOf,
  formatMention,
  MESSAGE_COMMANDS,
  messageCommand,
  type DesignSystem,
  parseMentions,
  type Mention,
  type MentionKind,
  type MessageCommand,
} from '@brigade/contracts'
import { Extension, Node, type JSONContent } from '@tiptap/core'
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
import { PluginKey } from '@tiptap/pm/state'
import { Suggestion, type SuggestionProps } from '@tiptap/suggestion'
import { ImageIcon, Palette, Shapes } from 'lucide-react'
import { useEffect, useMemo, useRef, type ComponentType } from 'react'
import { useDashboard } from '@/components/dashboard'
import { credentialHint, MentionChip, MentionIcon, type ConnectionKind } from '@/components/mention'
import {
  computerName,
  useApi,
  type Account,
  type ComputersResponse,
  type ConnectionsResponse,
  type Credential,
  type LibraryFile,
  type RepositoryOption,
  type ThreadSummary,
} from '@/lib/api'
import { cn } from '@/lib/utils'

/** Something to mention, with what the menu shows beside it. */
export type MentionOption = Mention & { hint?: string; connectionKind?: ConnectionKind }
type Option = MentionOption

export const MENTION_GROUPS: { kind: MentionKind; title: string; max: number }[] = [
  { kind: 'teammate', title: 'Teammates', max: 5 },
  { kind: 'project', title: 'Projects', max: 5 },
  { kind: 'connection', title: 'Connections', max: 5 },
  { kind: 'repository', title: 'Repositories', max: 5 },
  { kind: 'design-system', title: 'Design systems', max: 5 },
  { kind: 'design', title: 'Designs', max: 5 },
  { kind: 'document', title: 'Library', max: 5 },
  { kind: 'credential', title: 'Secrets', max: 5 },
  { kind: 'thread', title: 'Threads', max: 4 },
  { kind: 'computer', title: 'Computers', max: 3 },
]

/** Everything in the workspace a message can mention. */
export function useMentionOptions(threadId?: string): Option[] {
  const { teammates, projects } = useDashboard()
  const connections = useApi<ConnectionsResponse>('/connections')
  const threads = useApi<ThreadSummary[]>('/threads')
  const computers = useApi<ComputersResponse>('/computers')
  const credentials = useApi<Credential[]>('/credentials')
  const repositories = useApi<RepositoryOption[]>('/repositories')
  const library = useApi<LibraryFile[]>('/library')
  const designSystems = useApi<DesignSystem[]>('/design-systems')
  return useMemo(
    () => [
      ...teammates.map((t) => ({
        kind: 'teammate' as const,
        id: t.id,
        label: t.name,
        hint: 'AI teammate',
      })),
      ...projects
        .filter((p) => !p.archivedAt)
        .map((p) => ({ kind: 'project' as const, id: p.id, label: p.name, hint: 'Project' })),
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
      ...(repositories.data ?? []).map((r) => ({
        kind: 'repository' as const,
        id: r.repository,
        label: r.repository,
        hint: r.private ? 'GitHub, private' : 'GitHub',
      })),
      ...(designSystems.data ?? []).map((s) => ({
        kind: 'design-system' as const,
        id: s.path,
        label: s.name,
        hint: s.isDefault ? 'Design system, default' : 'Design system',
      })),
      // A design is one thing to mention: its folder, not its files.
      ...[...new Set((library.data ?? []).flatMap((f) => designFolderOf(f.path) ?? []))].map(
        (folder) => ({
          kind: 'design' as const,
          id: folder,
          label: folder,
          hint: 'Design',
        }),
      ),
      ...(library.data ?? [])
        .filter((f) => !designFolderOf(f.path))
        .map((f) => ({
          kind: 'document' as const,
          id: f.id,
          label: f.path,
          hint: 'Library',
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
    [
      teammates,
      projects,
      connections.data,
      repositories.data,
      library.data,
      designSystems.data,
      credentials.data,
      threads.data,
      computers.data,
      threadId,
    ],
  )
}

/** Matches for a query, grouped by kind; names that start with it first. */
export function searchMentions(options: Option[], query: string) {
  const q = query.trim().toLowerCase()
  return MENTION_GROUPS.flatMap((g) =>
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

type MenuProps<T = Option> = {
  items: T[]
  selected: number
  query: string
  onPick: (option: T) => void
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
              {MENTION_GROUPS.find((g) => g.kind === o.kind)?.title}
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

/** Editors whose `@` or `/` menu is open with something to pick: Enter picks rather than sends. */
const picking = new WeakSet<object>()

/** A suggestion menu (`@`, `/`): arrows move, Enter or Tab picks, Escape closes. */
function renderMenu<T, P extends object>(
  Menu: ComponentType<MenuProps<T>>,
  pick: (props: SuggestionProps<T, P>, item: T) => void,
) {
  let component: ReactRenderer<unknown, MenuProps<T>> | undefined
  let unmount: (() => void) | undefined
  let current: SuggestionProps<T, P>
  let selected = 0
  const menuProps = (): MenuProps<T> => ({
    items: current.items,
    selected,
    query: current.query,
    onPick: (item) => pick(current, item),
    onHover: (index) => {
      selected = index
      component?.updateProps(menuProps())
    },
  })
  return {
    onStart(props: SuggestionProps<T, P>) {
      current = props
      selected = 0
      if (props.items.length) picking.add(props.editor)
      component = new ReactRenderer(Menu, { props: menuProps(), editor: props.editor })
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
    onUpdate(props: SuggestionProps<T, P>) {
      current = props
      selected = 0
      if (props.items.length) picking.add(props.editor)
      else picking.delete(props.editor)
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
      if (current) picking.delete(current.editor)
      unmount?.()
      component?.destroy()
      component = undefined
    },
  }
}

// -- Commands: `/design`, `/visual` at the start of a message ------------------

const COMMAND_ICON: Record<MessageCommand, ComponentType<{ className?: string }>> = {
  visual: Shapes,
  design: Palette,
  image: ImageIcon,
}
type CommandOption = {
  name: MessageCommand
  label: string
  description: string
  needs?: 'codex'
}
const COMMAND_OPTIONS: CommandOption[] = Object.entries(MESSAGE_COMMANDS).map(([name, c]) => ({
  name: name as MessageCommand,
  label: c.label,
  description: c.description,
  ...('needs' in c ? { needs: c.needs } : {}),
}))

/** The commands this member can use: `/image` needs a Codex account of theirs. */
function useCommandOptions(): CommandOption[] {
  const accounts = useApi<Account[]>('/accounts')
  const codex = (accounts.data ?? []).some(
    (a) => a.provider === 'codex' && (a.status === 'ready' || a.status === 'unverified'),
  )
  return useMemo(() => COMMAND_OPTIONS.filter((c) => !c.needs || codex), [codex])
}

/** A command as the composer and the thread show it. */
export function CommandChip({
  command,
  className,
}: {
  command: MessageCommand
  className?: string
}) {
  const Icon = COMMAND_ICON[command]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md bg-primary/12 px-1.5 py-0.5 align-baseline text-[0.8125rem] leading-none font-medium text-primary',
        className,
      )}
    >
      <Icon aria-hidden className="size-3.5" />
      {MESSAGE_COMMANDS[command].label}
    </span>
  )
}

function CommandMenu({ items, selected, query, onPick, onHover }: MenuProps<CommandOption>) {
  if (!items.length)
    return (
      <div className={menuClass}>
        <p className="px-2 py-1.5 text-sm text-muted-foreground">No command “/{query}”</p>
      </div>
    )
  return (
    <div className={menuClass} role="listbox">
      <div className="px-2 pt-2 pb-0.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        Make
      </div>
      {items.map((o, i) => {
        const Icon = COMMAND_ICON[o.name]
        return (
          <button
            key={o.name}
            type="button"
            role="option"
            aria-selected={i === selected}
            className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm aria-selected:bg-primary/15 aria-selected:shadow-[inset_2px_0_0_var(--primary)]"
            onMouseDown={(e) => {
              e.preventDefault()
              onPick(o)
            }}
            onMouseMove={() => i !== selected && onHover(i)}
          >
            <Icon
              aria-hidden
              className="size-4 text-muted-foreground group-aria-selected:text-primary"
            />
            <span className="font-medium">/{o.name}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {o.description}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function CommandView({ node, selected }: ReactNodeViewProps) {
  return (
    <NodeViewWrapper as="span">
      <CommandChip
        command={node.attrs.name as MessageCommand}
        className={selected ? 'outline-2 outline-offset-1 outline-primary' : undefined}
      />
    </NodeViewWrapper>
  )
}

/** The command a message starts with, as one piece: it reads `/design` in the text. */
const CommandNode = Node.create({
  name: 'command',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({ name: { default: 'design' } }),
  parseHTML: () => [{ tag: 'span[data-command]' }],
  renderHTML: ({ node }) => ['span', { 'data-command': node.attrs.name }, `/${node.attrs.name}`],
  renderText: ({ node }) => `/${node.attrs.name}`,
  addNodeView() {
    return ReactNodeViewRenderer(CommandView, { as: 'span' })
  },
})

/** `/` at the very start of a message opens the commands. */
const Commands = Extension.create<{ options: () => CommandOption[] }>({
  name: 'messageCommands',
  addOptions: () => ({ options: () => COMMAND_OPTIONS }),
  addProseMirrorPlugins() {
    const { options } = this.options
    return [
      Suggestion<CommandOption, CommandOption>({
        editor: this.editor,
        pluginKey: new PluginKey('messageCommands'),
        char: '/',
        startOfLine: true,
        // Only first in the message, and once.
        allow: ({ state, range }) => {
          if (range.from !== 1) return false
          let has = false
          state.doc.descendants((n) => {
            if (n.type.name === 'command') has = true
            return !has
          })
          return !has
        },
        items: ({ query }) => options().filter((c) => c.name.startsWith(query.toLowerCase())),
        command: ({ editor, range, props }) => {
          editor
            .chain()
            .focus()
            .insertContentAt(range, [
              { type: 'command', attrs: { name: props.name } },
              { type: 'text', text: ' ' },
            ])
            .run()
        },
        render: () =>
          renderMenu<CommandOption, CommandOption>(CommandMenu, (p, item) => p.command(item)),
      }),
    ]
  },
})

/** Message text, one paragraph per line, mentions (and a command it starts with) as nodes. */
function toDoc(text: string): JSONContent {
  const found = messageCommand(text)
  const body = found ? found.rest : text
  const lines = body.split('\n').map((line) => ({
    type: 'paragraph',
    content: parseMentions(line)
      .filter((part) => part !== '')
      .map((part): JSONContent =>
        typeof part === 'string'
          ? { type: 'text', text: part }
          : { type: 'mention', attrs: { ...part, mentionSuggestionChar: '@' } },
      ),
  }))
  if (found)
    lines[0]!.content = [
      { type: 'command', attrs: { name: found.command } },
      { type: 'text', text: ' ' },
      ...lines[0]!.content,
    ]
  return { type: 'doc', content: lines }
}

/** A phone or tablet: its keyboard's return key adds a line, and the button sends. */
const touchScreen = () =>
  typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches

/**
 * A message box where `@` mentions teammates, connections, repositories, library files,
 * credentials, threads and computers, and `/` first in it picks a command (what to make).
 * Its value is plain text; mentions are `@[Label](kind:id)` in it, a command `/name` first.
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
  autoFocus,
}: {
  value: string
  onChange: (text: string) => void
  /** Enter (Cmd/Ctrl+Enter too); Shift+Enter adds a line. On a touch screen Enter adds a line. */
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
  /** Focused at the end of its text once the editor is ready. */
  autoFocus?: boolean
}) {
  const options = useMentionOptions(threadId)
  const commands = useCommandOptions()
  // The editor is built once; these keep its callbacks current.
  const latest = useRef({ options, commands, onChange, onSubmit, placeholder })
  latest.current = { options, commands, onChange, onSubmit, placeholder }
  const text = useRef(value)

  const editor = useEditor({
    immediatelyRender: false,
    // The editor is built after mount, so a focus from outside can miss it; it focuses itself.
    autofocus: autoFocus ? 'end' : false,
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
          items: ({ query }) => searchMentions(latest.current.options, query),
          render: () =>
            renderMenu<Option, Mention>(MentionMenu, (p, { kind, id, label }) =>
              p.command({ kind, id, label }),
            ),
        },
      }),
      CommandNode,
      Commands.configure({ options: () => latest.current.commands }),
      Extension.create({
        name: 'submit',
        // Like Claude: Enter sends, Shift+Enter adds a line. Runs before HardBreak's own keys.
        priority: 1000,
        addKeyboardShortcuts() {
          const submit = () => {
            // An open `@` or `/` menu takes Enter to pick; an IME takes it to compose.
            if (picking.has(this.editor) || this.editor.view.composing) return false
            latest.current.onSubmit?.()
            return true
          }
          return {
            Enter: () => (touchScreen() ? false : submit()),
            'Mod-Enter': submit,
            'Shift-Enter': () => this.editor.commands.setHardBreak(),
          }
        },
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
