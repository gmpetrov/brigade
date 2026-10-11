'use client'
// What a document's editor holds beyond text: files people upload or drop in,
// and `@` mentions of library files, teammates, threads. The schema matches
// the API's (@brigade/editor), which writes both to Markdown teammates read.
import { mentionConfig } from '@brigade/editor'
import { BlockNoteSchema, defaultInlineContentSpecs, type BlockNoteEditor } from '@blocknote/core'
import {
  createReactInlineContentSpec,
  SuggestionMenuController,
  useComponentsContext,
  useDictionary,
  type DefaultReactSuggestionItem,
  type SuggestionMenuProps,
} from '@blocknote/react'
import { BlockNoteView } from '@blocknote/shadcn'
import type { Mention } from '@brigade/contracts'
import { useTheme } from 'next-themes'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  MENTION_GROUPS,
  searchMentions,
  useMentionOptions,
  type MentionOption,
} from '@/components/composer'
import { libraryDocument, useOptionalDocumentPanel } from '@/components/document-panel'
import { MentionChip, MentionIcon } from '@/components/mention'
import { documentFileUrl, uploadDocumentAsset } from '@/lib/api'
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
    else if (mention.kind === 'repository')
      window.open(`https://github.com/${mention.id}`, '_blank', 'noopener')
  }
  return (
    <span
      role="link"
      tabIndex={-1}
      title={`Open ${mention.label}`}
      onClick={open}
      className="cursor-pointer rounded-md hover:bg-accent [&>*]:cursor-pointer"
    >
      <MentionChip mention={mention} />
    </span>
  )
}

const mentionSpec = createReactInlineContentSpec(mentionConfig, {
  render: ({ inlineContent }) => (
    <DocumentMention mention={inlineContent.props as unknown as Mention} />
  ),
})

/** The dashboard's side of @brigade/editor's documentSchema: the same nodes, its own chip. */
export const editorSchema = BlockNoteSchema.create({
  inlineContentSpecs: { ...defaultInlineContentSpecs, mention: mentionSpec },
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
}: {
  editor: DocumentBlockEditor
  documentId: string
  label: string
  onChange?: () => void
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

  const getItems = useCallback(
    async (query: string): Promise<MentionItem[]> =>
      searchMentions(latest.current, query).map((o) => ({
        key: `${o.kind}:${o.id}`,
        title: o.label,
        subtext: o.hint,
        group: MENTION_GROUPS.find((g) => g.kind === o.kind)?.title,
        icon: <MentionIcon kind={o.kind} connectionKind={o.connectionKind} />,
        onItemClick: () =>
          editor.insertInlineContent([
            { type: 'mention', props: { kind: o.kind, id: o.id, label: o.label } } as never,
            ' ',
          ]),
      })),
    [editor],
  )

  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes('Files')

  return (
    // Files dropped anywhere on the document land in it: onto the text where
    // they fall (BlockNote's own handling), elsewhere at the end.
    <div
      className={cn(
        'min-h-full rounded-lg transition-shadow',
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
        if (depth.current === 0) setDragging(false)
      }}
      onDragOver={(e) => {
        if (hasFiles(e)) e.preventDefault()
      }}
      onDrop={(e) => {
        depth.current = 0
        setDragging(false)
        if (!hasFiles(e) || e.defaultPrevented) return
        e.preventDefault()
        void appendFiles(editor, Array.from(e.dataTransfer.files))
      }}
    >
      <BlockNoteView
        editor={editor}
        theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
        aria-label={label}
        className="document-editor"
        onChange={onChange}
      >
        <SuggestionMenuController
          triggerCharacter="@"
          getItems={getItems}
          suggestionMenuComponent={MentionMenu}
        />
      </BlockNoteView>
    </div>
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
