'use client'
// An installed app's window in Brigade.app (docs/apps.md, Installed apps;
// apps/desktop/src/app-windows.ts): the app alone, without the dashboard around it. The window
// names the app by its document id (`id`, its index.html), which stays when the app moves in the
// library, and by the folder it had (`path`). `workspace`, the one it was installed from, is
// switched to by the dashboard's shell first (components/dashboard.tsx).
import { toolFolderOf, type LibraryFile } from '@brigade/contracts'
import { useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useState } from 'react'
import { useDashboard } from '@/components/dashboard'
import { ToolWindow } from '@/components/tool-view'
import { ApiError, api } from '@/lib/api'
import { hasApps } from '@/lib/apps-feature'

type Found = { folder: string } | { gone: string }

function Message({ children }: { children: string }) {
  return (
    <main className="flex h-dvh items-center justify-center bg-background p-6">
      <p className="max-w-sm text-center text-sm text-muted-foreground">{children}</p>
    </main>
  )
}

function AppWindow() {
  const { me } = useDashboard()
  const params = useSearchParams()
  const path = params.get('path') ?? ''
  const id = params.get('id') ?? ''
  const workspace = params.get('workspace')
  // Another workspace's app: the shell switches to it and loads the page again.
  const elsewhere = !!workspace && workspace !== me.activeWorkspaceId
  const member = !workspace || me.workspaces.some((w) => w.id === workspace)
  const [found, setFound] = useState<Found>()

  useEffect(() => {
    if (elsewhere) return
    let live = true
    const fallback = toolFolderOf(path)
    if (!id) {
      setFound(fallback ? { folder: fallback } : { gone: 'This app could not be found.' })
      return
    }
    api<LibraryFile>(`/library/${encodeURIComponent(id)}`).then(
      (file) => {
        const folder = toolFolderOf(file.path)
        if (live) setFound(folder ? { folder } : { gone: 'This file is no longer an app.' })
      },
      (error) => {
        if (!live) return
        if (error instanceof ApiError && error.status === 404)
          setFound({ gone: 'This app was deleted. Uninstall it from its menu in the Dock.' })
        // Not reachable now: the folder it had.
        else setFound(fallback ? { folder: fallback } : { gone: 'This app could not be found.' })
      },
    )
    return () => {
      live = false
    }
  }, [elsewhere, id, path])

  if (!member) return <Message>You are no longer a member of the workspace this app is in.</Message>
  if (elsewhere || !found) return null
  if (!hasApps(me.features)) return <Message>Apps are not available in this workspace.</Message>
  if ('gone' in found) return <Message>{found.gone}</Message>
  return <ToolWindow folder={found.folder} />
}

export default function AppWindowPage() {
  return (
    <Suspense>
      <AppWindow />
    </Suspense>
  )
}
