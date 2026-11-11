'use client'
// A received mail's words in the Inbox, two ways: its text made readable (paragraphs, the
// forwarded message's header block, links), the default; or its HTML as it was made, in a
// sandboxed frame (lib/mail-html.ts says what it lets through).
import { ChevronRight, ImageIcon } from 'lucide-react'
import { useTheme } from 'next-themes'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { cidOf, followHeight, type MailFrameTheme, mailDocument } from '@/lib/mail-html'
import {
  type Forwarded,
  forwardSummary,
  type MailText,
  readMailText,
  shownLink,
  tokens,
} from '@/lib/mail-text'
import { cn } from '@/lib/utils'

export type MailView = 'text' | 'html'

/** Text or HTML, for a mail that has both. */
export function MailViewSwitch({
  view,
  onChange,
}: {
  view: MailView
  onChange: (view: MailView) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Show the mail as"
      className="flex flex-none rounded-md border p-0.5"
    >
      {(
        [
          ['text', 'Text'],
          ['html', 'HTML'],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={view === id}
          onClick={() => onChange(id)}
          className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground aria-checked:bg-secondary aria-checked:font-medium aria-checked:text-foreground"
        >
          {label}
        </button>
      ))}
    </div>
  )
}

/** A mail's plain text: paragraphs joined back, the forwarded message apart, links to click. */
export function MailTextView({ text, className }: { text: string; className?: string }) {
  const mail = useMemo(() => readMailText(text), [text])
  return <MailTextBlock mail={mail} className={className} />
}

function MailTextBlock({ mail, className }: { mail: MailText; className?: string }) {
  return (
    <div className={cn('flex w-full flex-col gap-3', className)}>
      {mail.text && <Words text={mail.text} />}
      {mail.forwarded && (
        // Folded when the mail has words of its own above it, so they stay what one reads first;
        // a mail that only forwards shows it open, having nothing else to read.
        <ForwardedBlock forwarded={mail.forwarded} folded={Boolean(mail.text)} />
      )}
    </div>
  )
}

function ForwardedBlock({ forwarded, folded }: { forwarded: Forwarded; folded: boolean }) {
  const [open, setOpen] = useState(!folded)
  if (!open) {
    const { from, subject, date } = forwardSummary(forwarded)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={false}
        aria-label={`Show the forwarded message${from ? ` from ${from}` : ''}`}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg border bg-secondary/40 px-4 py-2.5 text-left text-sm hover:bg-secondary/70"
      >
        <ChevronRight className="size-3.5 flex-none text-muted-foreground" aria-hidden />
        <span className="flex-none text-xs font-semibold text-muted-foreground">Forwarded</span>
        <span className="min-w-0 flex-1 truncate">
          {from && <span className="font-medium">{from}</span>}
          {from && subject && <span className="text-muted-foreground"> · </span>}
          {subject && <span className="text-muted-foreground">{subject}</span>}
        </span>
        {date && (
          <time
            dateTime={date.toISOString()}
            className="flex-none text-xs text-muted-foreground tabular-nums"
          >
            {shortDate(date)}
          </time>
        )}
      </button>
    )
  }
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-secondary/40 px-4 py-3">
      <div className="flex flex-col gap-1.5">
        {folded ? (
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-expanded
            className="flex items-center gap-1 self-start text-xs font-semibold text-muted-foreground hover:text-foreground"
          >
            <ChevronRight className="size-3.5 rotate-90" aria-hidden />
            {forwarded.label}
          </button>
        ) : (
          <span className="text-xs font-semibold text-muted-foreground">{forwarded.label}</span>
        )}
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-sm">
          {forwarded.headers.map(([label, value], i) => (
            <Fragment key={`${label}-${i}`}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="wrap-anywhere">
                <Words text={value} inline />
              </dd>
            </Fragment>
          ))}
        </dl>
      </div>
      {(forwarded.body.text || forwarded.body.forwarded) && (
        <MailTextBlock mail={forwarded.body} className="border-t pt-3" />
      )}
    </div>
  )
}

/** "Oct 30", with its year when not this year's. */
function shortDate(date: Date) {
  const thisYear = date.getFullYear() === new Date().getFullYear()
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(thisYear ? {} : { year: 'numeric' }),
  })
}

function Words({ text, inline }: { text: string; inline?: boolean }) {
  const parts = tokens(text).map((t, i) => {
    if (t.kind === 'bold')
      return (
        <strong key={i} className="font-semibold">
          {t.text}
        </strong>
      )
    if (t.kind === 'text') return <Fragment key={i}>{t.text}</Fragment>
    // A long web link shows as its site; the whole URL stays on hover and in what it opens.
    const shown = t.href === t.text ? shownLink(t.text) : t.text
    return (
      <a
        key={i}
        href={t.href}
        target="_blank"
        rel="noopener noreferrer"
        title={shown === t.text ? undefined : t.href}
        className="text-primary underline-offset-4 hover:underline"
      >
        {shown}
      </a>
    )
  })
  if (inline) return <>{parts}</>
  return (
    <p className="w-full text-[15px] leading-relaxed whitespace-pre-wrap wrap-anywhere">{parts}</p>
  )
}

/** The dashboard's colors and font, as the frame's plain mail takes them. */
function frameTheme(): MailFrameTheme {
  const style = getComputedStyle(document.documentElement)
  const value = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return {
    foreground: value('--foreground', 'CanvasText'),
    link: value('--primary', 'LinkText'),
    font: getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif',
    scheme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  }
}

/**
 * A mail's HTML in a frame with no scripts, forms or navigation of the dashboard: same origin
 * only so the dashboard can measure its height (nothing runs in it to use that). Its images wait
 * for Show images.
 */
export function MailHtmlFrame({
  html,
  inline,
  title,
}: {
  html: string
  /** Each file it carries, by Content-ID: where the dashboard opens it. */
  inline: { cid: string; url: string }[]
  title: string
}) {
  const { resolvedTheme } = useTheme()
  const [showImages, setShowImages] = useState(false)
  const [height, setHeight] = useState<number>()
  const frame = useRef<HTMLIFrameElement>(null)
  const stop = useRef<() => void>(null)
  const inlineKey = JSON.stringify(inline.map((f) => [cidOf(f.cid), f.url]))
  const [doc, setDoc] = useState<ReturnType<typeof mailDocument>>()

  // Built in the browser, where DOMParser and the theme are; again when either changes.
  useEffect(() => {
    const files = new Map(JSON.parse(inlineKey) as [string, string][])
    setDoc(mailDocument(html, { showImages, inline: files, theme: frameTheme() }))
  }, [html, showImages, inlineKey, resolvedTheme])

  useEffect(() => () => stop.current?.(), [])

  function measure() {
    stop.current?.()
    if (frame.current) stop.current = followHeight(frame.current, setHeight)
  }

  if (!doc) return <div className="h-24 w-full" />
  return (
    <div className="flex w-full flex-col gap-2">
      {doc.images && !showImages && (
        <div className="flex w-full flex-wrap items-center gap-2 rounded-lg bg-secondary px-3 py-2 text-sm">
          <ImageIcon aria-hidden className="size-4 text-muted-foreground" />
          <span className="flex-1 text-muted-foreground">
            Images are hidden: those from the web tell the sender you opened the mail.
          </span>
          <button
            type="button"
            onClick={() => setShowImages(true)}
            className="rounded-full bg-card px-2.5 py-0.5 text-xs font-semibold hover:text-foreground"
          >
            Show images
          </button>
        </div>
      )}
      <iframe
        ref={frame}
        title={title}
        // No allow-scripts: nothing in it runs, so sharing the origin only lets us measure it.
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        srcDoc={doc.html}
        onLoad={measure}
        className={cn('block w-full border-0', doc.designed && 'rounded-lg bg-white')}
        style={{ height: height ?? 96 }}
      />
    </div>
  )
}
