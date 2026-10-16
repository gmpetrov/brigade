'use client'
// The workspace's skills: how its teammates do certain work. A teammate reads
// one when the work matches its description, or when a message starts with
// `/name`. Owners and admins write, import and change them, alone or as packs
// (skills imported together, with one scope and one switch); a teammate
// proposes one, and an admin approves it from Tickets.
import {
  skillSlug,
  type ImportedSkill,
  type Skill,
  type SkillFileRef,
  type SkillImport,
  type SkillPack,
} from '@brigade/contracts'
import {
  BookOpenText,
  ChevronRight,
  EllipsisVertical,
  FileText,
  Package,
  Upload,
  X,
} from 'lucide-react'
import { useRef, useState } from 'react'
import { TeammateAvatar, timeAgo, useDashboard } from '@/components/dashboard'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api, ApiError, useApi } from '@/lib/api'
import { API_URL } from '@/lib/config'

type Scope = { everywhere: boolean; teammateIds: string[]; projectIds: string[] }

/** A skill being written: a new one, an import to review, or one to change. */
type Draft = Scope & {
  id?: string
  /** In a pack: its scope is the pack's. */
  packId?: string | null
  name: string
  description: string
  instructions: string
  files: SkillFileRef[]
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

const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`

/** A pack's source as people read it: the GitHub address, or the file's name. */
const sourceLabel = (source: string) =>
  source.startsWith('file:') ? source.slice(5) : source.replace(/^https:\/\/(www\.)?/, '')

/** Where skills apply, in words. */
function useWhere() {
  const { teammates, projects } = useDashboard()
  return (s: Scope) => {
    if (s.everywhere) return 'Every thread'
    const names = [
      ...s.teammateIds.map((id) => teammates?.find((t) => t.id === id)?.name),
      ...s.projectIds.map((id) => projects.find((p) => p.id === id)?.name),
    ].filter(Boolean)
    return names.length > 0 ? names.join(', ') : 'No thread yet'
  }
}

/** Read an upload or a GitHub address into skills to review. */
async function readImport(from: { file: File } | { url: string }): Promise<SkillImport> {
  if ('url' in from) return api<SkillImport>('/skills/import/github', { body: { url: from.url } })
  const response = await fetch(
    `${API_URL}/api/skills/import?name=${encodeURIComponent(from.file.name)}`,
    { method: 'POST', credentials: 'include', body: from.file },
  )
  const body = (await response.json().catch(() => ({}))) as SkillImport & { error?: string }
  if (!response.ok) throw new ApiError(body.error ?? response.statusText, response.status)
  return body
}

/** The GitHub owner of a pack's source, for its picture: `cloudflare` for github.com/cloudflare/skills. */
const githubOwner = (source: string) =>
  /^https:\/\/(www\.)?github\.com\/([\w.-]+)/.exec(source)?.[2]

/** A pack's picture: its GitHub owner's avatar, or a box. */
function SourceImage({ source }: { source: string }) {
  const owner = githubOwner(source)
  return (
    <Avatar className="size-8 rounded-lg" aria-hidden>
      {owner && <AvatarImage src={`https://github.com/${owner}.png?size=64`} alt="" />}
      <AvatarFallback className="rounded-lg bg-accent text-accent-foreground">
        <Package className="size-4" />
      </AvatarFallback>
    </Avatar>
  )
}

/** A skill's picture: who wrote it, a teammate's pebble or a member's photo; else a book. */
function AuthorImage({ skill }: { skill: Skill }) {
  const by = skill.updatedBy
  if (by?.type === 'teammate') return <TeammateAvatar teammate={by} className="size-8 shrink-0" />
  return (
    <Avatar className="size-8" aria-hidden>
      {by?.image && <AvatarImage src={by.image} alt="" referrerPolicy="no-referrer" />}
      <AvatarFallback className="bg-accent text-xs font-semibold text-accent-foreground">
        {by ? by.name.trim().charAt(0).toUpperCase() : <BookOpenText className="size-4" />}
      </AvatarFallback>
    </Avatar>
  )
}

export function Skills({ admin }: { admin: boolean }) {
  const skills = useApi<Skill[]>('/skills')
  const packs = useApi<SkillPack[]>('/skills/packs')
  const where = useWhere()
  const [draft, setDraft] = useState<Draft>()
  const [viewing, setViewing] = useState<Skill>()
  const [importing, setImporting] = useState(false)
  const [review, setReview] = useState<SkillImport>()
  const [editingPack, setEditingPack] = useState<SkillPack>()
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string>()
  const list = skills.data ?? []
  const packList = packs.data ?? []
  const loose = list.filter((s) => !s.packId)
  const reload = () => Promise.all([skills.reload(), packs.reload()]).then(() => undefined)

  /** One new skill opens in the editor; several, or an update of a pack, in the checklist. */
  function imported(result: SkillImport) {
    setImporting(false)
    const [only] = result.skills
    if (result.skills.length === 1 && !result.pack && only!.status === 'new')
      setDraft({ ...blank, ...only!, packId: null })
    else setReview(result)
  }

  async function toggle(s: Skill, enabled: boolean) {
    setError(undefined)
    skills.setData(list.map((x) => (x.id === s.id ? { ...x, enabled } : x)))
    await api(`/skills/${s.id}`, { method: 'PUT', body: { ...s, enabled } }).catch((e: Error) =>
      setError(e.message),
    )
    await reload()
  }

  async function togglePack(p: SkillPack, enabled: boolean) {
    setError(undefined)
    packs.setData(packList.map((x) => (x.id === p.id ? { ...x, enabled } : x)))
    await api(`/skills/packs/${p.id}`, { method: 'PUT', body: { enabled } }).catch((e: Error) =>
      setError(e.message),
    )
    await reload()
  }

  async function remove(s: Skill) {
    if (
      !confirm(`Remove the skill ${s.name}? Teammates stop using it in threads that start after.`)
    )
      return
    await api(`/skills/${s.id}`, { method: 'DELETE' }).catch((e: Error) => setError(e.message))
    await reload()
  }

  async function removePack(p: SkillPack, count: number) {
    if (!confirm(`Remove the pack ${p.name} and its ${count} skills?`)) return
    await api(`/skills/packs/${p.id}`, { method: 'DELETE' }).catch((e: Error) =>
      setError(e.message),
    )
    await reload()
  }

  async function updatePack(p: SkillPack) {
    setError(undefined)
    try {
      imported(await readImport({ url: p.source }))
    } catch (e) {
      setError(`Could not read ${sourceLabel(p.source)}: ${(e as Error).message}`)
    }
  }

  /** Edit, Update and Remove, out of the way. */
  const menu = (
    label: string,
    items: { label: string; onSelect: () => void; danger?: boolean }[],
  ) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`${label} options`}>
          <EllipsisVertical aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {items.map((item) => (
          <DropdownMenuItem
            key={item.label}
            variant={item.danger ? 'destructive' : 'default'}
            onSelect={item.onSelect}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )

  const skillRow = (s: Skill, inPack?: SkillPack) => (
    <div key={s.id} className={`flex items-center gap-3 py-2.5 pr-3 ${inPack ? 'pl-15' : 'pl-4'}`}>
      {!inPack && <AuthorImage skill={s} />}
      <button
        type="button"
        className="flex min-w-0 flex-1 flex-col text-left"
        title={s.description}
        onClick={() => (admin ? setDraft({ ...s }) : setViewing(s))}
      >
        <span
          className={`truncate font-mono text-sm font-medium ${s.active ? '' : 'text-muted-foreground'}`}
        >
          /{s.name}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {inPack
            ? s.description
            : [where(s), s.updatedBy?.name, timeAgo(s.updatedAt)].filter(Boolean).join(' · ')}
        </span>
      </button>
      {admin && (
        <>
          <Switch
            checked={s.enabled}
            onCheckedChange={(on) => void toggle(s, on)}
            aria-label={`Use ${s.name}`}
          />
          {menu(`/${s.name}`, [
            { label: 'Edit', onSelect: () => setDraft({ ...s }) },
            { label: 'Remove', onSelect: () => void remove(s), danger: true },
          ])}
        </>
      )}
    </div>
  )

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
            A skill gives no access: that stays with the Apps above.
          </p>
        </div>
        {admin && (
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              title="A GitHub repository, a zip of skill folders, a .skill or a SKILL.md"
              onClick={() => setImporting(true)}
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
            ? 'Write one, import one or a pack (from GitHub or a zip), or ask a teammate to turn work it just did into a skill.'
            : 'Ask a teammate to propose one from work it just did; an admin approves it.'}
        </p>
      ) : (
        list.length > 0 && (
          <Card className="gap-0 divide-y py-0">
            {packList.map((p) => {
              const inPack = list.filter((s) => s.packId === p.id)
              const on = inPack.filter((s) => s.enabled).length
              const expanded = open.has(p.id)
              return (
                <div key={p.id} className="flex flex-col divide-y">
                  <div className="flex items-center gap-3 py-2.5 pr-3 pl-4">
                    <SourceImage source={p.source} />
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 flex-col text-left"
                      title={sourceLabel(p.source)}
                      aria-expanded={expanded}
                      onClick={() => {
                        const next = new Set(open)
                        if (expanded) next.delete(p.id)
                        else next.add(p.id)
                        setOpen(next)
                      }}
                    >
                      <span className="flex min-w-0 items-center gap-1">
                        <span
                          className={`truncate text-sm font-medium ${p.enabled ? '' : 'text-muted-foreground'}`}
                        >
                          {p.name}
                        </span>
                        <ChevronRight
                          aria-hidden
                          className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`}
                        />
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {on === inPack.length
                          ? `${inPack.length} skill${inPack.length === 1 ? '' : 's'}`
                          : `${on} of ${inPack.length} on`}{' '}
                        · {where(p)}
                      </span>
                    </button>
                    {admin && (
                      <>
                        <Switch
                          checked={p.enabled}
                          onCheckedChange={(v) => void togglePack(p, v)}
                          aria-label={`Use the pack ${p.name}`}
                        />
                        {menu(p.name, [
                          { label: 'Edit', onSelect: () => setEditingPack(p) },
                          ...(p.source.startsWith('file:')
                            ? []
                            : [{ label: 'Update', onSelect: () => void updatePack(p) }]),
                          {
                            label: 'Remove',
                            onSelect: () => void removePack(p, inPack.length),
                            danger: true,
                          },
                        ])}
                      </>
                    )}
                  </div>
                  {expanded && inPack.map((s) => skillRow(s, p))}
                </div>
              )
            })}
            {loose.map((s) => skillRow(s))}
          </Card>
        )
      )}
      {importing && <ImportDialog onClose={() => setImporting(false)} onRead={imported} />}
      {review && (
        <PackDialog review={review} onClose={() => setReview(undefined)} onSaved={reload} />
      )}
      {editingPack && (
        <PackEditDialog
          pack={editingPack}
          onClose={() => setEditingPack(undefined)}
          onSaved={reload}
        />
      )}
      {draft && <EditDialog draft={draft} onClose={() => setDraft(undefined)} onSaved={reload} />}
      {viewing && <ViewDialog skill={viewing} onClose={() => setViewing(undefined)} />}
    </section>
  )
}

/** Where to import from: a GitHub address, or a file. */
function ImportDialog({
  onClose,
  onRead,
}: {
  onClose: () => void
  onRead: (result: SkillImport) => void
}) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const upload = useRef<HTMLInputElement>(null)

  async function read(from: { file: File } | { url: string }) {
    setError(undefined)
    setBusy('url' in from ? 'Reading the repository…' : `Reading ${from.file.name}…`)
    try {
      onRead(await readImport(from))
    } catch (e) {
      setError((e as Error).message)
      setBusy(undefined)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import skills</DialogTitle>
          <DialogDescription>
            One skill or a pack of them, as Claude, Codex and Grok write them: folders with a
            SKILL.md. You review them before anything is added.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            if (url.trim()) void read({ url: url.trim() })
          }}
        >
          <Label htmlFor="skills-url">From GitHub</Label>
          <div className="flex gap-2">
            <Input
              id="skills-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/anthropics/skills"
              disabled={!!busy}
            />
            <Button type="submit" disabled={!!busy || !url.trim()}>
              Read
            </Button>
          </div>
          <span className="text-xs text-muted-foreground">
            A repository, or a folder in one. A private one needs a GitHub connection that reaches
            it.
          </span>
        </form>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          or
          <span className="h-px flex-1 bg-border" />
        </div>
        <div className="flex flex-col gap-1.5">
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
              if (file) void read({ file })
            }}
          />
          <Button
            type="button"
            variant="outline"
            disabled={!!busy}
            onClick={() => upload.current?.click()}
          >
            <Upload aria-hidden />
            Choose a file
          </Button>
          <span className="text-xs text-muted-foreground">
            A .zip of one skill folder or many, a .skill, or a SKILL.md. Up to 50 MB.
          </span>
        </div>
        {busy && <p className="text-sm text-muted-foreground">{busy}</p>}
        {error && <p className="text-sm text-destructive-text">{error}</p>}
      </DialogContent>
    </Dialog>
  )
}

const STATUS: Record<ImportedSkill['status'], string> = {
  new: 'new',
  update: 'update',
  same: 'no change',
  taken: 'name taken',
  invalid: 'cannot add',
}

/** The skills an import found: tick those to have on, choose where they apply, add them. */
function PackDialog({
  review,
  onClose,
  onSaved,
}: {
  review: SkillImport
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const addable = review.skills.filter((s) => s.status !== 'taken' && s.status !== 'invalid')
  const [name, setName] = useState(review.pack?.name ?? review.label)
  const [ticked, setTicked] = useState(
    new Set(addable.filter((s) => s.enabled ?? true).map((s) => s.folder)),
  )
  const [scope, setScope] = useState<Scope>(
    review.pack ?? { everywhere: true, teammateIds: [], projectIds: [] },
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function save() {
    setBusy(true)
    setError(undefined)
    try {
      await api('/skills/packs', {
        body: {
          ...(review.pack ? { packId: review.pack.id } : {}),
          name,
          source: review.source,
          ...scope,
          skills: addable.map((s) => ({
            name: s.name,
            description: s.description,
            instructions: s.instructions,
            files: s.files,
            enabled: ticked.has(s.folder),
          })),
        },
      })
      await onSaved()
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {review.pack ? `Update ${review.pack.name}` : 'Add a pack of skills'}
          </DialogTitle>
          <DialogDescription>
            Found {review.skills.length} skill{review.skills.length === 1 ? '' : 's'} in{' '}
            {sourceLabel(review.source)}. Ticked ones are on; the others are added off, to turn on
            later.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pack-name">Pack name</Label>
          <Input
            id="pack-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
          />
        </div>
        <ul className="flex flex-col divide-y rounded-lg border">
          {review.skills.map((s) => {
            const can = s.status !== 'taken' && s.status !== 'invalid'
            return (
              <li key={s.folder || s.name} className="flex items-start gap-3 px-3 py-2.5">
                <Checkbox
                  className="mt-0.5"
                  checked={can && ticked.has(s.folder)}
                  disabled={!can}
                  aria-label={`On: ${s.name}`}
                  onCheckedChange={(v) => {
                    const next = new Set(ticked)
                    if (v) next.add(s.folder)
                    else next.delete(s.folder)
                    setTicked(next)
                  }}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-semibold">/{s.name || s.folder}</span>
                    <Badge variant={can ? 'secondary' : 'outline'}>{STATUS[s.status]}</Badge>
                    {s.files.length > 0 && (
                      <span className="text-xs text-muted-foreground">
                        {s.files.length} file{s.files.length === 1 ? '' : 's'}
                      </span>
                    )}
                  </div>
                  <span className="line-clamp-2 text-sm text-muted-foreground">
                    {s.problem ?? s.description}
                  </span>
                  {s.skipped.length > 0 && (
                    <span className="text-xs text-muted-foreground">
                      Left out, too large: {s.skipped.join(', ')}
                    </span>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
        <ScopeFields scope={scope} onChange={setScope} label="The pack applies to" />
        {error && <p className="text-sm text-destructive-text">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void save()}
            disabled={busy || addable.length === 0 || !name.trim()}
          >
            {review.pack
              ? 'Update the pack'
              : `Add ${addable.length} skill${addable.length === 1 ? '' : 's'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** A pack's name and where its skills apply. */
function PackEditDialog({
  pack,
  onClose,
  onSaved,
}: {
  pack: SkillPack
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [name, setName] = useState(pack.name)
  const [scope, setScope] = useState<Scope>(pack)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      await api(`/skills/packs/${pack.id}`, { method: 'PUT', body: { name, ...scope } })
      await onSaved()
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={(e) => void save(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Edit {pack.name}</DialogTitle>
            <DialogDescription>From {sourceLabel(pack.source)}.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pack-edit-name">Name</Label>
            <Input
              id="pack-edit-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={100}
            />
          </div>
          <ScopeFields scope={scope} onChange={setScope} label="Its skills apply to" />
          {error && <p className="text-sm text-destructive-text">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Every thread, or those of some teammates and projects. */
function ScopeFields({
  scope,
  onChange,
  label,
}: {
  scope: Scope
  onChange: (scope: Scope) => void
  label: string
}) {
  const { teammates, projects } = useDashboard()
  const toggleIn = (list: string[], id: string, on: boolean) =>
    on ? [...new Set([...list, id])] : list.filter((x) => x !== id)
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 text-sm font-semibold">{label}</legend>
      <RadioGroup
        value={scope.everywhere ? 'everywhere' : 'some'}
        onValueChange={(v) => onChange({ ...scope, everywhere: v === 'everywhere' })}
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
      {!scope.everywhere && (
        <div className="grid gap-4 pl-6 sm:grid-cols-2">
          {(teammates ?? []).length > 0 && (
            <ul className="flex flex-col gap-1.5" aria-label="Teammates">
              {(teammates ?? []).map((t) => (
                <li key={t.id}>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={scope.teammateIds.includes(t.id)}
                      onCheckedChange={(on) =>
                        onChange({ ...scope, teammateIds: toggleIn(scope.teammateIds, t.id, !!on) })
                      }
                    />
                    {t.name}
                  </label>
                </li>
              ))}
            </ul>
          )}
          {projects.some((p) => !p.archivedAt || scope.projectIds.includes(p.id)) && (
            <ul className="flex flex-col gap-1.5" aria-label="Projects">
              {projects
                .filter((p) => !p.archivedAt || scope.projectIds.includes(p.id))
                .map((p) => (
                  <li key={p.id}>
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={scope.projectIds.includes(p.id)}
                        onCheckedChange={(on) =>
                          onChange({
                            ...scope,
                            projectIds: toggleIn(scope.projectIds, p.id, !!on),
                          })
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
  const [name, setName] = useState(draft.name)
  const [description, setDescription] = useState(draft.description)
  const [instructions, setInstructions] = useState(draft.instructions)
  const [files, setFiles] = useState(draft.files)
  const [scope, setScope] = useState<Scope>(draft)
  const [enabled, setEnabled] = useState(draft.enabled)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const slug = skillSlug(name)

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      const body = { name: slug, description, instructions, files, ...scope, enabled }
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
              maxLength={4000}
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
              <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
                {files.map((f) => (
                  <li key={f.path} className="flex items-center gap-2 text-sm">
                    <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="flex-1 truncate font-mono text-xs">{f.path}</span>
                    <span className="text-xs text-muted-foreground">{size(f.size)}</span>
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
                  Left out, too large: {draft.skipped!.join(', ')}
                </p>
              )}
            </div>
          )}
          {draft.packId ? (
            <p className="text-sm text-muted-foreground">
              It applies where its pack does: change that on the pack.
            </p>
          ) : (
            <ScopeFields scope={scope} onChange={setScope} label="Applies to" />
          )}
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
