'use client'
// A received mail's words in the Inbox, two ways: its text made readable (paragraphs, the
// forwarded message's header block, links), the default; or its HTML as it was made, in a
// sandboxed frame (lib/mail-html.ts says what it lets through).
import { ImageIcon } from 'lucide-react'
import { useTheme } from 'next-themes'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { cidOf, type MailFrameTheme, mailDocument } from '@/lib/mail-html'
import { type MailText, readMailText, tokens } from '@/lib/mail-text'
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
        <div className="flex flex-col gap-3 rounded-lg border bg-secondary/40 px-4 py-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-muted-foreground">
              {mail.forwarded.label}
            </span>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-sm">
              {mail.forwarded.headers.map(([label, value], i) => (
                <Fragment key={`${label}-${i}`}>
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="wrap-anywhere">
                    <Words text={value} inline />
                  </dd>
                </Fragment>
              ))}
            </dl>
          </div>
          {(mail.forwarded.body.text || mail.forwarded.body.forwarded) && (
            <MailTextBlock mail={mail.forwarded.body} className="border-t pt-3" />
          )}
        </div>
      )}
    </div>
  )
}

function Words({ text, inline }: { text: string; inline?: boolean }) {
  const parts = tokens(text).map((t, i) =>
    t.kind === 'link' ? (
      <a
        key={i}
        href={t.href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary underline-offset-4 hover:underline"
      >
        {t.text}
      </a>
    ) : t.kind === 'bold' ? (
      <strong key={i} className="font-semibold">
        {t.text}
      </strong>
    ) : (
      <Fragment key={i}>{t.text}</Fragment>
    ),
  )
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
 * only so the dashboard can measure its height (nothing runs in it to use that). Images from the
 * web wait for Show images.
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
  const observer = useRef<ResizeObserver>(null)
  const inlineKey = JSON.stringify(inline.map((f) => [cidOf(f.cid), f.url]))
  const [doc, setDoc] = useState<ReturnType<typeof mailDocument>>()

  // Built in the browser, where DOMParser and the theme are; again when either changes.
  useEffect(() => {
    const files = new Map(JSON.parse(inlineKey) as [string, string][])
    setDoc(mailDocument(html, { showImages, inline: files, theme: frameTheme() }))
  }, [html, showImages, inlineKey, resolvedTheme])

  useEffect(() => () => observer.current?.disconnect(), [])

  function measure() {
    const root = frame.current?.contentDocument?.documentElement
    if (!root) return
    observer.current?.disconnect()
    const fit = () => setHeight(Math.max(Math.ceil(root.scrollHeight), 24))
    observer.current = new ResizeObserver(fit)
    observer.current.observe(root)
    fit()
  }

  if (!doc) return <div className="h-24 w-full" />
  return (
    <div className="flex w-full flex-col gap-2">
      {doc.remoteImages && !showImages && (
        <div className="flex w-full flex-wrap items-center gap-2 rounded-lg bg-secondary px-3 py-2 text-sm">
          <ImageIcon aria-hidden className="size-4 text-muted-foreground" />
          <span className="flex-1 text-muted-foreground">
            Images from the web are hidden: they tell the sender you opened it.
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
