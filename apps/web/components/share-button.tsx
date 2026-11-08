'use client'
// A library file's public link (docs/public-links.md), from the bar of whatever shows the file:
// a document's panel, a file's, a design's. Off, the button is as quiet as History beside it; on,
// it turns into a globe and the bar's caption says "Public link", so anyone sees at a glance that
// the file can be read from outside. Its panel turns the link on and off and copies it.
import type { LibraryShare } from '@brigade/contracts'
import { Check, Copy, Globe, Share } from 'lucide-react'
import { Popover } from 'radix-ui'
import { useEffect, useState } from 'react'
import { useMaybeDashboard } from '@/components/dashboard'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Hint } from '@/components/ui/tooltip'
import { api, isViewer } from '@/lib/api'
import { DEMO } from '@/lib/demo/flag'
import { useLive } from '@/lib/use-live'
import { cn } from '@/lib/utils'

/**
 * A file's public link as the API says it: undefined while it is asked, null when it has none.
 * Asked again when the library changes, as another member may have turned it on or off.
 */
export function useShare(documentId: string | null | undefined) {
  const [share, setShare] = useState<LibraryShare | null | undefined>()
  const [asked, setAsked] = useState(0)
  useEffect(() => setShare(undefined), [documentId])
  useEffect(() => {
    if (!documentId || DEMO) return
    let current = true
    api<{ share: LibraryShare | null }>(`/library/${encodeURIComponent(documentId)}/share`)
      .then((r) => current && setShare(r.share))
      .catch(() => current && setShare((s) => s ?? null))
    return () => {
      current = false
    }
  }, [documentId, asked])
  useLive(
    (message) => message.type === 'library.updated' && setAsked((n) => n + 1),
    () => setAsked((n) => n + 1),
  )
  return { share, setShare }
}

/** What a bar says beside a file's folder while its link is on. */
export const PUBLIC_LINK = 'Public link'

export function ShareButton({
  documentId,
  name,
  share,
  setShare,
  label,
  onChange,
}: {
  documentId: string
  /** The file's or design's name, for the panel's title. */
  name: string
  share: LibraryShare | null | undefined
  setShare: (share: LibraryShare | null) => void
  /** Shows "Share" beside the icon, in a bar whose other buttons say what they do. */
  label?: boolean
  /** After the link was turned on or off, for lists that show which files have one. */
  onChange?: (shared: boolean) => void
}) {
  const dashboard = useMaybeDashboard()
  const viewer = dashboard ? isViewer(dashboard.me) : false
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [copied, setCopied] = useState(false)
  useEffect(() => setCopied(false), [open])
  if (DEMO || share === undefined) return null
  // A viewer only sees whether a file is shared, from the bar's caption.
  if (viewer && !share) return null

  async function toggle(on: boolean) {
    setBusy(true)
    setError(undefined)
    try {
      const path = `/library/${encodeURIComponent(documentId)}/share`
      const r = await api<{ share: LibraryShare | null }>(path, {
        method: on ? 'POST' : 'DELETE',
        ...(on && { body: {} }),
      })
      setShare(r.share)
      onChange?.(Boolean(r.share))
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }

  function copy() {
    if (!share) return
    void navigator.clipboard.writeText(share.url).then(() => setCopied(true))
  }

  const Icon = share ? Globe : Share
  const hint = share ? 'Public link: anyone with it can view' : 'Share'
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Hint label={hint}>
        <Popover.Trigger asChild>
          <Button
            type="button"
            variant={open ? 'secondary' : 'ghost'}
            size={label ? 'sm' : 'icon-sm'}
            aria-label={label ? undefined : hint}
            className={cn(share && 'text-primary hover:text-primary')}
          >
            <Icon aria-hidden />
            {label && (share ? 'Shared' : 'Share')}
          </Button>
        </Popover.Trigger>
      </Hint>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-50 flex w-80 max-w-[calc(100vw-1rem)] origin-(--radix-popover-content-transform-origin) flex-col gap-3 rounded-xl border bg-popover p-3.5 text-sm text-popover-foreground shadow-md data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <p className="truncate font-semibold">Share “{name}”</p>
          <label className="flex items-center gap-2.5">
            <Switch
              checked={Boolean(share)}
              disabled={busy || viewer}
              onCheckedChange={(on) => void toggle(on)}
            />
            Anyone with the link can view
          </label>
          {share && (
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={share.url.replace(/^https?:\/\//, '')}
                aria-label="Public link"
                onFocus={(e) => e.currentTarget.select()}
                className="h-8 min-w-0 flex-1 rounded-md border bg-muted px-2 font-mono text-xs"
              />
              <Button type="button" variant="outline" size="sm" onClick={copy}>
                {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          )}
          <p className="text-xs leading-relaxed text-muted-foreground">
            {share
              ? 'Read only, always the latest version. Discussions and the rest of the library stay private. Turn it off to stop sharing.'
              : 'Makes a link anyone can open without signing in.'}
          </p>
          {error && <p className="text-xs text-destructive-text">{error}</p>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
