'use client'
// Workspace: its name and logo, seen by every member in the sidebar and the
// workspace menu. Owners and admins change them: a click on the logo changes
// it, and each change saves on its own. The others see them here.
import { Pencil } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { isAdmin, useDashboard, WorkspaceMark } from '@/components/dashboard'
import { shrinkLogo } from '@/components/projects'
import { Card } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'

type Status = { saving: true } | { saved: true } | { error: string } | null

export default function WorkspacePage() {
  const { me, reloadMe } = useDashboard()
  const admin = isAdmin(me)
  const workspace = me.workspaces.find((w) => w.id === me.activeWorkspaceId)
  const [name, setName] = useState(workspace?.name ?? '')
  /** A logo picked and still saving, shown at once. */
  const [pending, setPending] = useState<string>()
  const [status, setStatus] = useState<Status>(null)
  const file = useRef<HTMLInputElement>(null)
  const editing = useRef(false)
  /** One change at a time, in the order they were made. */
  const queue = useRef<Promise<unknown>>(Promise.resolve())

  // A change made elsewhere shows, unless the name is being edited here.
  useEffect(() => {
    if (!editing.current) setName(workspace?.name ?? '')
  }, [workspace?.name])

  // "Saved" shows for a moment, then goes.
  useEffect(() => {
    if (!status || !('saved' in status)) return
    const timer = setTimeout(() => setStatus(null), 2500)
    return () => clearTimeout(timer)
  }, [status])

  if (!workspace) return null

  function save(body: { name?: string; logo?: string | null }) {
    setStatus({ saving: true })
    const run = queue.current.then(async () => {
      try {
        await api('/workspace', { method: 'PATCH', body })
        await reloadMe()
        setStatus({ saved: true })
      } catch (e) {
        setStatus({ error: (e as Error).message })
        if (body.name !== undefined) setName(workspace?.name ?? '')
      } finally {
        if (body.logo !== undefined) setPending(undefined)
      }
    })
    queue.current = run
  }

  function saveName() {
    editing.current = false
    const next = name.trim()
    if (!next) return setName(workspace!.name)
    if (next !== workspace!.name) save({ name: next })
  }

  function pickLogo(picked: File | undefined) {
    if (!picked) return
    const reader = new FileReader()
    reader.onload = async () => {
      const shrunk = await shrinkLogo(String(reader.result)).catch(() => null)
      if (!shrunk)
        return setStatus({ error: 'That image cannot be a logo: try a PNG or an SVG under 256 KB' })
      setPending(shrunk)
      save({ logo: shrunk })
    }
    reader.readAsDataURL(picked)
  }

  const mark = pending ? (
    <span aria-hidden className="flex size-16 overflow-hidden rounded-xl">
      {/* eslint-disable-next-line @next/next/no-img-element -- a data URL, still saving */}
      <img src={pending} alt="" className="size-full object-cover" />
    </span>
  ) : (
    <WorkspaceMark
      workspace={workspace}
      className="size-16 rounded-xl bg-primary text-2xl text-primary-foreground"
    />
  )
  /** The pencil on the logo: a click changes it. */
  const editable = (
    <span className="relative block">
      {mark}
      <span className="absolute -right-1.5 -bottom-1.5 flex size-6 items-center justify-center rounded-full border bg-card text-muted-foreground transition-colors group-hover:text-foreground">
        <Pencil className="size-3" aria-hidden />
      </span>
    </span>
  )
  const trigger =
    'group rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card'

  return (
    <div className="flex flex-col gap-7">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-extrabold tracking-tight">Workspace</h1>
        <p className="max-w-prose text-muted-foreground">
          General settings for this workspace. {!admin && 'Only owners and admins can change them.'}
        </p>
      </header>

      <Card className="max-w-xl flex-row items-center gap-5 px-6 py-5">
        {!admin ? (
          mark
        ) : workspace.logo || pending ? (
          <DropdownMenu>
            <DropdownMenuTrigger className={trigger} aria-label="Change the logo">
              {editable}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => file.current?.click()}>
                Upload a new logo
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => save({ logo: null })}>
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <button
            type="button"
            className={trigger}
            aria-label="Upload a logo"
            onClick={() => file.current?.click()}
          >
            {editable}
          </button>
        )}
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/x-icon,image/svg+xml"
          className="hidden"
          onChange={(e) => {
            pickLogo(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Label htmlFor="workspace-name">Name</Label>
          <Input
            id="workspace-name"
            value={name}
            maxLength={80}
            disabled={!admin}
            onFocus={() => (editing.current = true)}
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                setName(workspace.name)
                editing.current = false
                requestAnimationFrame(() => (e.target as HTMLInputElement).blur())
              }
            }}
          />
        </div>
      </Card>
      {status && (
        <p
          role="status"
          className={
            'error' in status ? 'text-sm text-destructive-text' : 'text-sm text-muted-foreground'
          }
        >
          {'error' in status ? status.error : 'saving' in status ? 'Saving…' : 'Saved'}
        </p>
      )}
    </div>
  )
}
