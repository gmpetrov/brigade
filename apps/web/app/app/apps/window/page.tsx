'use client'
// An installed app's window in Brigade.app (docs/apps.md, Installed apps;
// apps/desktop/src/app-windows.ts): the app alone, without the dashboard around it. The window
// names the app by its document id (`id`, its index.html), which stays when the app moves in the
// library; `path` is only where it was. Every call of this page is made in `workspace`, the one
// the app was installed from (lib/api.ts pinnedWorkspace), whichever the session shows.
import { toolFolderOf, type LibraryFile } from '@brigade/contracts'
import { useSearchParams } from 'next/navigation'
import { Suspense, useCallback, useEffect, useState } from 'react'
import { useDashboard } from '@/components/dashboard'
import { ToolWindow } from '@/components/tool-view'
import { Button } from '@/components/ui/button'
import { ApiError, api } from '@/lib/api'
import { appWindowBridge } from '@/lib/desktop-bridge'

type Found = { folder: string } | { gone: string; deleted?: boolean } | { failed: string }

function Message({ children, action }: { children: string; action?: React.ReactNode }) {
  return (
    <main className="flex h-dvh flex-col items-center justify-center gap-4 bg-background p-6">
      <p className="max-w-sm text-center text-sm text-muted-foreground">{children}</p>
      {action}
    </main>
  )
}

/** The window's own Uninstall: Brigade.app asks, then removes the app's icon and closes this. */
function UninstallButton() {
  const bridge = appWindowBridge()
  if (!bridge?.apps.uninstall) return null
  return (
    <Button type="button" variant="outline" onClick={() => void bridge.apps.uninstall?.()}>
      Uninstall
    </Button>
  )
}

function AppWindow() {
  const { me } = useDashboard()
  const params = useSearchParams()
  const id = params.get('id') ?? ''
  const workspace = params.get('workspace')
  const [found, setFound] = useState<Found>()
  const [attempt, setAttempt] = useState(0)
  const again = useCallback(() => setAttempt((n) => n + 1), [])
  // The API this page reached did not make its calls in the app's workspace (one from before
  // that existed): nothing is shown, rather than another workspace's data.
  const unbound = !!workspace && workspace !== me.activeWorkspaceId

  useEffect(() => {
    if (unbound) return
    let live = true
    setFound(undefined)
    if (!id) {
      setFound({ gone: 'This app could not be found.' })
      return
    }
    // By its id only: a folder it once had may hold another app now.
    api<LibraryFile>(`/library/${encodeURIComponent(id)}`).then(
      (file) => {
        const folder = toolFolderOf(file.path)
        if (live) setFound(folder ? { folder } : { gone: 'This file is no longer an app.' })
      },
      (error) => {
        if (!live) return
        if (error instanceof ApiError && error.status === 404)
          setFound({ gone: 'This app was deleted from the library.', deleted: true })
        else setFound({ failed: 'Brigade could not be reached to open this app.' })
      },
    )
    return () => {
      live = false
    }
  }, [unbound, id, attempt])

  if (unbound)
    return <Message>This app is in another workspace than this window can reach.</Message>
  if (!found) return null
  if (!(me.features?.includes('apps') ?? false))
    return <Message>Apps are not available in this workspace.</Message>
  if ('failed' in found)
    return (
      <Message
        action={
          <Button type="button" onClick={again}>
            Try again
          </Button>
        }
      >
        {found.failed}
      </Message>
    )
  if ('gone' in found)
    return <Message action={found.deleted ? <UninstallButton /> : undefined}>{found.gone}</Message>
  return <ToolWindow folder={found.folder} appId={id} onMoved={again} />
}

export default function AppWindowPage() {
  return (
    <Suspense>
      <AppWindow />
    </Suspense>
  )
}
