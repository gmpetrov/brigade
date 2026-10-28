'use client'
// Deleting a workspace or one's own account, for good: a section at the foot of its settings
// page, and a dialog that says what goes and asks for its name (or email) typed out first.
import { Trash2 } from 'lucide-react'
import Link from 'next/link'
import { useState, type ReactNode } from 'react'
import { useDashboard } from '@/components/dashboard'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, ApiError } from '@/lib/api'
import { DEMO } from '@/lib/demo/flag'
import { markSignedOut } from '@/lib/signed-in'

/** The section around a deletion: below everything else on its page. */
function DangerZone({ detail, children }: { detail: string; children: ReactNode }) {
  return (
    <section className="flex max-w-xl flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">Danger zone</h2>
        <p className="text-sm text-muted-foreground">{detail}</p>
      </div>
      <Card className="border-destructive/40 px-6 py-5">{children}</Card>
    </section>
  )
}

/** What the API refused with, and whether cancelling Brigade Cloud is what it waits for. */
type Failure = { message: string; billing: boolean }

const failureOf = (e: unknown): Failure => {
  const message = (e as Error).message
  return {
    message,
    billing: e instanceof ApiError && e.status === 409 && /Brigade Cloud/.test(message),
  }
}

function DeleteDialog({
  open,
  onOpenChange,
  title,
  description,
  goes,
  confirm,
  label,
  action,
  run,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  /** What is deleted with it, one line each. */
  goes: string[]
  /** What must be typed to confirm. */
  confirm: string
  label: ReactNode
  action: string
  run: () => Promise<void>
}) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure>()
  const matches = typed.trim().toLowerCase() === confirm.trim().toLowerCase()

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!matches || busy) return
    setBusy(true)
    setFailure(undefined)
    try {
      await run()
    } catch (e) {
      setFailure(failureOf(e))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Not while it is being deleted: the answer decides where to go.
        if (busy) return
        if (!next) {
          setTyped('')
          setFailure(undefined)
        }
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
            {goes.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">
            This cannot be undone. A workspace with Brigade Cloud must cancel it in Billing first,
            and can be deleted once the plan has ended.
          </p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="delete-confirm">{label}</Label>
            <Input
              id="delete-confirm"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
            />
          </div>
          {failure && (
            <p role="alert" className="text-sm text-destructive-text">
              {failure.message}
              {failure.billing && (
                <>
                  {' '}
                  <Link href="/app/billing" className="underline underline-offset-2">
                    Open Billing
                  </Link>
                </>
              )}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={!matches || busy}>
              {busy ? 'Deleting…' : action}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Settings › Workspace, for owners: delete the workspace, then go to another or to onboarding. */
export function DeleteWorkspace() {
  const { me } = useDashboard()
  const [open, setOpen] = useState(false)
  const workspace = me.workspaces.find((w) => w.id === me.activeWorkspaceId)
  // The demo has nothing of anyone's to delete.
  if (DEMO || me.role !== 'owner' || !workspace) return null
  const last = me.workspaces.length === 1
  return (
    <DangerZone detail="Only owners can delete a workspace.">
      <div className="flex items-center justify-between gap-4">
        <div className="grid gap-1 text-sm">
          <span className="font-medium">Delete this workspace</span>
          <span className="text-xs text-muted-foreground">
            Everything in {workspace.name} goes for good, for everyone in it.
          </span>
        </div>
        <Button variant="danger" onClick={() => setOpen(true)}>
          <Trash2 aria-hidden />
          Delete workspace
        </Button>
      </div>
      <DeleteDialog
        open={open}
        onOpenChange={setOpen}
        title={`Delete ${workspace.name}?`}
        description="Everything in this workspace is deleted for everyone in it:"
        goes={[
          'Its threads, tasks, schedules and every file in them',
          'Its library, memory, skills and projects',
          'Its teammates and their email addresses',
          'Its Apps, disconnected, and its secrets',
          'Its cloud computer, destroyed with its disk',
          'Its email domains, removed',
          ...(last ? ['Its organization, as it is the organization’s last workspace'] : []),
        ]}
        confirm={workspace.name}
        label={
          <span>
            Type <span className="font-semibold">{workspace.name}</span> to confirm
          </span>
        }
        action="Delete workspace"
        run={async () => {
          await api('/workspace', { method: 'DELETE', body: { name: workspace.name } })
          // The session is in another workspace now, or in none: then onboarding.
          window.location.href = '/app'
        }}
      />
    </DangerZone>
  )
}

/** Settings › Preferences: delete one's own account, then sign out to the landing page. */
export function DeleteAccount() {
  const { me } = useDashboard()
  const [open, setOpen] = useState(false)
  if (DEMO) return null
  return (
    <DangerZone detail="Your account, across every organization you are in.">
      <div className="flex items-center justify-between gap-4">
        <div className="grid gap-1 text-sm">
          <span className="font-medium">Delete my account</span>
          <span className="text-xs text-muted-foreground">
            You are signed out, and cannot sign in again with it.
          </span>
        </div>
        <Button variant="danger" onClick={() => setOpen(true)}>
          <Trash2 aria-hidden />
          Delete account
        </Button>
      </div>
      <DeleteDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete your account?"
        description="Your account is deleted for good, with:"
        goes={[
          'Every organization you are alone in, with all of its workspaces: their threads, files, library, teammates, Apps, cloud computer and email domains',
          'In organizations shared with others: the threads you started, with their files, your schedules and tasks, and the Apps you connected for yourself',
          'Your sign-ins, devices and notifications',
        ]}
        confirm={me.user.email}
        label={
          <span>
            Type your email address, <span className="font-semibold">{me.user.email}</span>, to
            confirm
          </span>
        }
        action="Delete account"
        run={async () => {
          await api('/me', { method: 'DELETE', body: { email: me.user.email } })
          markSignedOut()
          window.location.href = '/'
        }}
      />
    </DangerZone>
  )
}
