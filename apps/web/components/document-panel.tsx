'use client'
// Documents open in a panel beside whatever page is showing, the way an
// artifact opens beside a chat: from the library, a thread, search. One at a
// time; it stays open while you move between pages, and across a reload.
import type { EditTarget } from '@brigade/contracts'
import { BookOpen, FileText, History, X } from 'lucide-react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { DocumentEditor } from '@/components/document-editor'
import { FileHistory } from '@/components/library-history'
import { SidePanel } from '@/components/side-panel'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export type OpenDocument = {
  target: EditTarget
  /** "refunds.md", "Workspace memory". */
  title: string
  /** The folder, or what the document is for. */
  subtitle?: string
}

type DocumentPanel = {
  current: OpenDocument | null
  open: (document: OpenDocument) => void
  close: () => void
}

const Context = createContext<DocumentPanel | null>(null)
const OPEN_KEY = 'brigade:open-document'

export function useDocumentPanel() {
  const value = useContext(Context)
  if (!value) throw new Error('useDocumentPanel outside DocumentPanelProvider')
  return value
}

/** The panel, where there is one (the dashboard); null elsewhere. */
export const useOptionalDocumentPanel = () => useContext(Context)

/** A library file's panel title: its name, and its folder below. */
export function libraryDocument(file: { id: string; path: string }): OpenDocument {
  const slash = file.path.lastIndexOf('/')
  return {
    target: { kind: 'library', id: file.id },
    title: file.path.slice(slash + 1),
    ...(slash > 0 ? { subtitle: file.path.slice(0, slash) } : {}),
  }
}

export function DocumentPanelProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<OpenDocument | null>(null)

  // What was open before a reload, in this tab.
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(OPEN_KEY)
      if (saved) setCurrent(JSON.parse(saved) as OpenDocument)
    } catch {}
  }, [])

  const remember = (document: OpenDocument | null) => {
    try {
      if (document) sessionStorage.setItem(OPEN_KEY, JSON.stringify(document))
      else sessionStorage.removeItem(OPEN_KEY)
    } catch {}
  }
  const open = useCallback((document: OpenDocument) => {
    setCurrent(document)
    remember(document)
  }, [])
  const close = useCallback(() => {
    setCurrent(null)
    remember(null)
  }, [])

  const value = useMemo(() => ({ current, open, close }), [current, open, close])
  return <Context.Provider value={value}>{children}</Context.Provider>
}

/** The open document, beside the page. Rendered once, by the dashboard. */
export function DocumentPanel() {
  const { current, close } = useDocumentPanel()
  const [history, setHistory] = useState(false)
  // The editor again after a restore, with what was restored.
  const [opened, setOpened] = useState(0)
  const key = JSON.stringify(current?.target ?? null)
  useEffect(() => setHistory(false), [key])
  if (!current) return null
  const Icon = current.target.kind === 'library' ? FileText : BookOpen
  const target = current.target
  return (
    <SidePanel aria-label={current.title} onClose={close} raiseKey={current}>
      <div className="flex flex-nowrap items-center gap-2 border-b px-3 py-2.5">
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col">
          <strong className="truncate text-sm font-semibold">{current.title}</strong>
          {current.subtitle && (
            <span
              className={cn(
                'truncate text-xs text-muted-foreground',
                current.target.kind === 'library' && 'font-mono',
              )}
              title={current.subtitle}
            >
              {current.subtitle}
            </span>
          )}
        </div>
        {target.kind === 'library' && (
          <Button
            type="button"
            variant={history ? 'secondary' : 'ghost'}
            size="icon-sm"
            onClick={() => setHistory((h) => !h)}
            aria-pressed={history}
            aria-label="History"
            title="History"
          >
            <History aria-hidden />
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={close}
          aria-label="Close document"
          title="Close"
        >
          <X aria-hidden />
        </Button>
      </div>
      {history && target.kind === 'library' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <FileHistory
            file={{
              id: target.id,
              path: current.subtitle ? `${current.subtitle}/${current.title}` : current.title,
            }}
            onRestored={() => {
              setHistory(false)
              setOpened((n) => n + 1)
            }}
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-4">
          <DocumentEditor
            key={`${key}:${opened}`}
            target={current.target}
            label={current.title}
            className="min-h-full"
          />
        </div>
      )}
    </SidePanel>
  )
}
