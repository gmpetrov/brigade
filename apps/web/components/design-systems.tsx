'use client'
// The workspace's design systems: each a library folder (its README, tokens
// and assets) and where it applies. Teammates making a design pick one: the
// one named, then by library folder, repository, teammate, the default.
// Owners and admins change them; a teammate makes one and registers it.
import { DESIGN_SYSTEM_PREVIEW, type DesignSystem, type LibraryFile } from '@brigade/contracts'
import { Ellipsis, FolderOpen, Palette, Pencil, Plus, Sparkles, Star, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { DesignPanel } from '@/components/design-view'
import { Markdown } from '@/components/markdown'
import { NewThread, useLastTeammate, useThreadDraft } from '@/components/new-thread'
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api, useApi, type LibraryTree, type Teammate } from '@/lib/api'
import { API_URL } from '@/lib/config'

/** Where design systems go. */
const FOLDER = 'design-systems'
const PREVIEW = DESIGN_SYSTEM_PREVIEW

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'design-system'

const list = (text: string) =>
  text
    .split(/[\n,]/)
    .map((s) => s.trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)

export function DesignSystems({
  tree,
  teammates,
  admin,
}: {
  tree: LibraryTree | undefined
  teammates: Teammate[] | undefined
  admin: boolean
}) {
  const systems = useApi<DesignSystem[]>('/design-systems')
  const [editing, setEditing] = useState<DesignSystem | 'new'>()
  const [asking, setAsking] = useState(false)
  const [preview, setPreview] = useState<string>()
  const [error, setError] = useState<string>()

  async function remove(system: DesignSystem) {
    if (!confirm(`Remove the design system ${system.name}? Its folder stays in the library.`))
      return
    setError(undefined)
    try {
      await api(`/design-systems/${system.id}`, { method: 'DELETE' })
      await systems.reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          The rules, tokens and assets designs follow, each in a library folder. A teammate making a
          design uses the one named in the message; otherwise the one for the folder the design goes
          in, the repository it works in, the teammate, then the default.
        </p>
        <div className="flex gap-2">
          {admin && (
            <Button variant="outline" onClick={() => setEditing('new')}>
              <Plus />
              Add
            </Button>
          )}
          <Button onClick={() => setAsking(true)}>
            <Sparkles />
            Ask a teammate
          </Button>
        </div>
      </div>
      {error && <p className="text-sm text-destructive-text">{error}</p>}

      {!systems.data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : systems.data.length === 0 ? (
        <Card className="items-center gap-3 border-dashed px-6 py-12 text-center shadow-none">
          <span
            aria-hidden
            className="flex size-11 items-center justify-center rounded-md bg-primary/15 text-primary"
          >
            <Palette className="size-5" />
          </span>
          <p className="font-semibold">No design system yet.</p>
          <p className="max-w-md text-sm text-muted-foreground">
            Without one, teammates follow the look of the product they design for when they can find
            it. Ask a teammate for one, from a repository or your brand files, and every design
            looks like your product.
          </p>
        </Card>
      ) : (
        systems.data.map((system) => (
          <SystemCard
            key={system.id}
            system={system}
            files={(tree?.files ?? []).filter((f) => f.path.startsWith(`${system.path}/`))}
            teammates={teammates ?? []}
            admin={admin}
            onEdit={() => setEditing(system)}
            onRemove={() => void remove(system)}
            onPreview={() => setPreview(`${system.path}/${PREVIEW}`)}
          />
        ))
      )}

      {editing && (
        <EditDialog
          system={editing === 'new' ? undefined : editing}
          teammates={teammates ?? []}
          onClose={() => setEditing(undefined)}
          onSaved={systems.reload}
        />
      )}
      {asking && (
        <AskTeammateDialog
          teammates={teammates ?? []}
          first={systems.data?.length === 0}
          onClose={() => {
            setAsking(false)
            void systems.reload()
          }}
        />
      )}
      {preview && <DesignPanel folder={preview} onClose={() => setPreview(undefined)} />}
    </>
  )
}

/** CSS custom properties in a stylesheet: `--name: value`. */
function tokensOf(css: string) {
  return [...css.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)[;}]/g)].map(([, name, value]) => ({
    name: name!,
    value: value!.trim(),
  }))
}

const COLOR = /^(#[0-9a-f]{3,8}|(rgb|hsl|oklch|oklab|lab|lch|color)a?\(.+\))$/i

function SystemCard({
  system,
  files,
  teammates,
  admin,
  onEdit,
  onRemove,
  onPreview,
}: {
  system: DesignSystem
  files: LibraryFile[]
  teammates: Teammate[]
  admin: boolean
  onEdit: () => void
  onRemove: () => void
  onPreview: () => void
}) {
  const readme = files.find((f) => f.path === `${system.path}/README.md`)
  const tokens = files.find((f) => f.path === `${system.path}/tokens.css`)
  const hasPreview = files.some((f) => f.path === `${system.path}/${PREVIEW}/index.html`)
  const [colors, setColors] = useState<{ name: string; value: string }[]>([])
  const [readmeText, setReadmeText] = useState<string>()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!tokens) return setColors([])
    let live = true
    void fetch(`${API_URL}/api/library/${tokens.id}/content`, { credentials: 'include' })
      .then((r) => (r.ok ? r.text() : ''))
      .then((css) => {
        if (!live) return
        // The first value of each name: light mode, when dark redefines them.
        const seen = new Set<string>()
        setColors(
          tokensOf(css).filter(
            (t) => COLOR.test(t.value) && !seen.has(t.name) && Boolean(seen.add(t.name)),
          ),
        )
      })
    return () => {
      live = false
    }
  }, [tokens?.id, tokens?.updatedAt]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || !readme) return
    let live = true
    void fetch(`${API_URL}/api/library/${readme.id}/content`, { credentials: 'include' })
      .then((r) => (r.ok ? r.text() : ''))
      .then((text) => live && setReadmeText(text))
    return () => {
      live = false
    }
  }, [open, readme?.id, readme?.updatedAt]) // eslint-disable-line react-hooks/exhaustive-deps

  const applies = [
    ...system.folders.map((f) => ({ key: `f:${f}`, label: `${f}/`, mono: true })),
    ...system.repositories.map((r) => ({ key: `r:${r}`, label: r, mono: true })),
    ...system.teammateIds.map((id) => ({
      key: `t:${id}`,
      label: teammates.find((t) => t.id === id)?.name ?? 'A teammate',
      mono: false,
    })),
  ]

  return (
    <Card className="gap-3 px-6">
      <div className="flex items-start gap-4">
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"
        >
          <Palette className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="flex flex-wrap items-center gap-2 text-base font-bold">
            {system.name}
            {system.isDefault && (
              <Badge variant="secondary">
                <Star aria-hidden />
                Default
              </Badge>
            )}
          </h2>
          {system.description && (
            <p className="text-sm text-muted-foreground">{system.description}</p>
          )}
          <Link
            href={`/app/library?folder=${encodeURIComponent(system.path)}`}
            className="w-fit font-mono text-xs text-muted-foreground hover:underline"
          >
            {system.path}/
          </Link>
        </div>
        {hasPreview && (
          <Button variant="outline" size="sm" onClick={onPreview}>
            Preview
          </Button>
        )}
        {admin && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Actions for ${system.name}`}
                title="Actions"
              >
                <Ellipsis aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onEdit}>
                <Pencil aria-hidden />
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={`/app/library?folder=${encodeURIComponent(system.path)}`}>
                  <FolderOpen aria-hidden />
                  Its files
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onRemove}>
                <Trash2 aria-hidden />
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {colors.length > 0 && (
        <ul aria-label="Colors" className="flex flex-wrap gap-1.5">
          {colors.slice(0, 32).map((c) => (
            <li
              key={c.name}
              title={`${c.name}: ${c.value}`}
              className="size-7 rounded-md border shadow-xs"
              style={{ background: c.value }}
            />
          ))}
        </ul>
      )}

      <p className="text-xs text-muted-foreground">
        {applies.length === 0 && !system.isDefault ? (
          'Used when a message names it.'
        ) : (
          <span className="flex flex-wrap items-center gap-1.5">
            {applies.length > 0 && 'For'}
            {applies.map((a) => (
              <Badge key={a.key} variant="outline" className={a.mono ? 'font-mono' : undefined}>
                {a.label}
              </Badge>
            ))}
            {system.isDefault && (applies.length > 0 ? 'and everything else' : 'For everything')}
          </span>
        )}
      </p>

      {readme ? (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="w-fit text-xs font-medium text-primary hover:underline"
          >
            {open ? 'Hide the rules' : 'Show the rules (README.md)'}
          </button>
          {open &&
            (readmeText === undefined ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              <Markdown text={readmeText} className="rounded-md border p-4 text-sm" />
            ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Its folder has no README.md yet: teammates have no rules to follow.
        </p>
      )}
    </Card>
  )
}

function EditDialog({
  system,
  teammates,
  onClose,
  onSaved,
}: {
  system?: DesignSystem
  teammates: Teammate[]
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [name, setName] = useState(system?.name ?? '')
  const [description, setDescription] = useState(system?.description ?? '')
  const [path, setPath] = useState(system?.path ?? '')
  const [isDefault, setDefault] = useState(system?.isDefault ?? false)
  const [folders, setFolders] = useState(system?.folders.join(', ') ?? '')
  const [repositories, setRepositories] = useState(system?.repositories.join(', ') ?? '')
  const [chosen, setChosen] = useState(new Set(system?.teammateIds ?? []))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      const body = {
        name,
        description,
        path: path.trim() || `${FOLDER}/${slug(name)}`,
        isDefault,
        folders: list(folders),
        repositories: list(repositories),
        teammateIds: [...chosen],
      }
      await api(system ? `/design-systems/${system.id}` : '/design-systems', {
        method: system ? 'PUT' : 'POST',
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={(e) => void save(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{system ? `Edit ${system.name}` : 'Add a design system'}</DialogTitle>
            <DialogDescription>
              Its folder holds README.md (the rules), tokens.css and assets. Teammates read it
              before they design.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ds-name">Name</Label>
            <Input
              id="ds-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={60}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ds-description">Description</Label>
            <Textarea
              id="ds-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder="What it is for, in a line"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ds-path">Library folder</Label>
            <Input
              id="ds-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={`${FOLDER}/${slug(name || 'name')}`}
              className="font-mono"
            />
          </div>
          <label className="flex items-start justify-between gap-4 rounded-lg border p-3">
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-semibold">Default</span>
              <span className="text-xs text-muted-foreground">
                Used when nothing more specific applies. Replaces the current default.
              </span>
            </span>
            <Switch checked={isDefault} onCheckedChange={setDefault} aria-label="Default" />
          </label>
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-sm font-semibold">Applies to</legend>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ds-folders">Designs saved in these library folders</Label>
              <Input
                id="ds-folders"
                value={folders}
                onChange={(e) => setFolders(e.target.value)}
                placeholder="acme, marketing/acme"
                className="font-mono"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ds-repositories">Work in these repositories</Label>
              <Input
                id="ds-repositories"
                value={repositories}
                onChange={(e) => setRepositories(e.target.value)}
                placeholder="acme/web, acme/mobile"
                className="font-mono"
              />
            </div>
            {teammates.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">These teammates</span>
                <ul className="flex flex-col gap-1.5">
                  {teammates.map((t) => (
                    <li key={t.id}>
                      <label className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={chosen.has(t.id)}
                          onCheckedChange={(on) => {
                            const next = new Set(chosen)
                            if (on) next.add(t.id)
                            else next.delete(t.id)
                            setChosen(next)
                          }}
                        />
                        {t.name}
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </fieldset>
          {error && <p className="text-sm text-destructive-text">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {system ? 'Save' : 'Add'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** What the thread that makes a design system is asked to do. */
function briefing(name: string, repository: string, folder: string, isDefault: boolean) {
  const where = [repository && `work in ${repository}`, isDefault && 'the default']
    .filter(Boolean)
    .join(' and ')
  return [
    repository
      ? `Create the design system "${name}" from @[${repository}](repository:${repository}). Read its styles, ` +
        'theme, components and brand assets.'
      : `Create the design system "${name}" from what I attach and describe below.`,
    `Save it with \`save_design_system\` to \`${folder}\`${where ? `, applying to ${where}` : ''}.`,
    'Take values from the source, not from guesses. Say what you could not find.',
    ...(repository ? [] : ['', '']),
  ].join('\n')
}

/** Ask a teammate to make a design system: it writes the folder and registers it. */
function AskTeammateDialog({
  teammates,
  first,
  onClose,
}: {
  teammates: Teammate[]
  first: boolean
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [repository, setRepository] = useState('')
  const [isDefault, setDefault] = useState(first)
  const [briefed, setBriefed] = useState(false)
  const draft = useThreadDraft()
  const [lastId, setLastId] = useLastTeammate()
  const teammate = teammates.find((t) => t.id === lastId) ?? teammates[0]

  function brief(e: React.FormEvent) {
    e.preventDefault()
    const repo = repository
      .trim()
      .replace(/^https:\/\/github\.com\//, '')
      .replace(/\.git$/, '')
      .toLowerCase()
    draft.setText(briefing(name.trim(), repo, `${FOLDER}/${slug(name)}`, isDefault))
    setBriefed(true)
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Ask a teammate for a design system</DialogTitle>
          <DialogDescription>
            {briefed
              ? 'Change the message if you like, attach an export or brand files, then start the thread. The teammate saves the design system to the library and teammates follow it from then on.'
              : 'A teammate reads a repository, or files you attach, and writes the rules, tokens and assets designs follow.'}
          </DialogDescription>
        </DialogHeader>
        {!briefed ? (
          <form onSubmit={brief} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dsr-name">Name</Label>
              <Input
                id="dsr-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Acme"
                required
                maxLength={60}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dsr-repo">Repository (optional)</Label>
              <Input
                id="dsr-repo"
                value={repository}
                onChange={(e) => setRepository(e.target.value)}
                placeholder="acme/web"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                It applies to work in that repository. The teammate needs a GitHub connection that
                reaches it. Leave it empty to attach files or describe it instead.
              </p>
            </div>
            <label className="flex items-center justify-between gap-4 rounded-lg border p-3">
              <span className="text-sm font-semibold">Make it the default</span>
              <Switch checked={isDefault} onCheckedChange={setDefault} aria-label="Default" />
            </label>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={!name.trim()}>
                Continue
              </Button>
            </DialogFooter>
          </form>
        ) : teammate ? (
          <NewThread
            teammate={teammate}
            picker={{ teammates, onChange: setLastId }}
            draft={draft}
            rows={10}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Add a teammate first, then ask it to write the design system.
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
