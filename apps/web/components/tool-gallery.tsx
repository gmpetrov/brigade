'use client'
// Every tool in the library (docs/tools.md), newest first: its picture (the
// thumbnail save_tool renders), name, folder and who changed it last. Opens
// beside the page.
import {
  TOOL_ENTRY,
  TOOL_THUMBNAIL,
  toolFolderOf,
  toolName,
  type LibraryFile,
} from '@brigade/contracts'
import { Wrench } from 'lucide-react'
import { useMemo, useState } from 'react'
import { timeAgo } from '@/components/dashboard'
import { contentUrl } from '@/components/library-browser'
import { ActorName } from '@/components/library-history'
import { ToolPanel } from '@/components/tool-view'
import { Card } from '@/components/ui/card'
import type { LibraryTree } from '@/lib/api'

type Tool = { folder: string; latest: LibraryFile; thumbnail?: LibraryFile }

/** The tools of a library: each folder with a page, as of its newest file. */
export function toolsIn(files: LibraryFile[]): Tool[] {
  const byFolder = new Map<string, LibraryFile[]>()
  for (const file of files) {
    const folder = toolFolderOf(file.path)
    if (folder) byFolder.set(folder, [...(byFolder.get(folder) ?? []), file])
  }
  const tools: Tool[] = []
  for (const [folder, list] of byFolder) {
    if (!list.some((f) => f.path === `${folder}/${TOOL_ENTRY}`)) continue
    const latest = list.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a))
    const thumbnail = list.find((f) => f.path === `${folder}/${TOOL_THUMBNAIL}`)
    tools.push({ folder, latest, ...(thumbnail ? { thumbnail } : {}) })
  }
  return tools.sort((a, b) => b.latest.updatedAt.localeCompare(a.latest.updatedAt))
}

export function ToolGallery({ tree }: { tree: LibraryTree | undefined }) {
  const [open, setOpen] = useState<string>()
  const tools = useMemo(() => toolsIn(tree?.files ?? []), [tree])

  if (!tree) return <p className="text-sm text-muted-foreground">Loading…</p>
  if (tools.length === 0)
    return (
      <Card className="items-center gap-3 border-dashed px-6 py-12 text-center shadow-none">
        <span
          aria-hidden
          className="flex size-11 items-center justify-center rounded-md bg-primary/15 text-primary"
        >
          <Wrench className="size-5" />
        </span>
        <p className="font-semibold">No tools yet.</p>
        <p className="max-w-md text-sm text-muted-foreground">
          Ask a teammate for a small app to work in: a dashboard for a campaign, a board to review
          and approve generated clips, a tracker. It builds it in the library, where it reads your
          files, keeps what you do in it and calls the Apps you attach.
        </p>
      </Card>
    )

  return (
    <>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-4">
        {tools.map((t) => {
          const slash = t.folder.lastIndexOf('/')
          return (
            <li key={t.folder}>
              <button
                type="button"
                onClick={() => setOpen(t.folder)}
                aria-pressed={open === t.folder}
                className="group relative flex w-full flex-col text-left"
              >
                <span className="relative flex w-full flex-col overflow-hidden rounded-xl border bg-card shadow-xs transition group-hover:border-primary/40 group-aria-pressed:ring-2 group-aria-pressed:ring-primary/40">
                  <span className="relative flex aspect-[16/10] items-center justify-center overflow-hidden border-b bg-muted/50">
                    {t.thumbnail ? (
                      // eslint-disable-next-line @next/next/no-img-element -- a library file through the API
                      <img
                        src={contentUrl(t.thumbnail.id)}
                        alt=""
                        loading="lazy"
                        className="size-full object-cover object-top transition group-hover:scale-[1.02]"
                      />
                    ) : (
                      <Wrench aria-hidden className="size-8 text-muted-foreground/60" />
                    )}
                  </span>
                  <span className="flex flex-col gap-0.5 px-4 py-3">
                    <span className="truncate text-sm font-semibold">{toolName(t.folder)}</span>
                    {slash > 0 && (
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        {t.folder.slice(0, slash)}
                      </span>
                    )}
                    <span className="truncate text-xs text-muted-foreground">
                      {timeAgo(t.latest.updatedAt)}
                      {t.latest.updatedBy && (
                        <>
                          {' by '}
                          <ActorName actor={t.latest.updatedBy} />
                        </>
                      )}
                    </span>
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {open && <ToolPanel folder={open} onClose={() => setOpen(undefined)} />}
    </>
  )
}
