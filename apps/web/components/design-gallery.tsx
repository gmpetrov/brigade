'use client'
// Every design in the library, newest first: its picture (the thumbnail
// save_design renders), name, folder and who changed it last. Opens beside
// the page. A design system's preview is left to the Design systems tab.
import {
  DESIGN_THUMBNAIL,
  designFolderOf,
  designName,
  type DesignSystem,
  type LibraryFile,
} from '@brigade/contracts'
import { Palette } from 'lucide-react'
import { useMemo, useState } from 'react'
import { timeAgo } from '@/components/dashboard'
import { DesignPanel } from '@/components/design-view'
import { contentUrl } from '@/components/library-browser'
import { ActorName } from '@/components/library-history'
import { Card } from '@/components/ui/card'
import { useApi, type LibraryTree } from '@/lib/api'

type Design = { folder: string; files: LibraryFile[]; latest: LibraryFile; thumbnail?: LibraryFile }

export function DesignGallery({ tree }: { tree: LibraryTree | undefined }) {
  const [open, setOpen] = useState<string>()
  const systems = useApi<DesignSystem[]>('/design-systems')
  const designs = useMemo(() => {
    const inSystem = (folder: string) =>
      (systems.data ?? []).some((s) => folder.startsWith(`${s.path}/`))
    const byFolder = new Map<string, LibraryFile[]>()
    for (const file of tree?.files ?? []) {
      const folder = designFolderOf(file.path)
      if (folder && !inSystem(folder)) byFolder.set(folder, [...(byFolder.get(folder) ?? []), file])
    }
    return [...byFolder.entries()]
      .map(([folder, files]): Design => {
        const latest = files.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a))
        const thumbnail = files.find((f) => f.path === `${folder}/${DESIGN_THUMBNAIL}`)
        return { folder, files, latest, ...(thumbnail ? { thumbnail } : {}) }
      })
      .sort((a, b) => b.latest.updatedAt.localeCompare(a.latest.updatedAt))
  }, [tree, systems.data])

  if (!tree || (!systems.data && !systems.error))
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (designs.length === 0)
    return (
      <Card className="items-center gap-3 border-dashed px-6 py-12 text-center shadow-none">
        <span
          aria-hidden
          className="flex size-11 items-center justify-center rounded-md bg-primary/15 text-primary"
        >
          <Palette className="size-5" />
        </span>
        <p className="font-semibold">No designs yet.</p>
        <p className="max-w-md text-sm text-muted-foreground">
          Ask a teammate for a page, a screen, a prototype or slides. It makes them as web pages in
          the library, where you comment on them, tune them and hand them off.
        </p>
      </Card>
    )

  return (
    <>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-4">
        {designs.map((d) => {
          const slash = d.folder.lastIndexOf('/')
          return (
            <li key={d.folder}>
              <button
                type="button"
                onClick={() => setOpen(d.folder)}
                aria-pressed={open === d.folder}
                className="group flex w-full flex-col overflow-hidden rounded-xl border bg-card text-left shadow-xs transition hover:border-primary/40 aria-pressed:ring-2 aria-pressed:ring-primary/40"
              >
                <span className="flex aspect-[16/10] items-center justify-center overflow-hidden border-b bg-muted/50">
                  {d.thumbnail ? (
                    // eslint-disable-next-line @next/next/no-img-element -- a library file through the API
                    <img
                      src={contentUrl(d.thumbnail.id)}
                      alt=""
                      loading="lazy"
                      className="size-full object-cover object-top transition group-hover:scale-[1.02]"
                    />
                  ) : (
                    <Palette aria-hidden className="size-8 text-muted-foreground/60" />
                  )}
                </span>
                <span className="flex flex-col gap-0.5 px-4 py-3">
                  <span className="truncate text-sm font-semibold">{designName(d.folder)}</span>
                  {slash > 0 && (
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {d.folder.slice(0, slash)}
                    </span>
                  )}
                  <span className="truncate text-xs text-muted-foreground">
                    {timeAgo(d.latest.updatedAt)}
                    {d.latest.updatedBy && (
                      <>
                        {' by '}
                        <ActorName actor={d.latest.updatedBy} />
                      </>
                    )}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {open && (
        <DesignPanel
          folder={open}
          version={designs.find((d) => d.folder === open)?.latest.updatedAt}
          onClose={() => setOpen(undefined)}
        />
      )}
    </>
  )
}
