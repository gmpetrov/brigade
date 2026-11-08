'use client'
// A library file that is text but not Markdown (CSV, JSON, HTML, code…), in the file panel:
// read as it is, edited in place and saved whole (PUT /library/:id/text). A table or a page
// shows as the library previews it until Edit. Markdown opens in the document editor instead.
import type { LibraryFile } from '@brigade/contracts'
import { useEffect, useState } from 'react'
import { FilePreview } from '@/components/file-preview'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { contentUrl } from '@/lib/library-urls'

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** A plain text file (not Markdown, which opens in the editor), read and edited in place. */
export function TextFile({
  file,
  onSaved,
}: {
  file: Pick<LibraryFile, 'id' | 'path' | 'contentType' | 'updatedAt'>
  onSaved?: () => unknown
}) {
  const [text, setText] = useState<string>()
  const [draft, setDraft] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch(contentUrl(file.id), { credentials: 'include', cache: 'no-store' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.statusText))))
      .then(setText, (e: Error) => setError(e.message))
  }, [file.id, file.updatedAt])

  async function save() {
    setBusy(true)
    setError(undefined)
    try {
      await api(`/library/${file.id}/text`, { method: 'PUT', body: { text: draft } })
      setText(draft)
      setDraft(undefined)
      await onSaved?.()
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }

  if (text === undefined)
    return <p className="p-4 text-sm text-muted-foreground">{error ?? 'Loading…'}</p>
  if (draft === undefined && /^text\/(csv|tab-separated-values|html)$/.test(file.contentType))
    return (
      <div className="flex flex-col">
        <div className="flex justify-end border-b px-4 py-2">
          <Button size="sm" variant="outline" onClick={() => setDraft(text)}>
            Edit
          </Button>
        </div>
        <FilePreview
          key={file.updatedAt}
          url={contentUrl(file.id)}
          name={nameOf(file.path)}
          contentType={file.contentType}
        />
      </div>
    )
  return (
    <div className="flex flex-col gap-3 p-4">
      {draft === undefined ? (
        <pre className="font-mono text-xs whitespace-pre-wrap wrap-anywhere">{text}</pre>
      ) : (
        <Textarea
          aria-label={`Contents of ${file.path}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={Math.min(30, Math.max(8, draft.split('\n').length + 1))}
          className="bg-card font-mono text-sm"
        />
      )}
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      <div className="flex justify-end gap-2">
        {draft === undefined ? (
          <Button size="sm" onClick={() => setDraft(text)}>
            Edit
          </Button>
        ) : (
          <>
            <Button variant="outline" size="sm" onClick={() => setDraft(undefined)}>
              Cancel
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void save()}>
              Save
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
