'use client'
import { FilePlus, FolderPlus, Upload } from 'lucide-react'
import Link from 'next/link'
import { useRef, useState } from 'react'
import { isAdmin, useDashboard } from '@/components/dashboard'
import { join, LibraryBrowser } from '@/components/library-browser'
import { useProject } from '@/components/project-shell'
import { Button } from '@/components/ui/button'
import { uploadToLibrary, useApi, type LibraryTree } from '@/lib/api'

/** The library opened at the project's folder. Above it, the rest of the library is a click away. */
export default function ProjectLibrary() {
  const { project, reload } = useProject()
  const { me, teammates } = useDashboard()
  const tree = useApi<LibraryTree>('/library/tree', ['library.updated'])
  const [folder, setFolder] = useState(project.folder ?? '')
  const [creating, setCreating] = useState<'file' | 'folder' | null>(null)
  const [uploading, setUploading] = useState<string>()
  const [error, setError] = useState<string>()
  const input = useRef<HTMLInputElement>(null)

  async function upload(list: { file: File; path: string }[]) {
    setError(undefined)
    for (const [i, { file, path }] of list.entries()) {
      setUploading(list.length > 1 ? `${i + 1} of ${list.length}` : file.name)
      try {
        await uploadToLibrary(path, file)
      } catch (e) {
        setError(`${path}: ${(e as Error).message}`)
        break
      }
    }
    setUploading(undefined)
    if (input.current) input.current.value = ''
    await Promise.all([tree.reload(), reload()])
  }

  if (!project.folder)
    return (
      <p className="text-sm text-muted-foreground">
        This project has no library folder.{' '}
        <Link
          href={`/app/projects/${project.id}/settings`}
          className="font-medium text-primary hover:underline"
        >
          Choose one
        </Link>{' '}
        in its settings.
      </p>
    )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto text-sm text-muted-foreground">
          Files the project&apos;s threads save go in{' '}
          <span className="font-mono text-foreground">{project.folder}/</span>.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setCreating(creating === 'folder' ? null : 'folder')}
        >
          <FolderPlus aria-hidden />
          New folder
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setCreating(creating === 'file' ? null : 'file')}
        >
          <FilePlus aria-hidden />
          New file
        </Button>
        <Button size="sm" disabled={Boolean(uploading)} onClick={() => input.current?.click()}>
          <Upload aria-hidden />
          {uploading ? `Uploading ${uploading}…` : 'Upload'}
        </Button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(e) =>
            void upload(
              Array.from(e.target.files ?? []).map((file) => ({
                file,
                path: join(folder, file.name),
              })),
            )
          }
        />
      </div>
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      <LibraryBrowser
        tree={tree.data}
        folder={folder}
        home={project.folder}
        setFolder={(path) => {
          setCreating(null)
          setFolder(path)
        }}
        reload={async () => {
          await Promise.all([tree.reload(), reload()])
        }}
        upload={upload}
        teammates={teammates}
        admin={isAdmin(me)}
        creating={creating}
        setCreating={setCreating}
      />
    </div>
  )
}
