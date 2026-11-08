'use client'
// A library file's public link (docs/public-links.md), from the bar of whatever shows the file:
// a document's panel, a file's, a design's. Off, the button is as quiet as History beside it; on,
// it turns into a globe and the bar's caption says "Public link", so anyone sees at a glance that
// the file can be read from outside. Its panel turns the link on and off and copies it.
import type { LibraryShare } from '@brigade/contracts'
import { Check, Copy, Globe, Share } from 'lucide-react'
import { Popover } from 'radix-ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useMaybeDashboard } from '@/components/dashboard'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Hint } from '@/components/ui/tooltip'
import { api, isViewer } from '@/lib/api'
import { DEMO } from '@/lib/demo/flag'
import { afterReply, shownShare, type ShareReply, type ShareState } from '@/lib/share-state'
import { useLive } from '@/lib/use-live'
import { cn } from '@/lib/utils'

/** Numbers each request about a link as it starts: a reply older than one applied is dropped. */
let requests = 0

/**
 * The public link of the file a bar shows (`documentId`): undefined while it is asked, null when
 * it has none, and `toggle` to turn it on or off. Asked again when the library changes, as
 * another member may have turned it on or off. A reply about another file than the one shown now
 * (the bar moved on to another tab meanwhile), or older than one applied, changes nothing
 * (lib/share-state.ts).
 */
export function useShare(documentId: string | null | undefined) {
  const [state, setState] = useState<ShareState>(null)
  const [asked, setAsked] = useState(0)
  const shown = useRef(documentId ?? null)
  useEffect(() => {
    shown.current = documentId ?? null
  }, [documentId])
  const apply = useCallback(
    (reply: ShareReply) => setState((s) => afterReply(s, shown.current, reply)),
    [],
  )
  useEffect(() => {
    if (!documentId || DEMO) return
    const seq = ++requests
    api<{ share: LibraryShare | null }>(`/library/${encodeURIComponent(documentId)}/share`)
      .then((r) => apply({ documentId, share: r.share, seq }))
      // Unreadable: shown as not shared, unless a reply already said otherwise.
      .catch(() =>
        setState((s) =>
          s?.documentId === documentId
            ? s
            : afterReply(s, shown.current, { documentId, share: null, seq }),
        ),
      )
  }, [documentId, asked, apply])
  useLive(
    (message) => message.type === 'library.updated' && setAsked((n) => n + 1),
    () => setAsked((n) => n + 1),
  )
  const toggle = useCallback(
    async (on: boolean) => {
      if (!documentId) return null
      const seq = ++requests
      const r = await api<{ share: LibraryShare | null }>(
        `/library/${encodeURIComponent(documentId)}/share`,
        { method: on ? 'POST' : 'DELETE', ...(on && { body: {} }) },
      )
      apply({ documentId, share: r.share, seq })
      return r.share
    },
    [documentId, apply],
  )
  return { share: shownShare(state, documentId), toggle }
}

export type ShareLink = ReturnType<typeof useShare>

/** What a bar says beside a file's folder while its link is on. */
export const PUBLIC_LINK = 'Public link'

/** The button and its panel. Keyed by the file's id where it shows, so a tab switch starts it afresh. */
export function ShareButton({
  name,
  link,
  label,
  onChange,
}: {
  /** The file's or design's name, for the panel's title. */
  name: string
  /** The file's link, from useShare. */
  link: ShareLink
  /** Shows "Share" beside the icon, in a bar whose other buttons say what they do. */
  label?: boolean
  /** After the link was turned on or off, for lists that show which files have one. */
  onChange?: (shared: boolean) => void
}) {
  const { share } = link
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
      onChange?.(Boolean(await link.toggle(on)))
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
