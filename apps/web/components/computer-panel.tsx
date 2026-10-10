'use client'
import { Globe, ListOrdered, UserRound, X } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { StatusBadge, TeammateAvatar } from '@/components/dashboard'
import { DesktopScreen } from '@/components/desktop-preview'
import type { OpenFile } from '@/components/file-links'
import { Terminal } from '@/components/terminal'
import { ThreadOutputs, type ThreadOutput } from '@/components/thread-outputs'
import { Button } from '@/components/ui/button'
import { api, harnessLabel, type Teammate, type Thread } from '@/lib/api'

function Section({
  title,
  action,
  children,
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex min-h-8 items-center gap-2">
        <h2 className="flex-1 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  )
}

/**
 * The workspace computer beside a thread: its screen, a shell once this member
 * has control, and the thread's status. Takeover starts here; hand back is in
 * the thread, where the composer was. Below, what the thread made.
 */
export function ComputerPanel({
  thread,
  memberId,
  status,
  shell,
  onShell,
  expanded,
  onExpand,
  onChange,
  onClose,
  outputs,
  onOpenFile,
}: {
  thread: Thread
  memberId: string
  status: string
  shell: boolean
  onShell: (open: boolean) => void
  expanded: boolean
  onExpand: (expanded: boolean) => void
  onChange: () => void
  onClose: () => void
  /** What the thread made, newest first. */
  outputs: ThreadOutput[]
  onOpenFile: OpenFile
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const teammate = thread.teammate
  const mine = !!memberId && thread.controlledByMemberId === memberId
  const working = status === 'running' || status === 'starting'

  async function act(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(undefined)
    try {
      await fn()
      onChange()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const takeOver = (interrupt: boolean) =>
    void act(() => api(`/threads/${thread.id}/takeover`, { body: { interrupt } }))

  return (
    <aside
      data-desktop-panel
      className="mb-4 flex flex-col overflow-hidden rounded-xl border bg-card shadow-sm xl:fixed xl:inset-y-0 xl:right-0 xl:z-10 xl:mb-0 xl:w-(--desktop-w) xl:rounded-none xl:border-y-0 xl:border-r-0 xl:shadow-none"
      aria-label={`${teammate.name}'s computer`}
    >
      <div className="flex flex-nowrap items-center gap-3 border-b px-4 py-3">
        <TeammateAvatar
          teammate={{ name: teammate.name, harness: teammate.harness as Teammate['harness'] }}
          className="size-8"
        />
        <div className="min-w-0 flex-1">
          <strong className="block truncate text-sm font-semibold">{teammate.name}</strong>
          <span className="block truncate text-xs text-muted-foreground">
            {harnessLabel(teammate.harness)} on the workspace computer
          </span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label="Close computer panel"
          title="Close"
        >
          <X aria-hidden />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-4">
        <div className="flex flex-col gap-3">
          <DesktopScreen
            threadId={thread.id}
            teammateName={teammate.name}
            control={mine}
            expanded={expanded}
            onExpand={onExpand}
          />
          {thread.controlledByMemberId && !mine ? (
            <p className="text-sm text-muted-foreground">
              Another member has control. {teammate.name} continues when they hand it back.
            </p>
          ) : mine ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void act(() => api(`/teammates/${teammate.id}/browser`, { body: {} }))
                }
              >
                <Globe aria-hidden />
                Open {teammate.name}&apos;s browser
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-[1_1_14rem] text-sm text-muted-foreground">
                Take control to use the mouse, keyboard and a shell. {teammate.name} waits until you
                hand back.
              </p>
              <Button size="sm" disabled={busy} onClick={() => takeOver(false)}>
                Take control
              </Button>
              {working && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => takeOver(true)}
                  title={`Stop ${teammate.name}'s current turn first`}
                >
                  Stop and take control
                </Button>
              )}
            </div>
          )}
          {error && <p className="text-sm text-destructive-text">{error}</p>}
        </div>

        {mine && shell && (
          <Section
            title="Shell"
            action={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => onShell(false)}
                aria-label="Close shell"
              >
                <X aria-hidden />
              </Button>
            }
          >
            <Terminal sessionId={thread.id} />
            <p className="text-xs text-muted-foreground">
              In the thread&apos;s directory, as {teammate.name}. Commands you run are recorded in
              the run log.
            </p>
          </Section>
        )}

        <Section title="Status">
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <StatusBadge status={status} />
            {mine
              ? `${teammate.name} waits for you to hand back.`
              : working
                ? `${teammate.name} is working.`
                : null}
          </div>
          {thread.task && (
            <p className="truncate text-sm">
              <span className="text-muted-foreground">Task </span>
              {thread.task.title}
            </p>
          )}
        </Section>

        {outputs.length > 0 && (
          <Section title={`Outputs · ${outputs.length}`}>
            <ThreadOutputs outputs={outputs} onOpen={onOpenFile} />
          </Section>
        )}

        <Section title={`About ${teammate.name}`}>
          <div className="flex flex-col gap-2">
            <Button asChild variant="outline" className="justify-start">
              <Link href={`/app/teammates/${teammate.id}`}>
                <UserRound aria-hidden />
                Profile
              </Link>
            </Button>
            <Button asChild variant="outline" className="justify-start">
              <Link href={`/app/threads/${thread.id}/log`}>
                <ListOrdered aria-hidden />
                Run log
              </Link>
            </Button>
          </div>
        </Section>
      </div>
    </aside>
  )
}
