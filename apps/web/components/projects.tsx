'use client'
import {
  PROJECT_LOGO_MAX,
  projectLogoPath,
  siteUrl,
  type SiteBrief,
  type SiteInfo,
} from '@brigade/contracts'
import { Check, ChevronDown, X } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useRef, useState, type FormEvent } from 'react'
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
          'flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-sm',
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

/** Worth reading: it looks like a site, "acme.com" at least. */
const looksLikeSite = (text: string) =>
  /^(https?:\/\/)?[^\s/]+\.[a-z]{2,}(\/\S*)?$/i.test(text.trim())

/** Largest side a logo is kept at: it shows at 20 to 44 px. */
const LOGO_SIDE = 256

/**
 * A logo small enough to keep: a raster one larger than LOGO_SIDE, or heavier
 * than the API takes, drawn again at that size as a PNG. SVGs stay as they are.
 */
export async function shrinkLogo(dataUrl: string): Promise<string | null> {
  const heavy = dataUrl.length * 0.75 > PROJECT_LOGO_MAX
  if (dataUrl.startsWith('data:image/svg+xml')) return heavy ? null : dataUrl
  const image = new Image()
  image.src = dataUrl
  await image.decode().catch(() => undefined)
  const side = Math.max(image.naturalWidth, image.naturalHeight)
  if (!side) return heavy ? null : dataUrl
  if (side <= LOGO_SIDE && !heavy) return dataUrl
  const scale = Math.min(1, LOGO_SIDE / side)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
  canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height)
  const png = canvas.toDataURL('image/png')
  return png.length * 0.75 <= PROJECT_LOGO_MAX ? png : null
}

type Step = 'waiting' | 'active' | 'done' | 'missed'

/** One step of reading a site: a pulsing violet dot while it runs, no spinners. */
function StepLine({ state, children }: { state: Step; children: React.ReactNode }) {
  return (
    <li
      className={cn(
        'flex items-center gap-2.5 text-sm',
        state === 'waiting'
          ? 'text-muted-foreground/60'
          : state === 'active'
            ? 'text-foreground'
            : 'text-muted-foreground',
      )}
    >
      <span aria-hidden className="flex size-4 flex-none items-center justify-center">
        {state === 'done' ? (
          <Check className="size-4 text-primary" />
        ) : state === 'active' ? (
          <span className="size-2 animate-pulse rounded-full bg-primary" />
        ) : (
          <span className="size-1.5 rounded-full bg-muted-foreground/40" />
        )}
      </span>
      {children}
    </li>
  )
}

/** The shape of what is coming, while it is read. */
function Skeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-3 pt-1">
      <div className="flex items-center gap-2">
        <span className="size-9 flex-none animate-pulse rounded-md bg-muted" />
        <span className="h-9 flex-1 animate-pulse rounded-full bg-muted" />
      </div>
      <span className="h-20 animate-pulse rounded-2xl bg-muted" />
    </div>
  )
}

/**
 * Name a project and say what it is; it opens once made. Given its website,
 * only the address shows first; while the site is read and a short run on the
 * member's own account writes its name and brief and picks its logo, each step
 * shows; then the fields come, filled in, to edit. Nothing typed can be lost:
 * the fields are not there while they are being filled.
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
  const [stage, setStage] = useState<'url' | 'reading' | 'form'>('url')
  const [url, setUrl] = useState('')
  /** The address the fields were filled from: another one offers to read it. */
  const [readUrl, setReadUrl] = useState('')
  const [steps, setSteps] = useState<{ read: Step; logo: Step; write: Step }>({
    read: 'waiting',
    logo: 'waiting',
    write: 'waiting',
  })
  const [host, setHost] = useState('')
  const [name, setName] = useState('')
  const [brief, setBrief] = useState('')
  const [logo, setLogo] = useState<string | null>(null)
  const [note, setNote] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  /** The address being read: an answer for an older one, or after "fill it in myself", is dropped. */
  const current = useRef('')
  /** What the site gave so far, for "fill it in myself" mid-way. */
  const partial = useRef<SiteInfo | null>(null)

  function reset() {
    setStage('url')
    setUrl('')
    setReadUrl('')
    setName('')
    setBrief('')
    setLogo(null)
    setNote(undefined)
    setError(undefined)
    current.current = ''
    partial.current = null
  }

  function close(next: boolean) {
    onOpenChange(next)
    if (!next) reset()
  }

  /** Fill the fields and show them. */
  async function fill(values: { name: string | null; brief: string | null; logo: string | null }) {
    setName(values.name ?? '')
    setBrief(values.brief ?? '')
    setLogo(values.logo ? await shrinkLogo(values.logo).catch(() => null) : null)
    setStage('form')
  }

  async function read(address: string) {
    if (!looksLikeSite(address)) return setError('That does not look like a website')
    const site = siteUrl(address)
    current.current = site
    partial.current = null
    setHost(new URL(site).hostname.replace(/^www\./, ''))
    setError(undefined)
    setNote(undefined)
    setSteps({ read: 'active', logo: 'waiting', write: 'waiting' })
    setStage('reading')
    let info: SiteInfo
    try {
      info = await api<SiteInfo>('/projects/site', { body: { url: site } })
    } catch (e) {
      if (current.current !== site) return
      setStage('url')
      setError((e as Error).message)
      return
    }
    if (current.current !== site) return
    partial.current = info
    setReadUrl(address.trim())
    setSteps({ read: 'done', logo: info.logo ? 'done' : 'missed', write: 'active' })
    let answer: SiteBrief
    try {
      answer = await api<SiteBrief>('/projects/site/brief', { body: { url: info.url } })
    } catch (e) {
      answer = { brief: null, reason: (e as Error).message }
    }
    if (current.current !== site) return
    if (answer.brief !== null) {
      setSteps((s) => ({ ...s, write: 'done' }))
      await fill({
        name: answer.name ?? info.name,
        brief: answer.brief,
        logo: answer.logo ?? info.logo,
      })
    } else {
      setSteps((s) => ({ ...s, write: 'missed' }))
      setNote(
        `The brief was not written for you: ${answer.reason}${info.description ? ' Here is the site’s own description.' : ''}`,
      )
      await fill({ name: info.name, brief: info.description, logo: info.logo })
    }
  }

  /** Stop waiting: show the fields with what has come so far. */
  function fillMyself() {
    current.current = ''
    const info = partial.current
    void fill({
      name: info?.name ?? null,
      brief: info?.description ?? null,
      logo: info?.logo ?? null,
    })
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (stage === 'url') {
      if (url.trim()) void read(url)
      else setStage('form')
      return
    }
    if (stage !== 'form') return
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
      close(false)
      router.push(`/app/projects/${project.id}`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const urlField = (
    <div className="flex flex-col gap-2">
      <Label htmlFor="project-url">
        Website{' '}
        {stage === 'form' && <span className="font-normal text-muted-foreground">(optional)</span>}
      </Label>
      <div className="flex items-center gap-2">
        <Input
          id="project-url"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value)
            setError(undefined)
          }}
          onPaste={(e) => {
            // A pasted address is read at once.
            const pasted = e.clipboardData.getData('text').trim()
            if (stage === 'url' && looksLikeSite(pasted) && !url.trim()) {
              e.preventDefault()
              setUrl(pasted)
              void read(pasted)
            }
          }}
          placeholder="acme.com"
          inputMode="url"
          autoComplete="url"
          maxLength={2000}
          disabled={stage === 'reading'}
          autoFocus={stage === 'url'}
        />
        {stage === 'form' && looksLikeSite(url) && url.trim() !== readUrl && (
          <Button type="button" variant="outline" onClick={() => void read(url)}>
            Read it
          </Button>
        )}
      </div>
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              {stage === 'form'
                ? 'A project groups threads, tasks, library files and repositories. Threads started in one get its brief and memory.'
                : 'Give its website: its name, logo and brief are read from it with your account. You can change them before it is made.'}
            </DialogDescription>
          </DialogHeader>
          {urlField}
          {stage === 'reading' && (
            <>
              <ul className="flex flex-col gap-2" aria-live="polite">
                <StepLine state={steps.read}>
                  {steps.read === 'done' ? `Read ${host}` : `Reading ${host}…`}
                </StepLine>
                <StepLine state={steps.logo}>
                  {steps.logo === 'done'
                    ? 'Found its logos'
                    : steps.logo === 'missed'
                      ? 'No logo found'
                      : 'Finding its logo'}
                </StepLine>
                <StepLine state={steps.write}>
                  {steps.write === 'active'
                    ? 'Writing its name and brief with your account…'
                    : 'Writing its name and brief'}
                </StepLine>
              </ul>
              <Skeleton />
            </>
          )}
          {stage === 'form' && (
            <>
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
                    autoFocus={!readUrl}
                  />
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="project-brief">Brief</Label>
                <Textarea
                  id="project-brief"
                  value={brief}
                  onChange={(e) => setBrief(e.target.value)}
                  placeholder="Customer storefront. Next.js on acme/web, Stripe live."
                  rows={readUrl ? 6 : 3}
                  maxLength={5000}
                />
                <p className="text-xs text-muted-foreground">
                  {note ??
                    'Given to every thread in the project. You can add repositories once it is made.'}
                </p>
              </div>
            </>
          )}
          {error && <p className="text-sm text-destructive-text">{error}</p>}
          <DialogFooter className="items-center">
            {stage === 'url' && (
              <button
                type="button"
                onClick={() => setStage('form')}
                className="mr-auto text-sm text-muted-foreground hover:text-foreground"
              >
                Start without a website
              </button>
            )}
            {stage === 'reading' && (
              <button
                type="button"
                onClick={fillMyself}
                className="mr-auto text-sm text-muted-foreground hover:text-foreground"
              >
                Fill it in myself
              </button>
            )}
            <Button type="button" variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            {stage === 'url' ? (
              <Button type="submit" disabled={!looksLikeSite(url)}>
                Continue
              </Button>
            ) : (
              <Button type="submit" disabled={busy || stage === 'reading'}>
                Create project
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** A logo about to be kept, with a way back to the letter. */
export function ProjectLogoPreview({ logo, onRemove }: { logo: string; onRemove: () => void }) {
  return (
    <span className="group relative flex-none">
      <span className="flex size-9 items-center justify-center overflow-hidden rounded-md">
        {/* eslint-disable-next-line @next/next/no-img-element -- a data URL or a stored logo */}
        <img src={logo} alt="Logo" className="size-full object-contain" />
      </span>
      <button
        type="button"
        onClick={onRemove}
        title="Use the letter instead"
        aria-label="Remove the logo"
        className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full border bg-background text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <X className="size-3" aria-hidden />
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
