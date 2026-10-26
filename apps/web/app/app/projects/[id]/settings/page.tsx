'use client'
import { projectLogoPath, siteUrl, type SiteInfo } from '@brigade/contracts'
import { Archive, ArchiveRestore, Brain, Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useDashboard } from '@/components/dashboard'
import { useDocumentPanel } from '@/components/document-panel'
import { ProjectMailboxes } from '@/components/mailboxes'
import { useProject } from '@/components/project-shell'
import { ProjectLogoPreview, shrinkLogo } from '@/components/projects'
import { ProviderLogo } from '@/components/provider-logo'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'
import { api, useApi, type ConnectionsResponse, type ReviewPolicy } from '@/lib/api'
import { API_URL } from '@/lib/config'

function Section({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <Card className="gap-4 px-6 py-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-bold">{title}</h2>
        <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </Card>
  )
}

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

/** What the project is and what its threads are given; archiving and deleting it. */
export default function ProjectSettings() {
  const { project, reload } = useProject()
  const { reloadProjects } = useDashboard()
  const documents = useDocumentPanel()
  const router = useRouter()
  const connections = useApi<ConnectionsResponse>('/connections', ['connections.updated'])
  const [name, setName] = useState(project.name)
  const [icon, setIcon] = useState(project.icon ?? '')
  const [brief, setBrief] = useState(project.brief)
  const [url, setUrl] = useState(project.url ?? '')
  /** Unset: as it is. Null: back to the icon. A data URL: a new logo. */
  const [logo, setLogo] = useState<string | null>()
  const [fetchingLogo, setFetchingLogo] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const [folder, setFolder] = useState(project.folder ?? '')
  const [preferred, setPreferred] = useState(project.preferredConnections.map((c) => c.id))
  const [reviewPolicy, setReviewPolicy] = useState(project.reviewPolicy)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Someone else's change arrives live: show it unless this form has unsaved edits.
  const changed =
    name !== project.name ||
    icon !== (project.icon ?? '') ||
    brief !== project.brief ||
    url !== (project.url ?? '') ||
    logo !== undefined ||
    folder !== (project.folder ?? '') ||
    preferred.join() !== project.preferredConnections.map((c) => c.id).join() ||
    reviewPolicy !== project.reviewPolicy
  useEffect(() => {
    if (changed) return
    setName(project.name)
    setIcon(project.icon ?? '')
    setBrief(project.brief)
    setUrl(project.url ?? '')
    setFolder(project.folder ?? '')
    setPreferred(project.preferredConnections.map((c) => c.id))
    setReviewPolicy(project.reviewPolicy)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the project changes
  }, [project])

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError(undefined)
    setSaved(false)
    try {
      await action()
      await Promise.all([reload(), reloadProjects()])
      return true
    } catch (e) {
      setError((e as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) return setError('Name the project')
    const ok = await run(() =>
      api(`/projects/${project.id}`, {
        method: 'PATCH',
        body: {
          name: name.trim(),
          icon: icon.trim() || null,
          brief: brief.trim(),
          url: url.trim() ? siteUrl(url) : null,
          ...(logo !== undefined && { logo }),
          folder: folder.trim() || null,
          preferredConnectionIds: preferred,
          reviewPolicy,
        },
      }),
    )
    if (ok) {
      setLogo(undefined)
      setSaved(true)
    }
  }

  function pickLogo(picked: File | undefined) {
    if (!picked) return
    const reader = new FileReader()
    reader.onload = async () => {
      const shrunk = await shrinkLogo(String(reader.result)).catch(() => null)
      if (!shrunk) return setError('That image cannot be a logo: try a PNG or an SVG under 256 KB')
      setLogo(shrunk)
      setError(undefined)
    }
    reader.readAsDataURL(picked)
  }

  async function logoFromSite() {
    setFetchingLogo(true)
    setError(undefined)
    try {
      const info = await api<SiteInfo>('/projects/site', { body: { url: siteUrl(url) } })
      const shrunk = info.logo ? await shrinkLogo(info.logo).catch(() => null) : null
      if (shrunk) setLogo(shrunk)
      else setError(`${new URL(info.url).hostname} shows no logo`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setFetchingLogo(false)
    }
  }

  /** What shows now: the new logo, none, or the saved one. */
  const shownLogo =
    logo !== undefined
      ? logo
      : project.logo
        ? `${API_URL}/api${projectLogoPath({ id: project.id, logo: project.logo })}`
        : null

  const usable = (connections.data?.connections ?? []).filter(
    (c) => c.status !== 'removed' && c.kind !== 'webhook',
  )

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={(e) => void save(e)} className="flex flex-col gap-6">
        <Section
          title="About"
          description="Its name and brief. The brief is given to every thread in the project: what it is, who it is for, its stack, how the team works on it."
        >
          <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
            <div className="flex flex-col gap-2">
              <Label htmlFor="project-name">Name</Label>
              <Input
                id="project-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="project-icon">Icon</Label>
              <Input
                id="project-icon"
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                placeholder={name.trim().charAt(0).toUpperCase()}
                maxLength={8}
              />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="project-url">Website</Label>
            <Input
              id="project-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="acme.com"
              inputMode="url"
              maxLength={2000}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label>Logo</Label>
            <div className="flex flex-wrap items-center gap-2">
              {shownLogo ? (
                <ProjectLogoPreview logo={shownLogo} onRemove={() => setLogo(null)} />
              ) : (
                <span className="text-sm text-muted-foreground">None: the icon shows instead.</span>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => file.current?.click()}
              >
                Upload
              </Button>
              {url.trim() && (
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
            <Label htmlFor="project-brief">Brief</Label>
            <Textarea
              id="project-brief"
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              rows={5}
              maxLength={5000}
              placeholder="Customer storefront. Next.js on acme/web, Stripe live. Customers are small coffee shops."
            />
          </div>
        </Section>

        <Section
          title="Library folder"
          description="Where its files live. Its threads are told to save what they make for it there; moving the folder in the library keeps it linked."
        >
          <Input
            aria-label="Library folder"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            placeholder="Projects/Acme web"
            className="font-mono"
          />
        </Section>

        <Section
          title="Preferred connections"
          description="When several connections could do something (two Stripe accounts, two inboxes), its threads use these. A hint, not a permission: what a teammate may use still comes from its grants."
        >
          {usable.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {connections.data ? 'No connections yet.' : 'Loading…'}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {usable.map((c) => {
                const id = `preferred-${c.id}`
                return (
                  <li key={c.id} className="flex items-center gap-3">
                    <Checkbox
                      id={id}
                      checked={preferred.includes(c.id)}
                      onCheckedChange={(on) =>
                        setPreferred((list) =>
                          on ? [...list, c.id] : list.filter((x) => x !== c.id),
                        )
                      }
                    />
                    <Label htmlFor={id} className="flex items-center gap-2 font-normal">
                      <ProviderLogo kind={c.kind} className="size-4" />
                      {c.label}
                      {c.externalAccount && (
                        <span className="text-muted-foreground">{c.externalAccount}</span>
                      )}
                    </Label>
                  </li>
                )
              })}
            </ul>
          )}
        </Section>

        <Section
          title="Code review"
          description="Whether its pull requests get a review by another teammate before they reach you. The reviewer reads one in a child thread, from a brief of Brigade's, and the teammate that wrote it fixes what it finds."
        >
          <RadioGroup
            value={reviewPolicy}
            onValueChange={(v) => setReviewPolicy(v as ReviewPolicy)}
            aria-label="Code review"
          >
            {REVIEW_POLICIES.map((option) => (
              <div key={option.value} className="flex items-start gap-3">
                <RadioGroupItem
                  id={`review-${option.value}`}
                  value={option.value}
                  className="mt-0.5"
                />
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
        </Section>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={busy || !changed}>
            Save changes
          </Button>
          {saved && !changed && <span className="text-sm text-success">Saved</span>}
          {error && <span className="text-sm text-destructive-text">{error}</span>}
        </div>
      </form>

      <ProjectMailboxes projectId={project.id} />

      <Section
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

      <Section
        title={project.archivedAt ? 'Archived' : 'Archive or delete'}
        description="Archiving takes it off the sidebar; nothing new starts in it, and its schedules and triggers keep running. Deleting keeps its threads, tasks, library folder and repositories, in no project; its memory goes."
      >
        <div className="flex flex-wrap gap-2">
          {project.archivedAt ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  api(`/projects/${project.id}/unarchive`, { method: 'POST', body: {} }),
                )
              }
            >
              <ArchiveRestore aria-hidden />
              Unarchive
            </Button>
          ) : (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(() => api(`/projects/${project.id}/archive`, { method: 'POST', body: {} }))
              }
            >
              <Archive aria-hidden />
              Archive
            </Button>
          )}
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
      </Section>
    </div>
  )
}
