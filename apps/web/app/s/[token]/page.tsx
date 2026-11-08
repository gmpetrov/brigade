'use client'
// A library file behind its public link (docs/public-links.md), for anyone with the address,
// signed in or not: a document as a page, a design in a frame from the sandbox origin, any other
// file shown as the library shows it, with a download. A thin bar above says what it is and who
// shares it. A link turned off, or a file gone, says only that.
import type { SharedFile } from '@brigade/contracts'
import { Download, FileText, Palette } from 'lucide-react'
import { useParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import { BrigadeMark } from '@/components/brigade-mark'
import { FilePreview } from '@/components/file-preview'
import { PublicMarkdown } from '@/components/public-markdown'
import { Button } from '@/components/ui/button'
import { API_URL } from '@/lib/config'

const HOME = 'https://www.brigade.lol'

type State = { file: SharedFile } | { missing: true } | { error: string } | null

export default function SharedPage() {
  const { token } = useParams<{ token: string }>()
  const [state, setState] = useState<State>(null)

  useEffect(() => {
    let current = true
    void (async () => {
      try {
        const response = await fetch(`${API_URL}/api/shared/${encodeURIComponent(token)}`, {
          cache: 'no-store',
        })
        if (!current) return
        if (response.status === 404) return setState({ missing: true })
        if (!response.ok) return setState({ error: `It could not be opened (${response.status})` })
        setState({ file: (await response.json()) as SharedFile })
      } catch {
        if (current) setState({ error: 'It could not be opened. Check your connection.' })
      }
    })()
    return () => {
      current = false
    }
  }, [token])

  const file = state && 'file' in state ? state.file : null
  useEffect(() => {
    if (file) document.title = `${file.name} · ${file.workspace}`
  }, [file])

  if (!state)
    return (
      <Shell>
        <p className="m-auto text-sm text-muted-foreground">Loading…</p>
      </Shell>
    )
  if (!file)
    return (
      <Shell>
        <div className="m-auto flex max-w-sm flex-col items-center gap-2 px-6 text-center">
          <p className="font-semibold">
            {'missing' in state ? 'This link is off or no longer exists' : 'Something went wrong'}
          </p>
          <p className="text-sm text-muted-foreground">
            {'missing' in state
              ? 'Ask whoever shared it for a new one.'
              : 'error' in state && state.error}
          </p>
        </div>
      </Shell>
    )

  const Icon = file.kind === 'design' ? Palette : FileText
  return (
    <Shell
      bar={
        <>
          <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-1 flex-col">
            <strong className="truncate text-sm font-semibold">{file.name}</strong>
            <span className="truncate text-xs text-muted-foreground">
              Shared by {file.workspace}
            </span>
          </div>
          {file.contentUrl && (
            <Button asChild variant="ghost" size="sm">
              <a href={`${file.contentUrl}?download`}>
                <Download aria-hidden />
                <span className="max-sm:hidden">Download</span>
              </a>
            </Button>
          )}
        </>
      }
    >
      {file.kind === 'design' && file.url ? (
        <iframe
          src={file.url}
          title={file.name}
          // The page's own rules (its CSP) sandbox it too: no cookies, no forms, no calls out.
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals"
          referrerPolicy="no-referrer"
          className="min-h-0 w-full flex-1 border-0 bg-white"
        />
      ) : file.kind === 'document' && file.markdown !== undefined ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <article className="mx-auto w-full max-w-3xl px-6 py-10 sm:px-10 sm:py-14">
            <PublicMarkdown text={file.markdown} />
          </article>
        </div>
      ) : file.contentUrl ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-5xl">
            <FilePreview
              url={file.contentUrl}
              {...(file.previewPath && { previewUrl: file.previewPath })}
              name={file.name}
              contentType={file.contentType}
              download={`${file.contentUrl}?download`}
            />
          </div>
        </div>
      ) : null}
    </Shell>
  )
}

/** The page: the bar (what it is, Brigade's name), then the file, filling the window. */
function Shell({ bar, children }: { bar?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex shrink-0 flex-nowrap items-center gap-2 border-b px-3 py-2.5">
        {bar ?? <span className="flex-1" />}
        <a
          href={`${HOME}/?ref=shared-link`}
          target="_blank"
          rel="noopener"
          className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <BrigadeMark className="size-4" />
          <span className="max-sm:hidden">Made with Brigade</span>
        </a>
      </header>
      {children}
    </div>
  )
}
