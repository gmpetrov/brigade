'use client'
// A library document as its public link shows it (app/s/[token]): the dashboard's Markdown look,
// for someone outside the workspace. The API has already made its mentions plain names and its
// uploaded files addresses under the link (src/library-shares.ts): those show as themselves (an
// image, a video, a sound, a file to download). Other links open in a new tab; one that is no
// address on the web (what is left of a workspace's own link) stays plain text.
import { Download, FileText } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { RenewingAudio, RenewingVideo } from '@/components/renewing-media'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { API_URL } from '@/lib/config'
import { cn } from '@/lib/utils'

const linkClass = 'font-medium text-primary underline underline-offset-2 hover:no-underline'
const WEB = /^(https?:|mailto:)/i

/** A file uploaded into the document, served under its link. */
const isAsset = (href: string) =>
  href.startsWith(`${API_URL}/api/shared/`) && href.includes('/assets/')

/** A file block's title in the document's Markdown: "video", "audio", "file" or "file: caption". */
function fileBlock(title: string | undefined) {
  const [kind, ...caption] = (title ?? '').split(':')
  if (kind !== 'video' && kind !== 'audio' && kind !== 'file') return null
  return { kind, caption: caption.join(':').trim() }
}

function Caption({ children }: { children: ReactNode }) {
  return <span className="mt-1.5 block text-sm text-muted-foreground">{children}</span>
}

function Anchor({ href, title, children }: ComponentProps<'a'>) {
  if (!href || !WEB.test(href)) return <span>{children}</span>
  const block = isAsset(href) ? fileBlock(title) : null
  if (block?.kind === 'video')
    return (
      <span className="my-3 block">
        <RenewingVideo
          src={href}
          controls
          preload="metadata"
          className="max-h-[70vh] w-full rounded-lg"
        />
        {block.caption && <Caption>{block.caption}</Caption>}
      </span>
    )
  if (block?.kind === 'audio')
    return (
      <span className="my-3 block">
        <RenewingAudio src={href} controls preload="metadata" className="w-full" />
        {block.caption && <Caption>{block.caption}</Caption>}
      </span>
    )
  if (block?.kind === 'file')
    return (
      <span className="my-2 block">
        <a
          href={`${href}?download`}
          className="inline-flex max-w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-accent"
        >
          <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{children}</span>
          <Download aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        </a>
        {block.caption && <Caption>{block.caption}</Caption>}
      </span>
    )
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className={linkClass}>
      {children}
    </a>
  )
}

function Image({ src, alt, title }: ComponentProps<'img'>) {
  if (typeof src !== 'string' || !WEB.test(src)) return alt ? <span>{alt}</span> : null
  return (
    <span className="my-3 block">
      {/* eslint-disable-next-line @next/next/no-img-element -- a shared document's file, through the API */}
      <img
        src={src}
        alt={alt ?? ''}
        loading="lazy"
        referrerPolicy="no-referrer"
        className="max-h-[80vh] max-w-full rounded-lg"
      />
      {title && <Caption>{title}</Caption>}
    </span>
  )
}

const components: Components = {
  p: ({ node: _, ...props }) => <p className="my-3 first:mt-0 last:mb-0" {...props} />,
  h1: ({ node: _, ...props }) => (
    <h1 className="mt-8 mb-3 text-3xl font-bold tracking-tight first:mt-0" {...props} />
  ),
  h2: ({ node: _, ...props }) => (
    <h2 className="mt-8 mb-3 text-2xl font-bold tracking-tight first:mt-0" {...props} />
  ),
  h3: ({ node: _, ...props }) => (
    <h3 className="mt-6 mb-2 text-xl font-semibold first:mt-0" {...props} />
  ),
  h4: ({ node: _, ...props }) => <h4 className="mt-5 mb-2 font-semibold first:mt-0" {...props} />,
  h5: ({ node: _, ...props }) => <h5 className="mt-4 mb-1 font-semibold first:mt-0" {...props} />,
  h6: ({ node: _, ...props }) => (
    <h6 className="mt-4 mb-1 font-semibold text-muted-foreground first:mt-0" {...props} />
  ),
  ul: ({ node: _, className, ...props }) => (
    <ul
      className={cn(
        'my-3 list-disc space-y-1 pl-6 first:mt-0 last:mb-0 marker:text-muted-foreground',
        // GFM task lists: the checkbox is the marker.
        className?.includes('contains-task-list') && 'list-none pl-1',
      )}
      {...props}
    />
  ),
  ol: ({ node: _, ...props }) => (
    <ol
      className="my-3 list-decimal space-y-1 pl-6 first:mt-0 last:mb-0 marker:text-muted-foreground"
      {...props}
    />
  ),
  li: ({ node: _, ...props }) => (
    <li className="pl-1 [&>input]:mr-2 [&>input]:align-middle [&>ol]:my-1 [&>ul]:my-1" {...props} />
  ),
  blockquote: ({ node: _, ...props }) => (
    <blockquote
      className="my-4 border-l-2 border-border pl-4 text-muted-foreground first:mt-0 last:mb-0"
      {...props}
    />
  ),
  hr: ({ node: _, ...props }) => <hr className="my-6 border-border" {...props} />,
  a: ({ node: _, ...props }) => <Anchor {...props} />,
  img: ({ node: _, ...props }) => <Image {...props} />,
  code: ({ node: _, className, ...props }) => (
    <code
      className={cn(
        // Inline code; a block's is styled by its <pre>.
        !className?.includes('hljs') &&
          'rounded bg-muted px-1.5 py-0.5 font-mono text-[0.875em] wrap-anywhere',
        className,
      )}
      {...props}
    />
  ),
  pre: ({ node: _, ...props }) => (
    <pre
      className="my-4 overflow-x-auto rounded-lg bg-muted p-4 font-mono text-sm leading-relaxed first:mt-0 last:mb-0 [&>code]:bg-transparent [&>code]:p-0"
      {...props}
    />
  ),
  table: ({ node: _, ...props }) => (
    <div className="my-4 overflow-x-auto first:mt-0 last:mb-0">
      <table className="w-full border-collapse text-sm" {...props} />
    </div>
  ),
  th: ({ node: _, ...props }) => (
    <th className="border border-border bg-muted px-3 py-1.5 text-left font-semibold" {...props} />
  ),
  td: ({ node: _, ...props }) => (
    <td className="border border-border px-3 py-1.5 align-top" {...props} />
  ),
  // Checkboxes of a shared list show where it stands, and change nothing.
  input: ({ node: _, ...props }) => <input {...props} disabled />,
}

const rehypePlugins = [
  [rehypeHighlight, { plainText: ['text', 'txt', 'plain'] }],
] satisfies ComponentProps<typeof ReactMarkdown>['rehypePlugins']

export function PublicMarkdown({ text }: { text: string }) {
  return (
    <div className="min-w-0 text-base leading-relaxed wrap-anywhere">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
