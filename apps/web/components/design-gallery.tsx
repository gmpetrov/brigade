'use client'
// Every design in the library, newest first: its picture (the thumbnail
// save_design renders), name, folder and who changed it last. Opens beside
// the page. Options offered for one design (an options folder) are one card
// until someone picks. A design system's preview is left to the Design systems tab.
import {
  DESIGN_OPTIONS_SUFFIX,
  DESIGN_THUMBNAIL,
  designFolderOf,
  designName,
  designOptionsOf,
  type DesignSystem,
  type LibraryFile,
} from '@brigade/contracts'
import { Layers, Palette } from 'lucide-react'
import { useMemo, useState } from 'react'
import { timeAgo } from '@/components/dashboard'
import { DesignPanel } from '@/components/design-view'
import { contentUrl } from '@/components/library-browser'
import { ActorName } from '@/components/library-history'
import { Card } from '@/components/ui/card'
import { useApi, type LibraryTree } from '@/lib/api'

type Design = { folder: string; files: LibraryFile[]; latest: LibraryFile; thumbnail?: LibraryFile }
/** A design, or the options offered for one: then `folder` is the options folder, its picture the first option's. */
type Entry = Design & { options?: Design[] }

export function DesignGallery({ tree }: { tree: LibraryTree | undefined }) {
  const [open, setOpen] = useState<string>()
  const systems = useApi<DesignSystem[]>('/design-systems')
  const entries = useMemo(() => {
    const inSystem = (folder: string) =>
      (systems.data ?? []).some((s) => folder.startsWith(`${s.path}/`))
    const byFolder = new Map<string, LibraryFile[]>()
    for (const file of tree?.files ?? []) {
      const folder = designFolderOf(file.path)
      if (folder && !inSystem(folder)) byFolder.set(folder, [...(byFolder.get(folder) ?? []), file])
    }
    const newest = (a: { latest: LibraryFile }, b: { latest: LibraryFile }) =>
      b.latest.updatedAt.localeCompare(a.latest.updatedAt)
    const sets = new Map<string, Design[]>()
    const entries: Entry[] = []
    for (const [folder, files] of byFolder) {
      const latest = files.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a))
      const thumbnail = files.find((f) => f.path === `${folder}/${DESIGN_THUMBNAIL}`)
      const design: Design = { folder, files, latest, ...(thumbnail ? { thumbnail } : {}) }
      const options = designOptionsOf(folder)
      if (options) sets.set(options, [...(sets.get(options) ?? []), design])
      else entries.push(design)
    }
    for (const [folder, options] of sets) {
      // In the order they were offered (a, b, c…), dated by the newest change.
      options.sort((a, b) => a.folder.localeCompare(b.folder))
      const { latest } = [...options].sort(newest)[0]!
      entries.push({ ...options[0]!, latest, folder, options })
    }
    return entries.sort(newest)
  }, [tree, systems.data])
  /** The open design's set of options, if it is one. */
  const openSet = open && entries.find((e) => e.folder === designOptionsOf(open))?.options

  if (!tree || (!systems.data && !systems.error))
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (entries.length === 0)
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
        {entries.map((d) => {
          const options = d.options
          const name = options
            ? d.folder.split('/').pop()!.slice(0, -DESIGN_OPTIONS_SUFFIX.length)
            : designName(d.folder)
          const slash = d.folder.lastIndexOf('/')
          const opens = options ? options[0]!.folder : d.folder
          const pressed = options ? options.some((o) => o.folder === open) : open === d.folder
          const behind = options?.length ?? 0
          return (
            <li key={d.folder}>
              <button
                type="button"
                onClick={() => setOpen(opens)}
                aria-pressed={pressed}
                className="group relative flex w-full flex-col text-left"
              >
                {/* The other options, as cards stacked behind it. */}
                {behind > 2 && (
                  <span
                    aria-hidden
                    className="absolute inset-x-6 -top-3 h-6 rounded-t-xl border border-b-0 bg-muted/60"
                  />
                )}
                {behind > 1 && (
                  <span
                    aria-hidden
                    className="absolute inset-x-3 -top-1.5 h-6 rounded-t-xl border border-b-0 bg-muted"
                  />
                )}
                <span className="relative flex w-full flex-col overflow-hidden rounded-xl border bg-card shadow-xs transition group-hover:border-primary/40 group-aria-pressed:ring-2 group-aria-pressed:ring-primary/40">
                  <span className="relative flex aspect-[16/10] items-center justify-center overflow-hidden border-b bg-muted/50">
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
                    {options && (
                      <span className="absolute right-2 bottom-2 flex items-center gap-1 rounded-full bg-background/85 px-2.5 py-1 text-xs font-semibold backdrop-blur-sm">
                        <Layers aria-hidden className="size-3.5" />
                        {options.length} options
                      </span>
                    )}
                  </span>
                  <span className="flex flex-col gap-0.5 px-4 py-3">
                    <span className="truncate text-sm font-semibold">{name}</span>
                    {slash > 0 && (
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        {d.folder.slice(0, slash)}
                      </span>
                    )}
                    <span className="truncate text-xs text-muted-foreground">
                      {options && 'Waiting for a pick · '}
                      {timeAgo(d.latest.updatedAt)}
                      {d.latest.updatedBy && (
                        <>
                          {' by '}
                          <ActorName actor={d.latest.updatedBy} />
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
      {open && (
        <DesignPanel
          folder={open}
          version={(openSet || entries).find((d) => d.folder === open)?.latest.updatedAt}
          onClose={() => setOpen(undefined)}
          {...(openSet ? { options: openSet.map((o) => o.folder), onOption: setOpen } : {})}
        />
      )}
    </>
  )
}
