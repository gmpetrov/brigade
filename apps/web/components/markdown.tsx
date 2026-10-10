'use client'
// Markdown in the thread: teammates' replies, thinking and questions. Raw HTML
// is never rendered (react-markdown escapes it), remote images are not loaded
// (a link instead), and mentions a teammate echoes back show as chips.
import { MENTION_KINDS, type MentionKind } from '@brigade/contracts'
import { Check, Copy, ImageIcon } from 'lucide-react'
import { memo, useState, type ComponentProps, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  FileLinksProvider,
  looksLikeFile,
  relativeFile,
  useFileLinks,
} from '@/components/file-links'
import { MentionChip } from '@/components/mention'
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
        <span className="absolute top-2 left-3 font-mono text-[0.6875rem] text-muted-foreground uppercase">
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

/** Inline code; a file path opens in the panel beside the thread. */
function InlineCode({ className, children, ...props }: ComponentProps<'code'>) {
  const links = useFileLinks()
  const text = textOf(children)
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

/** A link; a relative one (a file next to this one) opens in the panel. */
function Anchor({ href, children, ...props }: ComponentProps<'a'>) {
  const links = useFileLinks()
  const file = links ? relativeFile(href, links.base) : undefined
  const className = 'font-medium text-primary underline underline-offset-2 hover:no-underline'
  if (links && file)
    return (
      <button
        type="button"
        onClick={() => links.open({ path: file, teammateId: links.teammateId })}
        title={`Open ${file}`}
        className={cn(className, 'cursor-pointer')}
      >
        {children}
      </button>
    )
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className={className}
      {...props}
    >
      {children}
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
  // Loading a remote image would tell its host who reads the thread: link to it instead.
  img: ({ src, alt }) =>
    typeof src === 'string' && src ? (
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="inline-flex items-center gap-1 font-medium text-primary underline underline-offset-2 hover:no-underline"
      >
        <ImageIcon className="size-3.5" aria-hidden />
        {alt || 'Image'}
      </a>
    ) : null,
  code: ({ node: _, ...props }) => <InlineCode {...props} />,
  // A code block's text is code, not links.
  pre: ({ node: _, ...props }) => (
    <FileLinksProvider value={null}>
      <CodeBlock {...props} />
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
        components={components}
        urlTransform={urlTransform}
      >
        {text.replace(MENTION, '[$1]($2)')}
      </ReactMarkdown>
    </div>
  )
})
