'use client'
import { useState, type ReactNode } from 'react'
import { Cloud, Laptop, Play, Monitor, Terminal, TriangleAlert } from 'lucide-react'
import { isAdmin, timeAgo, useDashboard } from '@/components/dashboard'
import { StatusBadge, type StatusTone } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { api, useApi, type Computer, type ComputersResponse } from '@/lib/api'
import { useLive } from '@/lib/use-live'

type LinkCode = { code: string; expiresAt: string; command: string }

const STATUS: Record<Computer['status'], { label: string; tone: StatusTone }> = {
  pending: { label: 'waiting for its runner', tone: 'neutral' },
  creating: { label: 'setting up', tone: 'warning' },
  starting: { label: 'starting', tone: 'warning' },
  running: { label: 'running', tone: 'success' },
  stopped: { label: 'stopped, starts on demand', tone: 'neutral' },
  error: { label: 'error', tone: 'destructive' },
  destroyed: { label: 'removed', tone: 'neutral' },
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

  const all = computers.data?.computers ?? []
  const cloud = all.find((c) => c.kind === 'cloud')
  const mine = all.filter((c) => c.kind === 'member_machine')

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-extrabold tracking-tight">Computers</h1>
        {error && <p className="text-sm text-destructive-text">{error}</p>}
      </header>

      <section aria-labelledby="workspace-computer">
        <Card className="gap-4 p-5">
          <div className="flex flex-wrap items-center gap-4">
            <Tile className="bg-primary/15 text-primary">
              <Cloud />
            </Tile>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 id="workspace-computer" className="text-lg font-bold tracking-tight">
                  Workspace computer
                </h2>
                {cloud && (
                  <StatusBadge
                    status={cloud.status}
                    tone={STATUS[cloud.status].tone}
                    label={STATUS[cloud.status].label}
                  />
                )}
              </div>
              {cloud && (
                <span className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span
                    aria-hidden
                    className={cn(
                      'size-2 rounded-full',
                      cloud.online ? 'bg-success' : 'bg-muted-foreground/40',
                    )}
                  />
                  {cloud.online ? 'Connected' : 'Not connected'}
                </span>
              )}
            </div>
            {cloud && (
              <div className="flex flex-wrap items-center gap-2">
                {cloud.status === 'stopped' && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void act(() => api(`/computers/${cloud.id}/start`, { method: 'POST' }))
                    }
                  >
                    <Play />
                    Start
                  </Button>
                )}
                {cloud.status === 'running' && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        const { url } = await api<{ url: string }>(
                          `/computers/${cloud.id}/desktop`,
                          { method: 'POST' },
                        )
                        window.open(url, '_blank', 'noopener')
                      })
                    }
                  >
                    <Monitor />
                    Open desktop
                  </Button>
                )}
                {isAdmin(me) && cloud.status === 'running' && (
                  <Button
                    variant="danger"
                    disabled={busy}
                    onClick={() =>
                      void act(() => api(`/computers/${cloud.id}/stop`, { method: 'POST' }))
                    }
                  >
                    Stop
                  </Button>
                )}
              </div>
            )}
          </div>

          <p className="text-sm text-muted-foreground">
            The workspace&apos;s own cloud computer. Any member can run threads on it. It stops
            after a while with nothing to do, and starts again on the next message.
          </p>
          <div className="flex gap-3 rounded-lg bg-warning/15 p-4 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <p>
              A workspace is one trust zone: its teammates are separated by Linux user, which is
              weaker than separate machines,{' '}
              <strong className="font-semibold">so keep sensitive work in its own workspace.</strong>
            </p>
          </div>

          {!cloud &&
            (computers.data?.cloudAvailable ? (
              isAdmin(me) ? (
                <div>
                  <Button
                    disabled={busy}
                    onClick={() => void act(() => api('/computers/cloud', { method: 'POST' }))}
                  >
                    Create the workspace computer
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Ask an owner or admin to create it.</p>
              )
            ) : (
              <p className="text-sm text-muted-foreground">
                Cloud computers are not configured on this Brigade server.
              </p>
            ))}
        </Card>
      </section>

      <section aria-labelledby="your-machines" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="your-machines" className="text-lg font-bold tracking-tight">
            Your machines
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            On your own machine, a teammate acts as you: it uses your files, your logins and your
            browser, so it asks before every write and every command. Only you can run threads on
            it.
          </p>
        </div>

        {mine.length > 0 && (
          <Card className="gap-0 divide-y py-0">
            {mine.map((c) => (
              <div key={c.id} className="flex items-center gap-4 px-5 py-4">
                <Tile>
                  <Laptop />
                </Tile>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="font-semibold">{c.name}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {[
                      c.runner?.platform,
                      c.runner?.version && `runner ${c.runner.version}`,
                      !c.online &&
                        c.runner?.lastSeenAt &&
                        `last seen ${timeAgo(c.runner.lastSeenAt)}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </div>
                <StatusBadge
                  status={c.online ? 'online' : 'offline'}
                  tone={c.online ? 'success' : 'neutral'}
                />
              </div>
            ))}
          </Card>
        )}

        <Card className="gap-4 border-dashed p-5 shadow-none">
          <div className="flex flex-wrap items-center gap-4">
            <Tile>
              <Terminal />
            </Tile>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <h3 className="font-semibold">Link your machine</h3>
              {link && (
                <p className="text-sm text-muted-foreground">
                  Run this in a terminal on your Mac or Linux machine. The code works once and
                  expires at {new Date(link.expiresAt).toLocaleTimeString()}.
                </p>
              )}
            </div>
            {!link && (
              <Button
                disabled={busy}
                onClick={() =>
                  void act(async () =>
                    setLink(await api<LinkCode>('/computers/link-code', { method: 'POST' })),
                  )
                }
              >
                Get the install command
              </Button>
            )}
          </div>
          {link && (
            <pre className="rounded-md border bg-muted p-4 font-mono text-sm break-all whitespace-pre-wrap">
              {link.command}
            </pre>
          )}
        </Card>
      </section>
    </div>
  )
}
