'use client'
// A project's settings: one page in sections, with a nav beside them that follows the scroll (above
// them on a phone), and while the project is not set up, a checklist of what its threads still miss.
// Each change saves on its own, as the workspace's settings do: no Save button.
import { projectLogoPath, siteUrl, type SiteInfo } from '@brigade/contracts'
import { Archive, ArchiveRestore, Brain, Check, Trash2, X } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useDashboard } from '@/components/dashboard'
import { useDocumentPanel } from '@/components/document-panel'
import { ProjectMailboxes } from '@/components/mailboxes'
import { ProjectRepositories } from '@/components/project-repositories'
import { useProject } from '@/components/project-shell'
import { ProjectIcon, ProjectLogoPreview, shrinkLogo, uploadLogo } from '@/components/projects'
import { ProviderLogo } from '@/components/provider-logo'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { api, useApi, type ConnectionsResponse, type ReviewPolicy } from '@/lib/api'
import { API_URL } from '@/lib/config'
import {
  fieldError,
  idle,
  preferAccount,
  saveFailed,
  saveMessage,
  saveStarted,
  saveSucceeded,
  type SaveState,
} from '@/lib/project-settings'
import { cn } from '@/lib/utils'

/** The page's sections, in order, as the nav lists them. */
const SECTIONS = [
  { id: 'general', label: 'General' },
  { id: 'repositories', label: 'Repositories' },
  { id: 'code-review', label: 'Code review' },
  { id: 'apps', label: 'Apps' },
  { id: 'email', label: 'Email' },
  { id: 'memory', label: 'Memory' },
  { id: 'archive', label: 'Archive or delete' },
] as const

/** Who decides whether a pull request gets a review, as the Code review section offers it. */
const REVIEW_POLICIES: { value: ReviewPolicy; label: string; description: string }[] = [
  {
    value: 'teammate',
    label: 'The teammate decides',
    description:
      'When it opens a pull request, the teammate says whether it needs a review, and why. Small changes go without one.',
  },
  {
    value: 'manual',
    label: 'Only when someone asks',
    description:
      "A review starts only when someone asks for one: on the pull request's page, or by asking the teammate in its thread.",
  },
]

type ProjectChange = {
  name?: string
  icon?: string | null
  brief?: string
  url?: string | null
  /** A data URL for a new logo, null to remove it. */
  logo?: string | null
  folder?: string | null
  preferredConnectionIds?: string[]
  reviewPolicy?: ReviewPolicy
}

/** Saves changes to the project one at a time, in the order they were made, and says how it went. */
function useProjectSave() {
  const { project, reload } = useProject()
  const { reloadProjects } = useDashboard()
  const [state, setState] = useState<SaveState>(idle)
  const queue = useRef<Promise<unknown>>(Promise.resolve())

  // "Saved" shows for a moment, then goes.
  useEffect(() => {
    if (!state.saved) return
    const timer = setTimeout(() => setState((s) => ({ ...s, saved: false })), 2500)
    return () => clearTimeout(timer)
  }, [state.saved])

  function save(change: ProjectChange) {
    const fields = Object.keys(change)
    setState(saveStarted)
    const run = queue.current.then(async () => {
      try {
        // A new logo goes to the bucket first; null removes it.
        const logo = change.logo && (await uploadLogo(change.logo))
        await api(`/projects/${project.id}`, {
          method: 'PATCH',
          body: change.logo === undefined ? change : { ...change, logo },
        })
        await Promise.all([reload(), reloadProjects()])
        setState((s) => saveSucceeded(s, fields))
        return true
      } catch (e) {
        setState((s) => saveFailed(s, fields, (e as Error).message))
        return false
      }
    })
    queue.current = run
    return run
  }

  /** An error found before saving, kept with its field until it saves; null clears it. */
  const setError = (field: string, message: string | null) =>
    setState((s) => fieldError(s, field, message))

  return { save, state, setError }
}

function SaveStatus({ state }: { state: SaveState }) {
  const message = saveMessage(state)
  if (!message) return null
  return (
    <p
      role="status"
      className={cn('text-sm', message.error ? 'text-destructive-text' : 'text-muted-foreground')}
    >
      {message.text}
    </p>
  )
}

/**
 * A text field that saves when it loses focus (Enter too, on one line), and goes back to the saved
 * value on Escape. While it is not being edited, a change made elsewhere shows.
 */
function AutosaveField({
  value,
  onCommit,
  multiline,
  ...props
}: {
  value: string
  /** False puts the saved value back, for a value it refuses. */
  onCommit: (next: string) => void | false
  multiline?: boolean
  id?: string
  placeholder?: string
  maxLength?: number
  className?: string
  inputMode?: 'url'
  rows?: number
  'aria-label'?: string
}) {
  const [draft, setDraft] = useState(value)
  const editing = useRef(false)
  useEffect(() => {
    if (!editing.current) setDraft(value)
  }, [value])

  const handlers = {
    value: draft,
    onFocus: () => (editing.current = true),
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: () => {
      editing.current = false
      if (draft !== value && onCommit(draft) === false) setDraft(value)
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !multiline) e.currentTarget.blur()
      if (e.key === 'Escape') {
        editing.current = false
        setDraft(value)
        const target = e.currentTarget
        requestAnimationFrame(() => target.blur())
      }
    },
  }
  return multiline ? <Textarea {...props} {...handlers} /> : <Input {...props} {...handlers} />
}

function Section({
  id,
  title,
  description,
  children,
  className,
}: {
  id: string
  title: string
  description: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <Card id={id} className={cn('scroll-mt-16 gap-4 px-6 py-5 md:scroll-mt-8', className)}>
      <div className="flex flex-col gap-1">
        <h2 id={`${id}-title`} className="text-base font-bold">
          {title}
        </h2>
        <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </Card>
  )
}

/** Scrolls to a section, and puts the cursor in one of its fields when there is one to fill. */
function goTo(section: string, field?: string) {
  document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  if (field) document.getElementById(field)?.focus({ preventScroll: true })
}

/** The section the reader is in: the last one whose top has reached the top of the window. */
function useCurrentSection() {
  const [current, setCurrent] = useState<string>(SECTIONS[0].id)
  useEffect(() => {
    function update() {
      let found: string = SECTIONS[0].id
      for (const { id } of SECTIONS) {
        const top = document.getElementById(id)?.getBoundingClientRect().top
        if (top !== undefined && top <= 120) found = id
      }
      // At the foot of the page, the last sections may never reach the top.
      const scroller = document.scrollingElement
      if (scroller && scroller.scrollTop + window.innerHeight >= scroller.scrollHeight - 4)
        found = SECTIONS.at(-1)!.id
      setCurrent(found)
    }
    update()
    // Captured: the page may scroll inside a container rather than the window.
    document.addEventListener('scroll', update, { capture: true, passive: true })
    window.addEventListener('resize', update)
    return () => {
      document.removeEventListener('scroll', update, { capture: true })
      window.removeEventListener('resize', update)
    }
  }, [])
  return current
}

function SectionNav() {
  const current = useCurrentSection()
  return (
    <nav
      aria-label="Project settings"
      className="-mx-1 flex shrink-0 gap-1 overflow-x-auto px-1 [scrollbar-width:none] md:sticky md:top-8 md:mx-0 md:w-40 md:flex-col md:self-start md:px-0"
    >
      {SECTIONS.map(({ id, label }) => (
        <a
          key={id}
          href={`#${id}`}
          onClick={(e) => {
            e.preventDefault()
            goTo(id)
            history.replaceState(null, '', `#${id}`)
          }}
          aria-current={current === id ? 'location' : undefined}
          className={cn(
            'rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors',
            current === id
              ? 'bg-accent font-medium text-accent-foreground'
              : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
            id === 'archive' && current !== id && 'text-destructive-text',
          )}
        >
          {label}
        </a>
      ))}
    </nav>
  )
}

const hiddenKey = (id: string) => `brigade.project-setup-hidden.${id}`

/**
 * What the project's threads still miss, until it has it all or someone hides the list (for this
 * project, in this browser: a project without code never links a repository).
 */
function SetupChecklist() {
  const { project } = useProject()
  const [hidden, setHidden] = useState(true)
  useEffect(() => {
    try {
      setHidden(localStorage.getItem(hiddenKey(project.id)) === '1')
    } catch {
      setHidden(false)
    }
  }, [project.id])

  const steps = [
    {
      done: !!project.brief.trim(),
      label: 'Write the brief',
      detail: 'what it is, who it is for, its stack',
      go: () => goTo('general', 'project-brief'),
    },
    {
      done: !!project.folder,
      label: 'Choose a library folder',
      detail: 'where its threads save what they make',
      go: () => goTo('general', 'project-folder'),
    },
    {
      done: project.repositories.length > 0,
      label: 'Link a repository',
      detail: 'where its threads work on code',
      go: () => goTo('repositories', 'project-repository'),
    },
    {
      done: project.repositories.some((r) => r.preview),
      label: 'Save a preview',
      detail: 'ask a teammate for one in a thread',
      go: () => goTo('repositories'),
    },
  ]
  const done = steps.filter((s) => s.done).length
  if (hidden || project.archivedAt || done === steps.length) return null

  return (
    <Card className="gap-3 px-6 py-5">
      <div className="flex items-center gap-3">
        <div className="flex flex-1 flex-col gap-1">
          <h2 className="text-base font-bold">Set up the project</h2>
          <p className="text-sm text-muted-foreground">
            What every thread in it is given. {done} of {steps.length} done.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Hide the checklist"
          onClick={() => {
            setHidden(true)
            try {
              localStorage.setItem(hiddenKey(project.id), '1')
            } catch {}
          }}
        >
          <X aria-hidden />
        </Button>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label="Project setup"
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-valuenow={done}
      >
        <div
          className="h-full rounded-full bg-primary transition-[width]"
          style={{ width: `${(done / steps.length) * 100}%` }}
        />
      </div>
      <ul className="flex flex-col">
        {steps.map((step) => (
          <li key={step.label}>
            {step.done ? (
              <span className="flex items-center gap-2.5 py-1 text-sm text-muted-foreground">
                <Check className="size-4 text-success" aria-hidden />
                <span className="line-through decoration-border">{step.label}</span>
              </span>
            ) : (
              <button
                type="button"
                onClick={step.go}
                className="group flex w-full items-center gap-2.5 py-1 text-left text-sm"
              >
                <span
                  aria-hidden
                  className="size-4 shrink-0 rounded-full border-2 border-muted-foreground/40"
                />
                <span className="font-medium group-hover:text-primary">{step.label}</span>
                <span className="truncate text-muted-foreground">{step.detail}</span>
              </button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  )
}

function GeneralSection() {
  const { project } = useProject()
  const { save, state, setError } = useProjectSave()
  const file = useRef<HTMLInputElement>(null)
  /** A new logo while it saves. */
  const [pending, setPending] = useState<string>()
  const [fetchingLogo, setFetchingLogo] = useState(false)

  async function saveLogo(logo: string | null) {
    if (logo) setPending(logo)
    await save({ logo })
    setPending(undefined)
  }

  function pickLogo(picked: File | undefined) {
    if (!picked) return
    const reader = new FileReader()
    reader.onload = async () => {
      const shrunk = await shrinkLogo(String(reader.result)).catch(() => null)
      if (!shrunk)
        return setError('logo', 'That image cannot be a logo: try a PNG or an SVG under 256 KB')
      setError('logo', null)
      void saveLogo(shrunk)
    }
    reader.readAsDataURL(picked)
  }

  async function logoFromSite() {
    if (!project.url) return
    setFetchingLogo(true)
    setError('logo', null)
    try {
      const info = await api<SiteInfo>('/projects/site', { body: { url: project.url } })
      const shrunk = info.logo ? await shrinkLogo(info.logo).catch(() => null) : null
      if (shrunk) void saveLogo(shrunk)
      else setError('logo', `${new URL(info.url).hostname} shows no logo`)
    } catch (e) {
      setError('logo', (e as Error).message)
    } finally {
      setFetchingLogo(false)
    }
  }

  const shownLogo =
    pending ??
    (project.logo
      ? `${API_URL}/api${projectLogoPath({ id: project.id, logo: project.logo })}`
      : null)

  return (
    <Section
      id="general"
      title="General"
      description="Its name, its brief and where its files live. Every thread in the project is given the brief and the folder."
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="project-name">Name</Label>
        <AutosaveField
          id="project-name"
          value={project.name}
          maxLength={80}
          onCommit={(next) => {
            if (!next.trim()) return false
            void save({ name: next.trim() })
          }}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label>Logo</Label>
        <div className="flex flex-wrap items-center gap-2">
          {shownLogo ? (
            <ProjectLogoPreview logo={shownLogo} onRemove={() => void saveLogo(null)} />
          ) : (
            <ProjectIcon project={project} className="size-9 rounded-md text-base" />
          )}
          <Button type="button" variant="outline" size="sm" onClick={() => file.current?.click()}>
            Upload
          </Button>
          {project.url && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={fetchingLogo}
              onClick={() => void logoFromSite()}
            >
              {fetchingLogo ? 'Reading the site…' : 'Take it from the website'}
            </Button>
          )}
          {!shownLogo && (
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Label htmlFor="project-icon" className="font-normal text-muted-foreground">
                or letters
              </Label>
              <AutosaveField
                id="project-icon"
                value={project.icon ?? ''}
                placeholder={project.name.trim().charAt(0).toUpperCase()}
                maxLength={8}
                className="h-8 w-20"
                onCommit={(next) => void save({ icon: next.trim() || null })}
              />
            </span>
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
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="project-url">Website</Label>
        <AutosaveField
          id="project-url"
          value={project.url ?? ''}
          placeholder="example.com"
          inputMode="url"
          maxLength={2000}
          onCommit={(next) => void save({ url: next.trim() ? siteUrl(next) : null })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="project-brief">Brief</Label>
        <AutosaveField
          id="project-brief"
          multiline
          rows={5}
          maxLength={5000}
          value={project.brief}
          placeholder="What it is, who it is for, its stack and how the team works on it."
          onCommit={(next) => void save({ brief: next.trim() })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="project-folder">Library folder</Label>
        <AutosaveField
          id="project-folder"
          value={project.folder ?? ''}
          placeholder={`Projects/${project.name}`}
          className="font-mono"
          onCommit={(next) => void save({ folder: next.trim() || null })}
        />
        <p className="text-sm text-muted-foreground">
          Its threads save what they make for it there. Moving the folder in the library keeps it
          linked.
        </p>
      </div>
      <SaveStatus state={state} />
    </Section>
  )
}

function CodeReviewSection() {
  const { project } = useProject()
  const { save, state } = useProjectSave()
  return (
    <Section
      id="code-review"
      title="Code review"
      description="Whether its pull requests get a review by another teammate before they reach you. The reviewer reads one in a child thread, and the teammate that wrote it fixes what it finds."
    >
      <RadioGroup
        value={project.reviewPolicy}
        onValueChange={(v) => void save({ reviewPolicy: v as ReviewPolicy })}
        aria-label="Code review"
      >
        {REVIEW_POLICIES.map((option) => (
          <div key={option.value} className="flex items-start gap-3">
            <RadioGroupItem id={`review-${option.value}`} value={option.value} className="mt-0.5" />
            <Label
              htmlFor={`review-${option.value}`}
              className="flex flex-col items-start gap-0.5 font-normal"
            >
              <span className="font-medium">{option.label}</span>
              <span className="text-muted-foreground">{option.description}</span>
            </Label>
          </div>
        ))}
      </RadioGroup>
      <SaveStatus state={state} />
    </Section>
  )
}

const NO_PREFERENCE = 'none'

/**
 * Which account the project's threads use when an App has several: one choice per App, and only for
 * Apps with more than one account, since with one there is nothing to choose.
 */
function AppsSection() {
  const { project } = useProject()
  const { save, state } = useProjectSave()
  const connections = useApi<ConnectionsResponse>('/connections', ['connections.updated'])
  /** The list as the last pick left it, while its save is on its way. */
  const picked = useRef<string[] | null>(null)
  const [, setPicked] = useState<string[] | null>(null)
  const preferred = picked.current ?? project.preferredConnections.map((c) => c.id)

  const usable = (connections.data?.connections ?? []).filter(
    (c) => c.status !== 'removed' && c.kind !== 'webhook',
  )
  const byApp = new Map<string, typeof usable>()
  for (const c of usable) byApp.set(c.appId, [...(byApp.get(c.appId) ?? []), c])
  const appName = (appId: string, kind: (typeof usable)[number]['kind']) =>
    connections.data?.apps.find((a) => a.id === appId)?.name ??
    connections.data?.catalog[kind]?.name ??
    kind
  const choices = [...byApp.entries()]
    .filter(([, accounts]) => accounts.length > 1)
    .map(([appId, accounts]) => ({ appId, accounts, name: appName(appId, accounts[0]!.kind) }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const single = byApp.size - choices.length

  function choose(accounts: typeof usable, id: string) {
    const next = preferAccount(
      preferred,
      accounts.map((a) => a.id),
      id === NO_PREFERENCE ? null : id,
    )
    picked.current = next
    setPicked(next)
    void save({ preferredConnectionIds: next }).then(() => {
      // The project as reloaded shows it from now on, unless another pick came since.
      if (picked.current !== next) return
      picked.current = null
      setPicked(null)
    })
  }

  return (
    <Section
      id="apps"
      title="Preferred accounts"
      description="When an App has several accounts (two Stripe accounts, two Gmail inboxes), the project's threads use the one picked here. A hint, not a permission: what a teammate may use still comes from its grants."
    >
      {!connections.data ? (
        <p className="text-sm text-muted-foreground">{connections.error?.message ?? 'Loading…'}</p>
      ) : choices.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {usable.length
            ? 'Each App has one account: there is nothing to choose.'
            : 'No Apps connected yet.'}
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border">
          {choices.map(({ appId, accounts, name }) => {
            const value = accounts.find((a) => preferred.includes(a.id))?.id ?? NO_PREFERENCE
            return (
              <li key={appId} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <ProviderLogo kind={accounts[0]!.kind} className="size-4" />
                <span
                  id={`prefer-${appId}`}
                  className="min-w-0 flex-1 truncate text-sm font-medium"
                >
                  {name}
                </span>
                <Select value={value} onValueChange={(id) => choose(accounts, id)}>
                  <SelectTrigger
                    size="sm"
                    aria-labelledby={`prefer-${appId}`}
                    className="w-full max-w-64 sm:w-64"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_PREFERENCE}>Let the teammate pick</SelectItem>
                    {accounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.externalAccount
                          ? a.label === name
                            ? a.externalAccount
                            : `${a.label} · ${a.externalAccount}`
                          : a.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </li>
            )
          })}
        </ul>
      )}
      {choices.length > 0 && single > 0 && (
        <p className="text-sm text-muted-foreground">
          {single} other App{single === 1 ? ' has' : 's have'} one account: threads use it.
        </p>
      )}
      <SaveStatus state={state} />
    </Section>
  )
}

function MemorySection() {
  const { project } = useProject()
  const documents = useDocumentPanel()
  return (
    <Section
      id="memory"
      title="Memory"
      description="What its threads learned about the project, loaded by every thread in it. When a thread goes quiet, facts about the project go here, not into a teammate's own memory."
    >
      <div>
        <Button
          variant="outline"
          onClick={() =>
            documents.open({
              target: { kind: 'project_memory', projectId: project.id },
              title: `${project.name} memory`,
              subtitle: 'Loaded by every thread in the project',
            })
          }
        >
          <Brain aria-hidden />
          {project.memory ? `Open memory (${project.memory.lines} lines)` : 'Open memory'}
        </Button>
      </div>
    </Section>
  )
}

function ArchiveSection() {
  const { project, reload } = useProject()
  const { reloadProjects } = useDashboard()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [confirmDelete, setConfirmDelete] = useState(false)

  async function run(path: 'archive' | 'unarchive') {
    setBusy(true)
    setError(undefined)
    try {
      await api(`/projects/${project.id}/${path}`, { method: 'POST', body: {} })
      await Promise.all([reload(), reloadProjects()])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section
      id="archive"
      title={project.archivedAt ? 'Archived' : 'Archive or delete'}
      description="Archiving takes it off the sidebar; nothing new starts in it, and its schedules and triggers keep running. Deleting keeps its threads, tasks, library folder and repositories, in no project; its memory goes."
      className="border-destructive/40"
    >
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void run(project.archivedAt ? 'unarchive' : 'archive')}
        >
          {project.archivedAt ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
          {project.archivedAt ? 'Unarchive' : 'Archive'}
        </Button>
        {confirmDelete ? (
          <>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await api(`/projects/${project.id}`, { method: 'DELETE' })
                  await reloadProjects()
                  router.replace('/app/projects')
                } catch (e) {
                  setError((e as Error).message)
                  setBusy(false)
                }
              }}
            >
              Delete {project.name}
            </Button>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Keep it
            </Button>
          </>
        ) : (
          <Button variant="danger" onClick={() => setConfirmDelete(true)}>
            <Trash2 aria-hidden />
            Delete
          </Button>
        )}
      </div>
      {error && <p className="text-sm text-destructive-text">{error}</p>}
    </Section>
  )
}

/** What the project is and what its threads are given; archiving and deleting it. */
export default function ProjectSettings() {
  const { project } = useProject()
  return (
    <div className="flex flex-col gap-6 md:flex-row md:gap-10">
      <SectionNav />
      <div className="flex min-w-0 flex-1 flex-col gap-6">
        <SetupChecklist />
        <GeneralSection />
        <ProjectRepositories />
        <CodeReviewSection />
        <AppsSection />
        <div id="email" className="scroll-mt-16 md:scroll-mt-8">
          <ProjectMailboxes projectId={project.id} />
        </div>
        <MemorySection />
        <ArchiveSection />
      </div>
    </div>
  )
}
