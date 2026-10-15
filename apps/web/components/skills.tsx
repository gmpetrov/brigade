'use client'
// The workspace's skills: how its teammates do certain work. A teammate reads
// one when the work matches its description, or when a message starts with
// `/name`. Owners and admins write, import and change them; a teammate
// proposes one, and an admin approves it from Tickets.
import { skillSlug, type Skill, type SkillFile } from '@brigade/contracts'
import { BookOpenText, FileText, Upload, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { timeAgo, useDashboard } from '@/components/dashboard'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api, ApiError, useApi } from '@/lib/api'
import { API_URL } from '@/lib/config'

/** A skill being written: a new one, an import to review, or one to change. */
type Draft = {
  id?: string
  name: string
  description: string
  instructions: string
  files: SkillFile[]
  everywhere: boolean
  teammateIds: string[]
  projectIds: string[]
  enabled: boolean
  /** Files an import left out. */
  skipped?: string[]
}

const blank: Draft = {
  name: '',
  description: '',
  instructions: '',
  files: [],
  everywhere: true,
  teammateIds: [],
  projectIds: [],
  enabled: true,
}

export function Skills({ admin }: { admin: boolean }) {
  const { teammates, projects } = useDashboard()
  const skills = useApi<Skill[]>('/skills')
  const [draft, setDraft] = useState<Draft>()
  const [viewing, setViewing] = useState<Skill>()
  const [error, setError] = useState<string>()
  const upload = useRef<HTMLInputElement>(null)
  const list = skills.data ?? []

  const where = (s: Skill) => {
    if (s.everywhere) return 'Every thread'
    const names = [
      ...s.teammateIds.map((id) => teammates?.find((t) => t.id === id)?.name),
      ...s.projectIds.map((id) => projects.find((p) => p.id === id)?.name),
    ].filter(Boolean)
    return names.length > 0 ? names.join(', ') : 'No thread yet'
  }

  async function importFile(file: File) {
    setError(undefined)
    try {
      const response = await fetch(
        `${API_URL}/api/skills/import?name=${encodeURIComponent(file.name)}`,
        { method: 'POST', credentials: 'include', body: file },
      )
      const body = (await response.json().catch(() => ({}))) as Draft & { error?: string }
      if (!response.ok) throw new ApiError(body.error ?? response.statusText, response.status)
      setDraft({ ...blank, ...body })
    } catch (e) {
      setError(`Could not import ${file.name}: ${(e as Error).message}`)
    }
  }

  async function toggle(s: Skill, enabled: boolean) {
    setError(undefined)
    skills.setData(list.map((x) => (x.id === s.id ? { ...x, enabled } : x)))
    await api(`/skills/${s.id}`, { method: 'PUT', body: { ...s, enabled } }).catch((e: Error) =>
      setError(e.message),
    )
    await skills.reload()
  }

  async function remove(s: Skill) {
    if (
      !confirm(`Remove the skill ${s.name}? Teammates stop using it in threads that start after.`)
    )
      return
    await api(`/skills/${s.id}`, { method: 'DELETE' }).catch((e: Error) => setError(e.message))
    await skills.reload()
  }

  return (
    <section aria-labelledby="skills" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="skills" className="text-lg font-bold tracking-tight">
            Skills <span className="font-semibold text-muted-foreground">{list.length}</span>
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            How your teammates do certain work. A teammate reads a skill when the work matches its
            description, or when a message starts with its <span className="font-mono">/name</span>.
            A skill gives no access: that stays with the connections above.
          </p>
        </div>
        {admin && (
          <div className="flex gap-2">
            <input
              ref={upload}
              type="file"
              accept=".md,.zip,.skill,text/markdown,application/zip"
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) void importFile(file)
              }}
            />
            <Button
              variant="outline"
              size="sm"
              title="A SKILL.md, or a .zip or .skill of its folder (from Claude, Codex or a repository)"
              onClick={() => upload.current?.click()}
            >
              <Upload aria-hidden />
              Import
            </Button>
            <Button size="sm" onClick={() => setDraft(blank)}>
              Add a skill
            </Button>
          </div>
        )}
      </div>
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      {skills.data && list.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No skills yet.{' '}
          {admin
            ? 'Write one, import one, or ask a teammate to turn work it just did into a skill.'
            : 'Ask a teammate to propose one from work it just did; an admin approves it.'}
        </p>
      ) : (
        list.length > 0 && (
          <Card className="gap-0 divide-y py-0">
            {list.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
                <span
                  className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground"
                  aria-hidden
                >
                  <BookOpenText className="size-5" />
                </span>
                <div className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono font-semibold">/{s.name}</span>
                    {!s.enabled && <Badge variant="secondary">off</Badge>}
                  </div>
                  <span className="line-clamp-2 text-sm">{s.description}</span>
                  <span className="text-sm text-muted-foreground">
                    {where(s)}
                    {s.files.length > 0 &&
                      ` · ${s.files.length} file${s.files.length === 1 ? '' : 's'}`}
                    {s.updatedBy && ` · ${s.updatedBy.name}, ${timeAgo(s.updatedAt)}`}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {admin ? (
                    <>
                      <Switch
                        checked={s.enabled}
                        onCheckedChange={(on) => void toggle(s, on)}
                        aria-label={`Use ${s.name}`}
                      />
                      <Button variant="outline" size="sm" onClick={() => setDraft({ ...s })}>
                        Edit
                      </Button>
                      <Button variant="danger" size="sm" onClick={() => void remove(s)}>
                        Remove
                      </Button>
                    </>
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => setViewing(s)}>
                      View
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </Card>
        )
      )}
      {draft && (
        <EditDialog
          draft={draft}
          onClose={() => setDraft(undefined)}
          onSaved={() => skills.reload()}
        />
      )}
      {viewing && <ViewDialog skill={viewing} onClose={() => setViewing(undefined)} />}
    </section>
  )
}

function EditDialog({
  draft,
  onClose,
  onSaved,
}: {
  draft: Draft
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const { teammates, projects } = useDashboard()
  const [name, setName] = useState(draft.name)
  const [description, setDescription] = useState(draft.description)
  const [instructions, setInstructions] = useState(draft.instructions)
  const [files, setFiles] = useState(draft.files)
  const [everywhere, setEverywhere] = useState(draft.everywhere)
  const [chosen, setChosen] = useState(new Set(draft.teammateIds))
  const [inProjects, setInProjects] = useState(new Set(draft.projectIds))
  const [enabled, setEnabled] = useState(draft.enabled)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const slug = skillSlug(name)

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      const body = {
        name: slug,
        description,
        instructions,
        files,
        everywhere,
        teammateIds: [...chosen],
        projectIds: [...inProjects],
        enabled,
      }
      await api(draft.id ? `/skills/${draft.id}` : '/skills', {
        method: draft.id ? 'PUT' : 'POST',
        body,
      })
      await onSaved()
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const toggleIn = (set: Set<string>, id: string, on: boolean) => {
    const next = new Set(set)
    if (on) next.add(id)
    else next.delete(id)
    return next
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={(e) => void save(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              {draft.id
                ? `Edit ${draft.name}`
                : draft.instructions
                  ? 'Import a skill'
                  : 'Add a skill'}
            </DialogTitle>
            <DialogDescription>
              Teammates see its name and description in every thread it applies to, and read the
              instructions when the work matches. Changes apply to threads that start after.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="skill-name">Name</Label>
            <Input
              id="skill-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={64}
              placeholder="release-notes"
              className="font-mono"
            />
            <span className="text-xs text-muted-foreground">
              {slug ? (
                <>
                  Start a message with <span className="font-mono">/{slug}</span> to ask for it.
                </>
              ) : (
                'Lowercase words joined by hyphens.'
              )}
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="skill-description">When to use it</Label>
            <Textarea
              id="skill-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
              rows={2}
              maxLength={1024}
              placeholder="Write the release notes for a version, from the pull requests merged since the last one"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="skill-instructions">Instructions</Label>
            <Textarea
              id="skill-instructions"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              required
              rows={12}
              className="font-mono text-xs"
              placeholder={'1. List the pull requests merged since the last tag\n2. …'}
            />
          </div>
          {(files.length > 0 || (draft.skipped?.length ?? 0) > 0) && (
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Files beside it</span>
              <ul className="flex flex-col gap-1">
                {files.map((f) => (
                  <li key={f.path} className="flex items-center gap-2 text-sm">
                    <FileText className="size-4 text-muted-foreground" aria-hidden />
                    <span className="flex-1 truncate font-mono text-xs">{f.path}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Leave out ${f.path}`}
                      onClick={() => setFiles(files.filter((x) => x.path !== f.path))}
                    >
                      <X aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
              {(draft.skipped?.length ?? 0) > 0 && (
                <p className="text-xs text-muted-foreground">
                  Left out, as skills keep text files only: {draft.skipped!.join(', ')}
                </p>
              )}
            </div>
          )}
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-sm font-semibold">Applies to</legend>
            <RadioGroup
              value={everywhere ? 'everywhere' : 'some'}
              onValueChange={(v) => setEverywhere(v === 'everywhere')}
              className="flex flex-col gap-2"
            >
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="everywhere" />
                Every thread
              </label>
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="some" />
                Only threads of these teammates and projects
              </label>
            </RadioGroup>
            {!everywhere && (
              <div className="grid gap-4 pl-6 sm:grid-cols-2">
                {(teammates ?? []).length > 0 && (
                  <ul className="flex flex-col gap-1.5" aria-label="Teammates">
                    {(teammates ?? []).map((t) => (
                      <li key={t.id}>
                        <label className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={chosen.has(t.id)}
                            onCheckedChange={(on) => setChosen(toggleIn(chosen, t.id, !!on))}
                          />
                          {t.name}
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
                {projects.some((p) => !p.archivedAt || inProjects.has(p.id)) && (
                  <ul className="flex flex-col gap-1.5" aria-label="Projects">
                    {projects
                      .filter((p) => !p.archivedAt || inProjects.has(p.id))
                      .map((p) => (
                        <li key={p.id}>
                          <label className="flex items-center gap-2 text-sm">
                            <Checkbox
                              checked={inProjects.has(p.id)}
                              onCheckedChange={(on) =>
                                setInProjects(toggleIn(inProjects, p.id, !!on))
                              }
                            />
                            {p.name}
                          </label>
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            )}
          </fieldset>
          <label className="flex items-start justify-between gap-4 rounded-lg border p-3">
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-semibold">On</span>
              <span className="text-xs text-muted-foreground">
                Off keeps it here without giving it to teammates.
              </span>
            </span>
            <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="On" />
          </label>
          {error && <p className="text-sm text-destructive-text">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={busy || !slug || !description.trim() || !instructions.trim()}
            >
              {draft.id ? 'Save' : 'Add'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** A skill as a member who may not change it sees it. */
function ViewDialog({ skill, onClose }: { skill: Skill; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono">/{skill.name}</DialogTitle>
          <DialogDescription>{skill.description}</DialogDescription>
        </DialogHeader>
        <pre className="max-h-[60vh] overflow-auto rounded-md border bg-secondary p-3 font-mono text-xs whitespace-pre-wrap">
          {skill.instructions}
        </pre>
        {skill.files.length > 0 && (
          <p className="text-sm text-muted-foreground">
            With {skill.files.map((f) => f.path).join(', ')}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
