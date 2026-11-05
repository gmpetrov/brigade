'use client'
// Share on Settings › Usage: the period's usage as an image to post, a GitHub-like grid of when
// the tokens went, drawn in the browser (nothing leaves it until the person posts it). Counts
// only, as on the page.
import type { UsageResponse } from '@brigade/contracts'
import { Check, Share } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cardText } from '@/lib/usage-card'
import { drawCard } from '@/lib/usage-card-image'

const canCopy = () =>
  typeof ClipboardItem !== 'undefined' &&
  typeof navigator !== 'undefined' &&
  !!navigator.clipboard?.write

/** The Share button of Settings › Usage, and the card it opens. */
export function UsageShare({ data }: { data: UsageResponse }) {
  const [open, setOpen] = useState(false)
  const [image, setImage] = useState<{ blob: Blob; url: string } | null>(null)
  const [failed, setFailed] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!open) return
    let url: string | undefined
    let gone = false
    setImage(null)
    setFailed(false)
    drawCard(data).then(
      (blob) => {
        if (gone) return
        url = URL.createObjectURL(blob)
        setImage({ blob, url })
      },
      () => !gone && setFailed(true),
    )
    return () => {
      gone = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [open, data])

  const copy = async () => {
    if (!image || !canCopy()) return false
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': image.blob })])
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
      return true
    } catch {
      return false
    }
  }
  const post = () => {
    // The copy starts while this page still has the focus; X opens beside it to paste it in.
    void copy()
    const intent = new URL('https://x.com/intent/tweet')
    intent.searchParams.set('text', cardText(data).post)
    intent.searchParams.set('url', 'https://www.brigade.lol')
    window.open(intent, '_blank', 'noopener')
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Share />
        Share
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Share your usage</DialogTitle>
            <DialogDescription>
              An image of when your tokens went, with only the counts.
              {canCopy() && ' Post on X copies it, to paste into your post.'}
            </DialogDescription>
          </DialogHeader>
          <div className="aspect-[1200/630] w-full overflow-hidden rounded-lg border bg-muted/40">
            {image ? (
              // A blob URL drawn here: next/image has nothing to optimize.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={image.url}
                alt={`${cardText(data).total}, ${cardText(data).title.toLowerCase()}`}
                className="size-full"
              />
            ) : (
              <p className="flex size-full items-center justify-center text-sm text-muted-foreground">
                {failed ? 'The image could not be drawn.' : 'Drawing…'}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" asChild disabled={!image}>
              <a href={image?.url} download={`brigade-usage-${data.days}d.png`}>
                Download
              </a>
            </Button>
            {canCopy() && (
              <Button variant="outline" disabled={!image} onClick={() => void copy()}>
                {copied && <Check />}
                {copied ? 'Copied' : 'Copy image'}
              </Button>
            )}
            <Button disabled={!image} onClick={post}>
              Post on X
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
