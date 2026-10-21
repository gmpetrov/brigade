'use client'
import Link from 'next/link'
import { useEffect, useState, type ReactNode } from 'react'
import { Cloud, EllipsisVertical, Laptop, Plus } from 'lucide-react'
import { isAdmin, timeAgo, useDashboard } from '@/components/dashboard'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { api, useApi, type Computer, type ComputersResponse } from '@/lib/api'
import { useLive } from '@/lib/use-live'
import { MAC_APP_URL } from '@/lib/mac-app'

type LinkCode = { code: string; expiresAt: string; command: string; appLink?: string }

const STATUS: Record<Computer['status'], string> = {
  pending: 'Waiting for its runner',
  creating: 'Setting up',
  starting: 'Starting',
  running: 'Online',
  stopped: 'Asleep · wakes on the next message',
  error: 'Error',
  destroyed: 'Removed',
}

/** "Online", and whether its runner is up to date ("Update waiting": it updates once idle). */
function online(c: Computer) {
  if (c.runnerUpdate === 'current') return 'Online · Up to date'
  if (c.runnerUpdate === 'waiting') return 'Online · Update waiting'
  return 'Online'
}

function Tile({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-11 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground [&_svg]:size-5',
        className,
      )}
    >
      {children}
    </span>
  )
}

export default function Computers() {
  const { me } = useDashboard()
  const computers = useApi<ComputersResponse>('/computers')
  const [link, setLink] = useState<LinkCode>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  // On a Mac, the app links this computer; elsewhere, the command in a terminal.
  const [mac, setMac] = useState(false)

  useLive((message) => {
    if (message.type === 'computer.updated') void computers.reload()
  })

  async function act<T>(fn: () => Promise<T>) {
    setBusy(true)
    setError(undefined)
    try {
      return await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
      void computers.reload()
    }
  }

  const getLink = () =>
    act(async () => setLink(await api<LinkCode>('/computers/link-code', { method: 'POST' })))

  useEffect(() => {
    setMac(/Mac/.test(navigator.userAgent) && !/iPhone|iPad/.test(navigator.userAgent))
    // "Connect this computer…" in Brigade.app's menu opens ?desktop=1: the code is what it came for.
    if (new URLSearchParams(window.location.search).has('desktop')) void getLink()
    // Once, on load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const all = computers.data?.computers ?? []
  const cloud = all.find((c) => c.kind === 'cloud')
  const mine = all.filter((c) => c.kind === 'member_machine')

  // Start and Stop, out of the way.
  const menuItems: { label: string; onSelect: () => void; danger?: boolean }[] = []
  // With billing on, the cloud computer comes with the workspace's Cloud plan.
  const planNeeded = !!computers.data?.billing && !computers.data.cloudEntitled
  if (cloud?.status === 'stopped' && !planNeeded)
    menuItems.push({
      label: 'Start',
      onSelect: () => void act(() => api(`/computers/${cloud.id}/start`, { method: 'POST' })),
    })
  if (cloud?.status === 'running' && isAdmin(me))
    menuItems.push({
      label: 'Stop',
      danger: true,
      onSelect: () => void act(() => api(`/computers/${cloud.id}/stop`, { method: 'POST' })),
    })

  /** "Online" in green, anything else in grey. */
  const status = (online: boolean, label: string, who: string) => (
    <span className="flex items-center gap-2 text-sm text-muted-foreground">
      <span
        aria-hidden
        className={cn(
          'size-2 shrink-0 rounded-full',
          online ? 'bg-success' : 'bg-muted-foreground/40',
        )}
      />
      {label} · {who}
    </span>
  )

  const cloudOnline = cloud?.status === 'running' && cloud.online

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-extrabold tracking-tight">Computers</h1>
        {error && <p className="text-sm text-destructive-text">{error}</p>}
      </header>

      <Card className="gap-0 divide-y py-0">
        <div className="flex items-center gap-4 px-5 py-4">
          <Tile className="bg-primary/15 text-primary">
            <Cloud />
          </Tile>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="font-semibold">Cloud computer</span>
            {cloud ? (
              status(
                !!cloudOnline,
                cloudOnline
                  ? online(cloud)
                  : cloud.status === 'running'
                    ? 'Not connected'
                    : planNeeded && cloud.status === 'stopped'
                      ? 'Asleep · its Brigade Cloud plan ended'
                      : STATUS[cloud.status],
                'shared',
              )
            ) : (
              <span className="text-sm text-muted-foreground">
                {!computers.data?.cloudAvailable
                  ? 'Not configured on this Brigade server'
                  : planNeeded
                    ? 'Comes with Brigade Cloud, $99 a month'
                    : isAdmin(me)
                      ? 'Not created yet'
                      : 'Ask an owner or admin to create it'}
              </span>
            )}
          </div>
          {computers.data?.cloudAvailable && planNeeded && (
            <Button asChild variant="outline">
              <Link href="/app/billing">{cloud ? 'Subscribe' : 'See plan'}</Link>
            </Button>
          )}
          {!cloud && computers.data?.cloudAvailable && !planNeeded && isAdmin(me) && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void act(() => api('/computers/cloud', { method: 'POST' }))}
            >
              Create
            </Button>
          )}
          {cloud && menuItems.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={busy}
                  aria-label="Cloud computer options"
                >
                  <EllipsisVertical aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                {menuItems.map((item) => (
                  <DropdownMenuItem
                    key={item.label}
                    variant={item.danger ? 'destructive' : 'default'}
                    onSelect={item.onSelect}
                  >
                    {item.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {mine.map((c) => (
          <div
            key={c.id}
            className="flex items-center gap-4 px-5 py-4"
            title={[c.runner?.platform, c.runner?.version && `runner ${c.runner.version}`]
              .filter(Boolean)
              .join(' · ')}
          >
            <Tile>
              <Laptop />
            </Tile>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate font-semibold">{c.name}</span>
              {status(
                c.online,
                c.online
                  ? online(c)
                  : c.runner?.lastSeenAt
                    ? `Last seen ${timeAgo(c.runner.lastSeenAt)}`
                    : 'Offline',
                'only you',
              )}
            </div>
          </div>
        ))}

        <div className="flex flex-col gap-4 px-5 py-4">
          <button
            type="button"
            disabled={busy || !!link}
            onClick={() => void getLink()}
            className="flex items-center gap-4 text-left disabled:cursor-default"
          >
            <Tile className="border border-dashed bg-transparent">
              <Plus />
            </Tile>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="font-semibold">{mac ? 'Link this Mac' : 'Link your machine'}</span>
              <span className="text-sm text-muted-foreground">
                {link
                  ? `${
                      mac && link.appLink
                        ? 'Install Brigade for Mac, then open this link in it.'
                        : 'Run this in a terminal on your Mac or Linux machine.'
                    } The code works once and expires at ${new Date(link.expiresAt).toLocaleTimeString()}.`
                  : 'A teammate there acts as you and asks before each write or command'}
              </span>
            </span>
          </button>
          {link &&
            (mac && link.appLink ? (
              <>
                <div className="flex flex-wrap gap-2">
                  <Button asChild variant="outline">
                    <a href={MAC_APP_URL}>Download Brigade for Mac</a>
                  </Button>
                  <Button asChild>
                    <a href={link.appLink}>Open in Brigade</a>
                  </Button>
                </div>
                <details className="text-sm text-muted-foreground">
                  <summary className="cursor-pointer">Or run it in a terminal</summary>
                  <pre className="mt-2 rounded-md border bg-muted p-4 font-mono text-sm break-all whitespace-pre-wrap text-foreground">
                    {link.command}
                  </pre>
                </details>
              </>
            ) : (
              <pre className="rounded-md border bg-muted p-4 font-mono text-sm break-all whitespace-pre-wrap">
                {link.command}
              </pre>
            ))}
        </div>
      </Card>
    </div>
  )
}
