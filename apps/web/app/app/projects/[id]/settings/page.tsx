'use client'
import { Archive, ArchiveRestore, Brain, Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useState, type FormEvent } from 'react'
import { useDashboard } from '@/components/dashboard'
import { useDocumentPanel } from '@/components/document-panel'
import { useProject } from '@/components/project-shell'
import { ProviderLogo } from '@/components/provider-logo'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { api, useApi, type ConnectionsResponse } from '@/lib/api'

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

/** What the project is and what its threads are given; archiving and deleting it. */
export default function ProjectSettings() {
  const { project, reload } = useProject()
  const { reloadProjects } = useDashboard()
  const documents = useDocumentPanel()
  const router = useRouter()
  const connections = useApi<ConnectionsResponse>('/connections')
  const [name, setName] = useState(project.name)
  const [icon, setIcon] = useState(project.icon ?? '')
  const [brief, setBrief] = useState(project.brief)
  const [folder, setFolder] = useState(project.folder ?? '')
  const [preferred, setPreferred] = useState(project.preferredConnections.map((c) => c.id))
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Someone else's change arrives live: show it unless this form has unsaved edits.
  const changed =
    name !== project.name ||
    icon !== (project.icon ?? '') ||
    brief !== project.brief ||
    folder !== (project.folder ?? '') ||
    preferred.join() !== project.preferredConnections.map((c) => c.id).join()
  useEffect(() => {
    if (changed) return
    setName(project.name)
    setIcon(project.icon ?? '')
    setBrief(project.brief)
    setFolder(project.folder ?? '')
    setPreferred(project.preferredConnections.map((c) => c.id))
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
          folder: folder.trim() || null,
          preferredConnectionIds: preferred,
        },
      }),
    )
    if (ok) setSaved(true)
  }

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

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={busy || !changed}>
            Save changes
          </Button>
          {saved && !changed && <span className="text-sm text-success">Saved</span>}
          {error && <span className="text-sm text-destructive-text">{error}</span>}
        </div>
      </form>

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
