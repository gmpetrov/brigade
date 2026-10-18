'use client'
// Markdown in the thread: teammates' replies, thinking and questions. Raw HTML
// is never rendered (react-markdown escapes it), remote images are not loaded
// (a link instead), an image in a teammate's folder opens over the page,
// mentions a teammate echoes back show as chips, and code blocks are highlighted
// (highlight.js's common languages: JSON, YAML, XML/HTML, CSS, JS/TS, Python,
// shell, SQL, diff and more; colors in globals.css).
import { MENTION_KINDS, type MentionKind } from '@brigade/contracts'
import { Check, Copy, ImageIcon } from 'lucide-react'
import {
  createContext,
  memo,
  useContext,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { MediaPreview } from '@/components/attachments'
import {
  FileLinksProvider,
  looksLikeFile,
  relativeFile,
  useFileLinks,
} from '@/components/file-links'
import { MentionChip, MessageText } from '@/components/mention'
import { threadImageUrl } from '@/lib/api'
import { cn } from '@/lib/utils'

const MENTION_HREF = new RegExp(`^(${MENTION_KINDS.join('|')}):([^\\s]+)$`)
/** `@[Label](kind:id)` is a link once its `@` goes: the link renderer turns it into a chip. */
const MENTION = new RegExp(
  `@\\[([^\\]\\n]+)\\]\\(((?:${MENTION_KINDS.join('|')}):[^)\\s]+)\\)`,
  'g',
)

const urlTransform = (url: string) => (MENTION_HREF.test(url) ? url : defaultUrlTransform(url))

/** The plain text inside rendered children, for copying a code block. */
function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && typeof node === 'object' && 'props' in node)
    return textOf((node.props as { children?: ReactNode }).children)
  return ''
}

function CodeBlock({ children, ...props }: ComponentProps<'pre'>) {
  const [copied, setCopied] = useState(false)
  const code = (Array.isArray(children) ? children[0] : children) as
    { props?: { className?: string } } | undefined
  const language = code?.props?.className?.match(/language-([\w+-]+)/)?.[1]
  return (
    <div className="group/code relative my-3 first:mt-0 last:mb-0">
      {language && (
        <span
          data-code-language
          className="absolute top-2 left-3 font-mono text-[0.6875rem] text-muted-foreground uppercase"
        >
          {language}
        </span>
      )}
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(textOf(children).replace(/\n$/, '')).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
        className="absolute top-1.5 right-1.5 rounded-md p-1.5 text-muted-foreground opacity-0 transition-opacity group-hover/code:opacity-100 hover:bg-background hover:text-foreground focus-visible:opacity-100"
        aria-label={copied ? 'Copied' : 'Copy code'}
        title={copied ? 'Copied' : 'Copy'}
      >
        {copied ? (
          <Check className="size-3.5" aria-hidden />
        ) : (
          <Copy className="size-3.5" aria-hidden />
        )}
      </button>
      <pre
        {...props}
        className={cn(
          'overflow-x-auto rounded-lg bg-muted px-4 py-3 font-mono text-[0.8125rem] leading-relaxed',
          language && 'pt-7',
          '[&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit',
        )}
      >
        {children}
      </pre>
    </div>
  )
}

const codeClass = 'rounded bg-muted px-1.5 py-0.5 font-mono text-[0.875em] wrap-anywhere'

/** Inline code in a ticket: something a person pastes elsewhere, so it has a copy button. */
const CopyInline = createContext(false)

/** Inline code under it gets a copy button, and an address in it opens as a link. */
export function CopyableCode({ children }: { children: ReactNode }) {
  return <CopyInline.Provider value>{children}</CopyInline.Provider>
}

function CopyChip({ text, children }: { text: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const url = /^https?:\/\/\S+$/.test(text)
  return (
    <span className="inline-flex max-w-full items-baseline gap-0.5 rounded bg-muted py-0.5 pr-0.5 pl-1.5 align-baseline">
      {url ? (
        <a
          href={text}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="min-w-0 font-mono text-[0.875em] wrap-anywhere text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
        >
          {children}
        </a>
      ) : (
        <code className="min-w-0 font-mono text-[0.875em] wrap-anywhere">{children}</code>
      )}
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
        className="flex-none self-center rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
        aria-label={copied ? 'Copied' : `Copy ${text}`}
        title={copied ? 'Copied' : 'Copy'}
      >
        {copied ? (
          <Check className="size-3" aria-hidden />
        ) : (
          <Copy className="size-3" aria-hidden />
        )}
      </button>
    </span>
  )
}

/** Inline code; a file path opens in the panel beside the thread. */
function InlineCode({ className, children, ...props }: ComponentProps<'code'>) {
  const links = useFileLinks()
  const copyable = useContext(CopyInline)
  const text = textOf(children)
  if (copyable && !className && !(links && looksLikeFile(text)))
    return <CopyChip text={text}>{children}</CopyChip>
  if (!links || className || !looksLikeFile(text))
    return (
      <code className={cn(codeClass, className)} {...props}>
        {children}
      </code>
    )
  return (
    <button
      type="button"
      onClick={() => links.open({ path: text, teammateId: links.teammateId })}
      title={`Open ${text}`}
      className={cn(
        codeClass,
        'cursor-pointer text-primary underline decoration-primary/40 underline-offset-2 transition-colors hover:bg-primary/15 hover:decoration-primary',
      )}
    >
      {children}
    </button>
  )
}

const linkClass = 'font-medium text-primary underline underline-offset-2 hover:no-underline'

const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i

/**
 * An image in a teammate's folder, named by a relative link or `![](path)`: it
 * opens over the page like an attached one. Its path is no address on the web.
 */
function FileImage({ path, children }: { path: string; children: ReactNode }) {
  const links = useFileLinks()
  const [open, setOpen] = useState(false)
  if (!links?.threadId) return <>{children}</>
  const name = path.split('/').pop() ?? path
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`Preview ${name}`}
        className={cn(linkClass, 'inline-flex cursor-zoom-in items-center gap-1')}
      >
        {children}
      </button>
      <MediaPreview
        media={
          open
            ? { name, src: threadImageUrl(links.threadId, path, links.teammateId), kind: 'image' }
            : undefined
        }
        onClose={() => setOpen(false)}
      />
    </>
  )
}

/** A link; a relative one (a file next to this one) opens in the panel, or over the page for an image. */
function Anchor({ href, children, ...props }: ComponentProps<'a'>) {
  const links = useFileLinks()
  const file = links ? relativeFile(href, links.base) : undefined
  if (links?.threadId && file && IMAGE_FILE.test(file))
    return <FileImage path={file}>{children}</FileImage>
  if (links && file)
    return (
      <button
        type="button"
        onClick={() => links.open({ path: file, teammateId: links.teammateId })}
        title={`Open ${file}`}
        className={cn(linkClass, 'cursor-pointer')}
      >
        {children}
      </button>
    )
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className={linkClass}
      {...props}
    >
      {children}
    </a>
  )
}

/**
 * `![alt](src)`. Loading a remote image would tell its host who reads the thread:
 * a link to it instead. One in a teammate's folder opens over the page; elsewhere
 * its name stays plain text, as its path leads nowhere in the browser.
 */
function MarkdownImage({ src, alt }: { src?: unknown; alt?: string }) {
  const links = useFileLinks()
  if (typeof src !== 'string' || !src) return null
  const label = (
    <>
      <ImageIcon className="size-3.5" aria-hidden />
      {alt || 'Image'}
    </>
  )
  const file = relativeFile(src, links?.base)
  if (file)
    return links?.threadId && IMAGE_FILE.test(file) ? (
      <FileImage path={file}>{label}</FileImage>
    ) : (
      <span className="inline-flex items-center gap-1 font-medium">{label}</span>
    )
  return (
    <a
      href={src}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className={cn(linkClass, 'inline-flex items-center gap-1')}
    >
      {label}
    </a>
  )
}

const components: Components = {
  p: ({ node: _, ...props }) => <p className="my-2 first:mt-0 last:mb-0" {...props} />,
  h1: ({ node: _, ...props }) => (
    <h1 className="mt-5 mb-2 text-xl font-bold first:mt-0" {...props} />
  ),
  h2: ({ node: _, ...props }) => (
    <h2 className="mt-5 mb-2 text-lg font-bold first:mt-0" {...props} />
  ),
  h3: ({ node: _, ...props }) => (
    <h3 className="mt-4 mb-1.5 text-base font-bold first:mt-0" {...props} />
  ),
  h4: ({ node: _, ...props }) => <h4 className="mt-4 mb-1 font-semibold first:mt-0" {...props} />,
  h5: ({ node: _, ...props }) => <h5 className="mt-3 mb-1 font-semibold first:mt-0" {...props} />,
  h6: ({ node: _, ...props }) => (
    <h6 className="mt-3 mb-1 font-semibold text-muted-foreground first:mt-0" {...props} />
  ),
  ul: ({ node: _, className, ...props }) => (
    <ul
      className={cn(
        'my-2 list-disc space-y-1 pl-6 first:mt-0 last:mb-0 marker:text-muted-foreground',
        // GFM task lists: the checkbox is the marker.
        className?.includes('contains-task-list') && 'list-none pl-1',
      )}
      {...props}
    />
  ),
  ol: ({ node: _, ...props }) => (
    <ol
      className="my-2 list-decimal space-y-1 pl-6 first:mt-0 last:mb-0 marker:text-muted-foreground"
      {...props}
    />
  ),
  li: ({ node: _, ...props }) => (
    <li className="pl-1 [&>input]:mr-2 [&>input]:align-middle [&>ol]:my-1 [&>ul]:my-1" {...props} />
  ),
  blockquote: ({ node: _, ...props }) => (
    <blockquote
      className="my-3 border-l-2 border-border pl-4 text-muted-foreground first:mt-0 last:mb-0"
      {...props}
    />
  ),
  hr: ({ node: _, ...props }) => <hr className="my-4 border-border" {...props} />,
  a: ({ node: _, href, children, ...props }) => {
    const mention = href?.match(MENTION_HREF)
    if (mention)
      return (
        <MentionChip
          mention={{ kind: mention[1] as MentionKind, id: mention[2]!, label: textOf(children) }}
        />
      )
    return (
      <Anchor href={href} {...props}>
        {children}
      </Anchor>
    )
  },
  img: ({ src, alt }) => <MarkdownImage src={src} alt={alt} />,
  code: ({ node: _, ...props }) => <InlineCode {...props} />,
  // A code block's text is code, not links; it has its own copy button.
  pre: ({ node: _, ...props }) => (
    <FileLinksProvider value={null}>
      <CopyInline.Provider value={false}>
        <CodeBlock {...props} />
      </CopyInline.Provider>
    </FileLinksProvider>
  ),
  table: ({ node: _, ...props }) => (
    <div className="my-3 overflow-x-auto first:mt-0 last:mb-0">
      <table className="w-full border-collapse text-sm" {...props} />
    </div>
  ),
  th: ({ node: _, ...props }) => (
    <th className="border border-border bg-muted px-3 py-1.5 text-left font-semibold" {...props} />
  ),
  td: ({ node: _, ...props }) => (
    <td className="border border-border px-3 py-1.5 align-top" {...props} />
  ),
}

// Only fenced blocks that name their language: guessing is slow and often wrong.
const rehypePlugins = [
  [rehypeHighlight, { plainText: ['text', 'txt', 'plain'] }],
] satisfies ComponentProps<typeof ReactMarkdown>['rehypePlugins']

/** Markdown text, styled with the theme. Memoised: streaming re-renders only the message that grows. */
export const Markdown = memo(function Markdown({
  text,
  className,
}: {
  text: string
  className?: string
}) {
  return (
    <div className={cn('min-w-0 leading-relaxed wrap-anywhere', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={components}
        urlTransform={urlTransform}
      >
        {text.replace(MENTION, '[$1]($2)')}
      </ReactMarkdown>
    </div>
  )
})

type Segment = { text: string } | { code: string; language: string }

/** A message's fenced code blocks (``` or ~~~, closed or running to the end) and the text around them. */
function splitFences(text: string): Segment[] {
  const segments: Segment[] = []
  const lines = text.split('\n')
  let prose: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i]!.match(/^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/)
    if (!open) {
      prose.push(lines[i]!)
      continue
    }
    const fence = open[1]!
    const close = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`)
    const code: string[] = []
    while (++i < lines.length && !close.test(lines[i]!)) code.push(lines[i]!)
    if (prose.length) segments.push({ text: prose.join('\n') })
    prose = []
    segments.push({ code: code.join('\n'), language: open[2]!.toLowerCase() })
  }
  if (prose.length) segments.push({ text: prose.join('\n') })
  return segments
}

/** JSON that parses, as an object or array: pretty-printed when it came in one line. */
function asJson(text: string) {
  const trimmed = text.trim()
  if (!/^[[{]/.test(trimmed)) return undefined
  try {
    const value: unknown = JSON.parse(trimmed)
    return trimmed.includes('\n') ? trimmed : JSON.stringify(value, null, 2)
  } catch {
    return undefined
  }
}

/** One code block, through the same renderer as a teammate's. `bare`: without its language over it. */
export function CodeSnippet({
  code,
  language,
  bare,
}: {
  code: string
  language: string
  bare?: boolean
}) {
  const json = (!language || language === 'json') && asJson(code)
  if (json) [code, language] = [json, 'json']
  // A fence longer than any run of backticks inside, so the code cannot close it.
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return (
    <Markdown
      text={`${fence}${language}\n${code}\n${fence}`}
      className={cn(
        'text-foreground [&_pre]:bg-background',
        bare && '[&_[data-code-language]]:hidden [&_pre]:pt-3',
      )}
    />
  )
}

/**
 * What a person wrote: plain text with mention chips, except its fenced code
 * blocks (or the whole message, when it is just JSON) show as code. Plain text
 * stays plain: a person's `*` or `#` is not formatting.
 */
export const MessageWithCode = memo(function MessageWithCode({ text }: { text: string }) {
  const json = asJson(text)
  const segments = json ? [{ code: json, language: 'json' }] : splitFences(text)
  if (segments.every((s) => 'text' in s)) return <MessageText text={text} />
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {segments.map((s, i) =>
        'text' in s ? (
          // The blank lines around a fence are the gap.
          s.text.trim() && (
            <div key={i}>
              <MessageText text={s.text.replace(/^\n+|\n+$/g, '')} />
            </div>
          )
        ) : (
          <CodeSnippet key={i} code={s.code} language={s.language} />
        ),
      )}
    </div>
  )
})
