'use client'
import { Check, ChevronDown } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { useDashboard } from '@/components/dashboard'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { api, type ProjectRef } from '@/lib/api'
import { cn } from '@/lib/utils'

/** The project's icon, else the first letter of its name. */
export function ProjectIcon({
  project,
  className,
}: {
  project: Pick<ProjectRef, 'name' | 'icon'>
  className?: string
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded-sm border bg-secondary text-[0.6875rem] font-bold text-secondary-foreground',
        className,
      )}
    >
      {project.icon || project.name.trim().charAt(0).toUpperCase()}
    </span>
  )
}

/** The project a row belongs to, as a small label; nothing when it has none. */
export function ProjectTag({ project }: { project: ProjectRef | null | undefined }) {
  if (!project) return null
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground">
      <ProjectIcon project={project} className="size-4 text-[0.625rem]" />
      <span className="truncate">{project.name}</span>
    </span>
  )
}

/**
 * Pick a project: "none" for no project. With `all`, an "All projects" choice
 * too (value ""), for filtering lists. Archived projects are left out unless
 * one is the current value.
 */
export function ProjectSelect({
  value,
  onChange,
  all = false,
  none = true,
  id,
  className,
}: {
  value: string
  onChange: (value: string) => void
  all?: boolean
  /** Offer "No project". */
  none?: boolean
  id?: string
  className?: string
}) {
  const { projects } = useDashboard()
  const shown = projects.filter((p) => !p.archivedAt || p.id === value)
  return (
    <Select value={value || 'all'} onValueChange={(v) => onChange(v === 'all' ? '' : v)}>
      <SelectTrigger id={id} className={cn('w-full sm:w-56', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {all && <SelectItem value="all">All projects</SelectItem>}
        {none && <SelectItem value="none">No project</SelectItem>}
        {shown.length > 0 && (all || none) && <SelectSeparator />}
        {shown.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            <ProjectIcon project={p} className="size-4 text-[0.625rem]" />
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** A list page's project filter, shown only once the workspace has a project. */
export function ProjectFilter({
  value,
  onChange,
  none = true,
}: {
  value: string
  onChange: (value: string) => void
  /** Offer "No project", where the list can tell. */
  none?: boolean
}) {
  const { projects } = useDashboard()
  if (projects.length === 0) return null
  return (
    <div className="flex items-center gap-2">
      <Label htmlFor="project-filter" className="sr-only">
        Project
      </Label>
      <ProjectSelect id="project-filter" value={value} onChange={onChange} all none={none} />
    </div>
  )
}

/** Name a project and say what it is; it opens once made. */
export function NewProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const { reloadProjects } = useDashboard()
  const [name, setName] = useState('')
  const [brief, setBrief] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) return setError('Name the project')
    setBusy(true)
    setError(undefined)
    try {
      const project = await api<{ id: string }>('/projects', {
        body: { name: name.trim(), brief: brief.trim() },
      })
      await reloadProjects()
      onOpenChange(false)
      setName('')
      setBrief('')
      router.push(`/app/projects/${project.id}`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              A project groups threads, tasks, library files and repositories. Your teammates work
              across all projects; threads started in one get its brief and memory.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setError(undefined)
              }}
              placeholder="Acme web"
              maxLength={80}
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="project-brief">Brief</Label>
            <Textarea
              id="project-brief"
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="Customer storefront. Next.js on acme/web, Stripe live."
              rows={3}
              maxLength={5000}
            />
            <p className="text-xs text-muted-foreground">
              Given to every thread in the project. You can add repositories once it is made.
            </p>
          </div>
          {error && <p className="text-sm text-destructive-text">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Which project a thread is in, and a menu to move it. Any member may: it only
 * organizes. Its next turn gets the new project's context.
 */
export function ThreadProjectMenu({
  threadId,
  project,
  onMoved,
}: {
  threadId: string
  project: ProjectRef | null
  onMoved: () => void
}) {
  const { projects } = useDashboard()
  const [error, setError] = useState<string>()
  const pickable = projects.filter((p) => !p.archivedAt)
  if (!project && pickable.length === 0) return null

  async function move(projectId: string | null) {
    setError(undefined)
    try {
      await api(`/threads/${threadId}/project`, { method: 'PUT', body: { projectId } })
      onMoved()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md px-1 hover:bg-accent hover:text-foreground"
            title={error ?? 'Move to a project'}
          >
            {project ? (
              <>
                <ProjectIcon project={project} className="size-4 text-[0.625rem]" />
                <span className="font-medium text-foreground">{project.name}</span>
              </>
            ) : (
              'No project'
            )}
            <ChevronDown className="size-3.5 opacity-60" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel className="text-xs text-muted-foreground">Move to</DropdownMenuLabel>
          {pickable.map((p) => (
            <DropdownMenuItem key={p.id} onSelect={() => void move(p.id)}>
              <ProjectIcon project={p} className="size-4 text-[0.625rem]" />
              <span className="flex-1 truncate">{p.name}</span>
              {p.id === project?.id && <Check className="text-primary" aria-hidden />}
            </DropdownMenuItem>
          ))}
          {project && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void move(null)}>
                Out of the project
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
