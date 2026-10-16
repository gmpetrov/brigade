'use client'
import { siteUrl, projectLogoPath, type SiteBrief, type SiteInfo } from '@brigade/contracts'
import { Check, ChevronDown, X } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, type FormEvent } from 'react'
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
import { API_URL } from '@/lib/config'
import { cn } from '@/lib/utils'

/** The project's logo, else its icon, else the first letter of its name. */
export function ProjectIcon({
  project,
  className,
}: {
  project: Pick<ProjectRef, 'name' | 'icon'> & { id?: string; logo?: string | null }
  className?: string
}) {
  const logo =
    project.id && project.logo ? projectLogoPath({ id: project.id, logo: project.logo }) : null
  const [failed, setFailed] = useState<string | null>(null)
  if (logo && failed !== logo)
    return (
      <span
        aria-hidden
        className={cn(
          // White behind it: most logos are drawn for a light page.
          'flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-sm border bg-white',
          className,
        )}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- a stored logo, through the API */}
        <img
          src={`${API_URL}/api${logo}`}
          alt=""
          className="size-full object-contain"
          onError={() => setFailed(logo)}
        />
      </span>
    )
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

/** A violet dot that pulses, and what is going on: no spinners. */
function Pending({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span aria-hidden className="size-1.5 flex-none animate-pulse rounded-full bg-primary" />
      {children}
    </span>
  )
}

/** Worth reading: it looks like a site, "acme.com" at least. */
const looksLikeSite = (text: string) =>
  /^(https?:\/\/)?[^\s/]+\.[a-z]{2,}(\/\S*)?$/i.test(text.trim())

/**
 * Name a project and say what it is; it opens once made. Given its website, the
 * name and logo come from the site, and the brief from a short run on the
 * member's own account. Nothing a person typed is replaced.
 */
export function NewProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const { reloadProjects } = useDashboard()
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [brief, setBrief] = useState('')
  const [logo, setLogo] = useState<string | null>(null)
  /** What the site filled in, so a later read replaces only that. */
  const filled = useRef({ name: '', brief: '' })
  const [reading, setReading] = useState<string | null>(null)
  const [writing, setWriting] = useState(false)
  const [note, setNote] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  /** The address being read: an answer for an older one is dropped. */
  const current = useRef('')

  function reset() {
    setUrl('')
    setName('')
    setBrief('')
    setLogo(null)
    setNote(undefined)
    setReading(null)
    setWriting(false)
    filled.current = { name: '', brief: '' }
    current.current = ''
  }

  // Read the site once the address has settled for a moment.
  useEffect(() => {
    const address = url.trim()
    if (!open || !looksLikeSite(address)) return
    const site = siteUrl(address)
    if (site === current.current) return
    const timer = setTimeout(() => void read(site), 600)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the address changes
  }, [url, open])

  async function read(site: string) {
    current.current = site
    setReading(new URL(site).hostname)
    setWriting(false)
    setNote(undefined)
    let info: SiteInfo
    try {
      info = await api<SiteInfo>('/projects/site', { body: { url: site } })
    } catch (e) {
      if (current.current !== site) return
      setReading(null)
      setNote((e as Error).message)
      return
    }
    if (current.current !== site) return
    setReading(null)
    setLogo(info.logo)
    setName((n) => {
      if (!info.name || (n.trim() && n !== filled.current.name)) return n
      filled.current.name = info.name
      return info.name
    })
    const fill = (text: string) =>
      setBrief((b) => {
        if (b.trim() && b !== filled.current.brief) return b
        filled.current.brief = text
        return text
      })
    setWriting(true)
    try {
      const answer = await api<SiteBrief>('/projects/site/brief', { body: { url: info.url } })
      if (current.current !== site) return
      if (answer.brief !== null) fill(answer.brief)
      else {
        if (info.description) fill(info.description)
        setNote(
          `The brief was not written for you. ${answer.reason}${info.description ? ' Here is the site’s own description.' : ''}`,
        )
      }
    } catch (e) {
      if (current.current !== site) return
      if (info.description) fill(info.description)
      setNote((e as Error).message)
    } finally {
      if (current.current === site) setWriting(false)
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) return setError('Name the project')
    setBusy(true)
    setError(undefined)
    try {
      const project = await api<{ id: string }>('/projects', {
        body: {
          name: name.trim(),
          brief: brief.trim(),
          ...(looksLikeSite(url) && { url: siteUrl(url) }),
          ...(logo && { logo }),
        },
      })
      await reloadProjects()
      onOpenChange(false)
      reset()
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
            <Label htmlFor="project-url">
              Website <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="project-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="acme.com"
              inputMode="url"
              autoComplete="url"
              maxLength={2000}
              autoFocus
            />
            {reading && <Pending>Reading {reading}…</Pending>}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="project-name">Name</Label>
            <div className="flex items-center gap-2">
              {logo && <ProjectLogoPreview logo={logo} onRemove={() => setLogo(null)} />}
              <Input
                id="project-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  setError(undefined)
                }}
                placeholder="Acme web"
                maxLength={80}
              />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="project-brief">Brief</Label>
            <Textarea
              id="project-brief"
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder={writing ? '' : 'Customer storefront. Next.js on acme/web, Stripe live.'}
              rows={3}
              maxLength={5000}
            />
            {writing ? (
              <Pending>Writing the brief from the site with your account…</Pending>
            ) : (
              <p className="text-xs text-muted-foreground">
                {note ??
                  'Given to every thread in the project. You can add repositories once it is made.'}
              </p>
            )}
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

/** A logo about to be kept, with a way back to the letter. */
export function ProjectLogoPreview({ logo, onRemove }: { logo: string; onRemove: () => void }) {
  return (
    <span className="group relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-white">
      {/* eslint-disable-next-line @next/next/no-img-element -- a data URL */}
      <img src={logo} alt="Logo" className="size-full object-contain" />
      <button
        type="button"
        onClick={onRemove}
        title="Use the letter instead"
        aria-label="Remove the logo"
        className="absolute inset-0 flex items-center justify-center bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <X className="size-4" aria-hidden />
      </button>
    </span>
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
