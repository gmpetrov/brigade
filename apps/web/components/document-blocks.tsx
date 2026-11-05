'use client'
// What a document's editor holds beyond text: files people upload or drop in,
// and `@` mentions of library files, teammates, threads. The schema matches
// the API's (@brigade/editor), which writes both to Markdown teammates read.
import { itemConfig, mentionConfig } from '@brigade/editor'
import { BlockNoteSchema, defaultInlineContentSpecs, type BlockNoteEditor } from '@blocknote/core'
import {
  AddBlockButton,
  createReactInlineContentSpec,
  DragHandleButton,
  FormattingToolbar,
  FormattingToolbarController,
  getFormattingToolbarItems,
  SideMenu,
  SideMenuController,
  SuggestionMenuController,
  useBlockNoteEditor,
  useComponentsContext,
  useDictionary,
  useSelectedBlocks,
  type DefaultReactSuggestionItem,
  type SideMenuProps,
  type SuggestionMenuProps,
} from '@blocknote/react'
import { BlockNoteView } from '@blocknote/shadcn'
import { isLegacyProjectMention, type Mention } from '@brigade/contracts'
import { ListChecks, MessageSquare } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useRouter } from 'next/navigation'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { findThreads, useMentionOptions } from '@/components/composer'
import type { DocumentAsk } from '@/components/document-editor'
import { libraryDocument, useOptionalDocumentPanel } from '@/components/document-panel'
import { ItemChips, ListItemsProvider, pickLines } from '@/components/list-items'
import { MentionChip, MentionIcon } from '@/components/mention'
import { Hint } from '@/components/ui/tooltip'
import { documentFileUrl, uploadDocumentAsset } from '@/lib/api'
import {
  foundFor,
  MENTION_GROUPS,
  searchesThreads,
  searchMentions,
  THREAD_SEARCH_DELAY,
  withFoundThreads,
  type FoundThreads,
  type MentionOption,
} from '@/lib/mention-search'
import { cn } from '@/lib/utils'

/** A mention in a document: a chip that opens what it names. */
function DocumentMention({ mention }: { mention: Mention }) {
  const router = useRouter()
  const documents = useOptionalDocumentPanel()
  const open = () => {
    if (mention.kind === 'document' && documents)
      documents.open(libraryDocument({ id: mention.id, path: mention.label }))
    else if (mention.kind === 'teammate') router.push(`/app/teammates/${mention.id}`)
    else if (mention.kind === 'thread') router.push(`/app/threads/${mention.id}`)
    else if (mention.kind === 'connection') router.push('/app/connections')
    else if (mention.kind === 'project' && !isLegacyProjectMention(mention))
      router.push(`/app/projects/${mention.id}`)
    else if (mention.kind === 'repository' || mention.kind === 'project')
      window.open(`https://github.com/${mention.id}`, '_blank', 'noopener')
  }
  return (
    <Hint label={`Open ${mention.label}`}>
      <span
        role="link"
        tabIndex={-1}
        onClick={open}
        className="cursor-pointer rounded-md hover:bg-accent [&>*]:cursor-pointer"
      >
        <MentionChip mention={mention} />
      </span>
    </Hint>
  )
}

const mentionSpec = createReactInlineContentSpec(mentionConfig, {
  render: ({ inlineContent }) => (
    <DocumentMention mention={inlineContent.props as unknown as Mention} />
  ),
})

/** A list item's marker (docs/lists.md): the line's threads and pull requests. */
const itemSpec = createReactInlineContentSpec(itemConfig, {
  render: ({ inlineContent }) => <ItemChips id={String(inlineContent.props.id)} />,
})

/** The dashboard's side of @brigade/editor's documentSchema: the same nodes, its own chips. */
export const editorSchema = BlockNoteSchema.create({
  inlineContentSpecs: { ...defaultInlineContentSpecs, mention: mentionSpec, item: itemSpec },
})

/**
 * Where the editor puts files: uploaded to the document (dropped, pasted or
 * picked), and read back through the API.
 */
export function editorFiles(
  documentId: string,
  /** The editor, once created: a failed upload's block is taken out of it. */
  self: { current?: DocumentBlockEditor | null },
) {
  return {
    uploadFile: async (file: File, blockId?: string) => {
      try {
        const asset = await uploadDocumentAsset(documentId, file)
        // An object is the block's update, not its props.
        return { props: { url: asset.url, name: asset.name } }
      } catch (error) {
        // Too large, or storage unreachable: say so, whichever way the file came in,
        // and leave no block waiting for it.
        window.alert(`${file.name} was not added: ${(error as Error).message}`)
        const editor = self.current
        if (blockId && editor?.getBlock(blockId)) editor.removeBlocks([blockId])
        throw error
      }
    },
    resolveFileUrl: async (url: string) => documentFileUrl(url),
  }
}

/** What a document may mention: not secrets or computers, and not itself. */
const MENTIONABLE = new Set(['document', 'teammate', 'thread', 'connection', 'repository'])

export type DocumentBlockEditor = BlockNoteEditor<
  typeof editorSchema.blockSchema,
  typeof editorSchema.inlineContentSchema,
  typeof editorSchema.styleSchema
>

/** The editor, themed like the dashboard, with `@` to mention. */
export function DocumentBlockNoteView({
  editor,
  documentId,
  label,
  onChange,
  ask,
  list = false,
  readOnly = false,
}: {
  editor: DocumentBlockEditor
  documentId: string
  label: string
  onChange?: () => void
  ask?: DocumentAsk
  /** A library file: its checklist lines show their threads and pull requests (docs/lists.md). */
  list?: boolean
  /** To read, not edit (a viewer's). */
  readOnly?: boolean
}) {
  const { resolvedTheme } = useTheme()
  const options = useMentionOptions()
  // The menu reads the latest options without re-registering.
  const latest = useRef<MentionOption[]>([])
  const mentionable = useMemo(
    () => options.filter((o) => MENTIONABLE.has(o.kind) && o.id !== documentId),
    [options, documentId],
  )
  useEffect(() => {
    latest.current = mentionable
  }, [mentionable])

  // The threads the workspace search found for what follows `@`: the options hold the latest only.
  const [found, setFound] = useState<FoundThreads>()
  const pause = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(pause.current), [])

  const getItems = useCallback(
    async (query: string): Promise<MentionItem[]> => {
      const matched = searchMentions(latest.current, query)
      let threads: MentionOption[] = []
      if (foundFor(found, query)) threads = found.threads
      else if (searchesThreads(query)) {
        clearTimeout(pause.current)
        if (matched.length)
          // Once typing pauses. Its answer changes `found`, and so this function: BlockNote asks
          // again, and the threads found come below the rows it shows, which keep their place
          // (BlockNote keeps the selected row by its index).
          pause.current = setTimeout(
            () => void findThreads(query).then(setFound, () => {}),
            THREAD_SEARCH_DELAY,
          )
        else {
          // Nothing to show meanwhile: wait for it, as BlockNote closes a menu that stays empty.
          const answer = await findThreads(query).catch(() => undefined)
          if (answer) {
            setFound(answer)
            threads = answer.threads
          }
        }
      }
      return withFoundThreads(matched, threads, query).map((o) => ({
        key: `${o.kind}:${o.id}`,
        title: o.label,
        subtext: o.hint,
        group: MENTION_GROUPS.find((g) => g.kind === o.kind)?.title,
        icon: <MentionIcon kind={o.kind} id={o.id} connectionKind={o.connectionKind} />,
        onItemClick: () =>
          editor.insertInlineContent([
            { type: 'mention', props: { kind: o.kind, id: o.id, label: o.label } } as never,
            ' ',
          ]),
      }))
    },
    [editor, found],
  )

  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes('Files')
  // The checklist line files are dragged over, which they go under when dropped (docs/lists.md).
  const box = useRef<HTMLDivElement>(null)
  const [target, setTarget] = useState<{
    id: string
    moved: Block[]
    top: number
    left: number
    width: number
    height: number
  } | null>(null)
  const lineUnder = (e: React.DragEvent) => {
    // Files from the computer, or the document's own files moved by their handle.
    const moved = hasFiles(e) ? [] : movedFileBlocks(editor)
    const line = !readOnly && (hasFiles(e) || moved.length) ? checklistLineAt(e.target) : null
    const outer = box.current?.getBoundingClientRect()
    // Not onto one of the blocks moved, nor the line they are already the only files of.
    if (!line || !outer || moved.some((b) => b.id === line.id)) return null
    const rect = line.element.getBoundingClientRect()
    return {
      id: line.id,
      moved,
      top: rect.top - outer.top,
      left: rect.left - outer.left,
      width: rect.width,
      height: rect.height,
    }
  }

  return (
    // Files dropped anywhere on the document land in it: onto a checklist line, under it (its
    // files, which go with it when it is handed over); onto the text elsewhere where they fall
    // (BlockNote's own handling); elsewhere at the end. The line takes them before the editor
    // sees the drop: BlockNote would put them beside it.
    // data-block-select: a drag started here, beside the lines, selects them whole
    // (document-block-select). data-keyboard: while it is edited, Escape is the editor's (it
    // selects the line), not the panel's around it.
    <div
      ref={box}
      data-block-select
      data-keyboard={readOnly ? undefined : ''}
      className={cn(
        'relative min-h-full rounded-lg transition-shadow',
        dragging && 'ring-2 ring-primary/60 ring-offset-2 ring-offset-card',
      )}
      onDragEnter={(e) => {
        if (!hasFiles(e)) return
        depth.current++
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) {
          setDragging(false)
          setTarget(null)
        }
      }}
      onDragOverCapture={(e) => {
        const line = lineUnder(e)
        setTarget((was) => (was?.id === line?.id && was?.top === line?.top ? was : line))
        if (!line) return
        // Not the editor's: its drop cursor between the lines would say they land beside it, so
        // it goes (as BlockNote hides it, with a dragleave of its own).
        e.preventDefault()
        e.stopPropagation()
        hideDropCursor(editor)
        e.dataTransfer.dropEffect = line.moved.length ? 'move' : 'copy'
      }}
      onDragOver={(e) => {
        if (hasFiles(e)) e.preventDefault()
      }}
      onDropCapture={(e) => {
        const line = lineUnder(e)
        setTarget(null)
        if (!line) return
        e.preventDefault()
        e.stopPropagation()
        hideDropCursor(editor)
        depth.current = 0
        setDragging(false)
        if (line.moved.length) moveUnder(editor, line.id, line.moved)
        else void attachFiles(editor, line.id, Array.from(e.dataTransfer.files))
      }}
      onPasteCapture={(e) => {
        // A file pasted alone (a screenshot) while the cursor is in a checklist line: under it.
        const types = Array.from(e.clipboardData.types)
        if (readOnly || !types.includes('Files') || types.some((t) => PASTED_TEXT.has(t))) return
        const block = editor.getTextCursorPosition().block
        if (block.type !== 'checkListItem') return
        e.preventDefault()
        e.stopPropagation()
        void attachFiles(editor, block.id, Array.from(e.clipboardData.files))
      }}
      onDrop={(e) => {
        depth.current = 0
        setDragging(false)
        setTarget(null)
        if (!hasFiles(e) || e.defaultPrevented) return
        e.preventDefault()
        void appendFiles(editor, Array.from(e.dataTransfer.files))
      }}
    >
      {target && (
        <div
          aria-hidden
          className="pointer-events-none absolute z-10 rounded bg-primary/14 ring-1 ring-primary/22"
          style={{ top: target.top, left: target.left, width: target.width, height: target.height }}
        >
          <span className="absolute top-full left-7 mt-1 rounded-lg border border-primary/55 bg-card px-2.5 py-1 text-[12.5px] whitespace-nowrap text-primary shadow-sm">
            Attach to this line
          </span>
        </div>
      )}
      <ListItemsProvider documentId={list ? documentId : null}>
        <BlockNoteView
          editor={editor}
          theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
          aria-label={label}
          className="document-editor"
          editable={!readOnly}
          onChange={onChange}
          // With Ask, BlockNote's toolbar with Ask first; else BlockNote's own.
          formattingToolbar={!ask}
          sideMenu={false}
        >
          <SideMenuController sideMenu={DocumentSideMenu} floatingUIOptions={SIDE_MENU_OPTIONS} />
          {ask && (
            <AskContext.Provider value={ask}>
              <FormattingToolbarController formattingToolbar={AskToolbar} />
            </AskContext.Provider>
          )}
          <SuggestionMenuController
            triggerCharacter="@"
            getItems={getItems}
            suggestionMenuComponent={MentionMenu}
          />
        </BlockNoteView>
      </ListItemsProvider>
    </div>
  )
}

/**
 * BlockNote's side menu, with the drag handle's menu opening on click. Its menu opens on
 * mousedown, so dragging a line opened it too, and it stayed open over the text, frozen
 * in place, for the whole drag: pressing the handle now leaves the menu to the click.
 */
function DocumentSideMenu(props: SideMenuProps) {
  return (
    <SideMenu {...props}>
      <AddBlockButton />
      <span className="contents" onPointerDownCapture={pressOnly} onMouseDownCapture={pressOnly}>
        <DragHandleButton {...props} />
      </span>
    </SideMenu>
  )
}

/**
 * The side menu centred on its block's first line, as measured. BlockNote shifts it down by
 * fixed amounts made for its own heading sizes, larger than ours (globals.css), which left the
 * handles below the headings they move.
 */
const SIDE_MENU_OPTIONS = {
  useFloatingOptions: {
    middleware: [
      {
        name: 'firstLine',
        fn: ({ y, elements, rects }: FirstLineState) => ({
          y: y + firstLineOffset(elements.reference, rects.floating.height),
        }),
      },
    ],
  },
}

type FirstLineState = {
  y: number
  elements: { reference: Element | { contextElement?: Element } }
  rects: { floating: { height: number } }
}

function firstLineOffset(reference: FirstLineState['elements']['reference'], height: number) {
  const block = reference instanceof Element ? reference : reference.contextElement
  // The block's own content comes before its sub-lines, so the first one is its own.
  const line = block?.querySelector('.bn-block-content')?.querySelector('.bn-inline-content')
  if (!block || !line) return 0
  const lineHeight = parseFloat(getComputedStyle(line).lineHeight)
  if (!lineHeight) return 0
  const top = line.getBoundingClientRect().top - block.getBoundingClientRect().top
  return top + lineHeight / 2 - height / 2
}

/** The press on the handle itself, not on its menu (portaled, yet inside in React's tree). */
function pressOnly(event: React.PointerEvent | React.MouseEvent) {
  if (event.button === 0 && event.currentTarget.contains(event.target as Node))
    event.stopPropagation()
}

const AskContext = createContext<DocumentAsk | undefined>(undefined)

/**
 * BlockNote's toolbar with Ask first. One component for good, with Ask from context: a
 * component made at each render would be a new one each time, and the toolbar would be
 * mounted again under the pointer (as a collaborator's cursor moves), losing the click.
 */
function AskToolbar() {
  const ask = useContext(AskContext)
  return (
    <FormattingToolbar>
      {ask?.onHandOff && <HandOffButton key="hand-off" ask={ask} />}
      {ask && <AskButton key="ask" ask={ask} />}
      {getFormattingToolbarItems()}
    </FormattingToolbar>
  )
}

/** First in the toolbar over selected text: the passage, quoted, to a teammate's reply box. */
function AskButton({ ask }: { ask: DocumentAsk }) {
  const Components = useComponentsContext()!
  const editor = useBlockNoteEditor()
  return (
    <>
      <Components.FormattingToolbar.Button
        className="bn-button document-ask"
        mainTooltip={`Ask ${ask.teammate} about this passage`}
        icon={<MessageSquare aria-hidden className="size-4" />}
        label={`Ask ${ask.teammate}`}
        onClick={() => void ask.onAsk(editor.getSelectedText())}
      >
        Ask {ask.teammate}
      </Components.FormattingToolbar.Button>
      <span aria-hidden className="mx-0.5 h-5 w-px self-center bg-border" />
    </>
  )
}

/**
 * First in the toolbar over checklist lines (docs/lists.md): hand them to a teammate, who
 * works on them in a thread and ticks them as the work lands.
 */
function HandOffButton({ ask }: { ask: DocumentAsk }) {
  const Components = useComponentsContext()!
  const editor = useBlockNoteEditor()
  const blocks = useSelectedBlocks(editor)
  const picked = useMemo(() => pickLines(editor as never, blocks as never), [editor, blocks])
  if (!picked) return null
  const count = picked.lines.length
  return (
    <Components.FormattingToolbar.Button
      className="bn-button document-hand-off"
      mainTooltip={`Hand ${count === 1 ? 'this item' : `these ${count} items`} to a teammate`}
      icon={<ListChecks aria-hidden className="size-4" />}
      label={`Hand to ${ask.teammate}`}
      onClick={() => ask.onHandOff?.(picked)}
    >
      Hand to {ask.teammate}
    </Components.FormattingToolbar.Button>
  )
}

/** A row of the `@` menu. Titles repeat (two threads of the same name): the key is what it names. */
type MentionItem = DefaultReactSuggestionItem & { key: string }

/**
 * BlockNote's own menu, keyed by what each row names rather than its title,
 * in BlockNote's themed parts so it looks the same.
 */
function MentionMenu({
  items,
  loadingState,
  selectedIndex,
  onItemClick,
}: SuggestionMenuProps<MentionItem>) {
  const Components = useComponentsContext()!
  const dict = useDictionary()
  const rows: React.ReactNode[] = []
  let group: string | undefined
  items.forEach((item, i) => {
    if (item.group !== group) {
      group = item.group
      rows.push(
        <Components.SuggestionMenu.Label
          className="bn-suggestion-menu-label"
          key={`group:${group}`}
        >
          {group}
        </Components.SuggestionMenu.Label>,
      )
    }
    rows.push(
      <Components.SuggestionMenu.Item
        className="bn-suggestion-menu-item"
        item={item}
        id={`bn-suggestion-menu-item-${i}`}
        isSelected={i === selectedIndex}
        key={item.key}
        onClick={() => onItemClick?.(item)}
      />,
    )
  })
  return (
    <Components.SuggestionMenu.Root id="bn-suggestion-menu" className="bn-suggestion-menu">
      {rows}
      {items.length === 0 && loadingState !== 'loading-initial' && (
        <Components.SuggestionMenu.EmptyItem className="bn-suggestion-menu-item">
          {dict.suggestion_menu.no_items_title}
        </Components.SuggestionMenu.EmptyItem>
      )}
      {loadingState !== 'loaded' && (
        <Components.SuggestionMenu.Loader className="bn-suggestion-menu-loader" />
      )}
    </Components.SuggestionMenu.Root>
  )
}

const blockFor = (file: File) =>
  file.type.startsWith('image/')
    ? 'image'
    : file.type.startsWith('video/')
      ? 'video'
      : file.type.startsWith('audio/')
        ? 'audio'
        : 'file'

/** What a clipboard holds besides files that BlockNote pastes instead of them. */
const PASTED_TEXT = new Set([
  'blocknote/html',
  'text/html',
  'text/markdown',
  'text/plain',
  'vscode-editor-data',
])

const FILE_BLOCKS = new Set(['image', 'video', 'audio', 'file'])

/** The checklist line an element is in: its own row, not what is nested under it. */
function checklistLineAt(target: EventTarget | null) {
  if (!(target instanceof Element)) return null
  const element = target.closest('.bn-block-content[data-content-type="checkListItem"]')
  const id = element?.closest('[data-id]')?.getAttribute('data-id')
  return element && id ? { element, id } : null
}

/**
 * Files dropped or pasted on a checklist line: under it, after the files it has and before the
 * lines nested under it, where its Markdown writes them (docs/lists.md). Each block is filled in
 * as its upload lands.
 */
async function attachFiles(editor: DocumentBlockEditor, lineId: string, files: File[]) {
  for (const file of files) {
    if (!editor.uploadFile) return
    const added = placeUnder(editor, lineId, { type: blockFor(file), props: { name: file.name } })
    if (!added) continue
    try {
      const update = await editor.uploadFile(file, added.id)
      editor.updateBlock(
        added,
        (typeof update === 'string' ? { props: { url: update } } : update) as never,
      )
    } catch {
      // An empty block would only mislead (uploadFile said why).
      editor.removeBlocks([added])
    }
  }
}

/** The editor's drop cursor gone: the drag is not the editor's to drop. */
function hideDropCursor(editor: DocumentBlockEditor) {
  editor.prosemirrorView?.dom.dispatchEvent(new Event('dragleave', { bubbles: false }))
}

/** A block put under a checklist line, after the files it has and before its nested lines. */
function placeUnder(editor: DocumentBlockEditor, lineId: string, block: object) {
  const line = editor.getBlock(lineId)
  if (!line) return undefined
  const under = line.children
  let after = 0
  while (after < under.length && FILE_BLOCKS.has(under[after]!.type)) after++
  return after > 0
    ? editor.insertBlocks([block as never], under[after - 1]!, 'after')[0]
    : under.length
      ? editor.insertBlocks([block as never], under[0]!, 'before')[0]
      : editor.updateBlock(line, { children: [block as never] }).children[0]
}

type Block = DocumentBlockEditor['document'][number]

/**
 * The document's own files being moved by their handle (the editor's drag, `view.dragging`):
 * the blocks dragged, when each is a file with nothing nested under it; else none.
 */
function movedFileBlocks(editor: DocumentBlockEditor): Block[] {
  const slice = editor.prosemirrorView?.dragging?.slice
  if (!slice) return []
  const ids: string[] = []
  slice.content.descendants((node) => {
    if (node.type.name !== 'blockContainer') return true
    if (typeof node.attrs.id === 'string') ids.push(node.attrs.id)
    return false
  })
  const blocks = ids.map((id) => editor.getBlock(id))
  return blocks.length &&
    blocks.every((b) => b && FILE_BLOCKS.has(b.type) && b.children.length === 0)
    ? (blocks as Block[])
    : []
}

/**
 * The document's files moved onto a checklist line: under it, as its files (docs/lists.md),
 * in one change, so that undo puts them back.
 */
function moveUnder(editor: DocumentBlockEditor, lineId: string, blocks: Block[]) {
  editor.transact(() => {
    editor.removeBlocks(blocks.map((b) => b.id))
    for (const { id, type, props } of blocks) placeUnder(editor, lineId, { id, type, props })
  })
}

/** Files dropped beside the text: a block for each at the end, filled in as each upload lands. */
async function appendFiles(editor: DocumentBlockEditor, files: File[]) {
  for (const file of files) {
    const last = editor.document.at(-1)
    if (!last || !editor.uploadFile) return
    const [block] = editor.insertBlocks(
      [{ type: blockFor(file), props: { name: file.name } } as never],
      last,
      'after',
    )
    if (!block) continue
    try {
      const update = await editor.uploadFile(file, block.id)
      editor.updateBlock(
        block,
        (typeof update === 'string' ? { props: { url: update } } : update) as never,
      )
    } catch {
      // An empty block would only mislead (uploadFile said why).
      editor.removeBlocks([block])
    }
  }
}
