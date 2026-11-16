'use client'
// Preferences → Appearance (docs/themes.md): the member's own themes in this workspace, which a
// teammate makes with them. Wear one, take it off, go back to an earlier look, export one to
// share it, import one someone shared. Only theirs: nobody else's windows change.
import {
  SAFE_LOOK_PARAM,
  THEME_EXPORT_VERSION,
  THEME_RESET_SHORTCUT,
  ThemeExport,
  type LookChange,
  type ThemeList,
} from '@brigade/contracts'
import { MoreHorizontal } from 'lucide-react'
import { useRef, useState } from 'react'
import { SettingsGroup } from '@/components/settings-group'
import { useWornTheme } from '@/components/theme-runtime'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ActivityIndicator } from '@/components/ui/activity-indicator'
import { api, blobOfDataUrl, uploadFile, useApi } from '@/lib/api'
import { wearInWindow } from '@/lib/theme-runtime'

/** A look change in a few words. */
export function lookChangeText(change: Pick<LookChange, 'kind' | 'name' | 'count'>): string {
  switch (change.kind) {
    case 'made':
      return `Made ${change.name}`
    case 'edited':
      return `Edited ${change.name}`
    case 'wore':
      return `Wore ${change.name}`
    case 'off':
      return 'Took the theme off'
    case 'deleted':
      return `Deleted ${change.name}`
    case 'undid':
      return `Went back ${change.count === 1 ? '1 change' : `${change.count} changes`}`
  }
}

const dataUrlOf = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'))
    reader.readAsDataURL(blob)
  })

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function AppearanceSection() {
  const { data, reload } = useApi<ThemeList>('/themes', ['theme.changed'])
  const { safe } = useWornTheme()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string>()
  const importer = useRef<HTMLInputElement>(null)

  async function run(key: string, work: () => Promise<unknown>) {
    setBusy(key)
    setError(undefined)
    try {
      await work()
      reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const wear = (id: string | null) =>
    run(`wear:${id}`, async () => {
      if (id === null) wearInWindow(null)
      await api('/themes/active', { method: 'PUT', body: { id } })
    })

  const goBack = (seq: number) => run(`undo:${seq}`, () => api('/themes/undo', { body: { seq } }))

  const remove = (id: string) =>
    run(`delete:${id}`, () => api(`/themes/${id}`, { method: 'DELETE' }))

  const exportTheme = (id: string) =>
    run(`export:${id}`, async () => {
      const theme = await api<{ theme: unknown; files: Record<string, string> }>(`/themes/${id}`)
      const files: Record<string, string> = {}
      for (const [name, url] of Object.entries(theme.files)) {
        const response = await fetch(url, {
          credentials: url.startsWith('http') ? 'omit' : 'include',
        })
        if (!response.ok) throw new Error(`Could not read ${name}`)
        files[name] = await dataUrlOf(await response.blob())
      }
      const out = { brigadeTheme: THEME_EXPORT_VERSION, theme: theme.theme, files }
      download(`${id}.brigade-theme.json`, JSON.stringify(out, null, 2))
    })

  const importTheme = (file: File) =>
    run('import', async () => {
      let parsed: ReturnType<typeof ThemeExport.safeParse>
      try {
        parsed = ThemeExport.safeParse(JSON.parse(await file.text()))
      } catch {
        throw new Error('That file is not a Brigade theme.')
      }
      if (!parsed.success)
        throw new Error('That file is not a Brigade theme, or not one this Brigade reads.')
      const uploads: Record<string, string> = {}
      for (const [name, dataUrl] of Object.entries(parsed.data.files ?? {})) {
        const upload = await uploadFile('theme_file', blobOfDataUrl(dataUrl), { name })
        uploads[name] = upload.id
      }
      await api('/themes/import', { body: { theme: parsed.data.theme, files: uploads } })
    })

  const themes = data?.themes ?? []
  const history = data?.history ?? []
  return (
    <SettingsGroup title="Appearance">
      <div className="flex flex-col gap-1 px-5 py-4">
        <p className="text-sm leading-snug">Your own look for Brigade</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Ask a teammate to restyle Brigade for you, such as “make it look like an old terminal”. It
          changes only your windows. {THEME_RESET_SHORTCUT} takes a theme off, and ?
          {SAFE_LOOK_PARAM} in the address opens a tab without it.
        </p>
        {safe && (
          <p className="text-xs text-muted-foreground">
            This tab keeps Brigade’s own look (safe look).
          </p>
        )}
      </div>

      <Row
        title="Brigade’s own look"
        detail={data && !data.active ? 'Worn now' : 'Light or dark, as you pick in your menu'}
        action={
          data?.active ? (
            <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void wear(null)}>
              {busy === 'wear:null' ? <ActivityIndicator /> : 'Wear'}
            </Button>
          ) : null
        }
      />
      {themes.map((theme) => {
        const worn = data?.active === theme.id
        return (
          <Row
            key={theme.id}
            title={theme.name}
            detail={
              [
                worn ? 'Worn now' : null,
                theme.files.length
                  ? `${theme.files.length} file${theme.files.length === 1 ? '' : 's'}`
                  : null,
                theme.hasCss ? 'Its own CSS' : null,
              ]
                .filter(Boolean)
                .join(' · ') || 'Colours only'
            }
            action={
              <div className="flex items-center gap-1">
                {!worn && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!!busy}
                    onClick={() => void wear(theme.id)}
                  >
                    {busy === `wear:${theme.id}` ? <ActivityIndicator /> : 'Wear'}
                  </Button>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon" variant="ghost" aria-label={`More for ${theme.name}`}>
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => void exportTheme(theme.id)}>
                      Export
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onSelect={() => void remove(theme.id)}>
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            }
          />
        )
      })}
      <Row
        title="Import a theme"
        detail="A .brigade-theme.json someone exported. Checked like a teammate’s: it loads nothing from the internet."
        action={
          <>
            <input
              ref={importer}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) void importTheme(file)
              }}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={!!busy}
              onClick={() => importer.current?.click()}
            >
              {busy === 'import' ? <ActivityIndicator /> : 'Import'}
            </Button>
          </>
        }
      />
      {history.length > 0 && (
        <div className="flex flex-col gap-2 px-5 py-4">
          <p className="text-sm leading-snug">Recent changes</p>
          <ol className="flex flex-col">
            {history.slice(0, 10).map((change, index) => (
              <li key={change.seq} className="flex items-center justify-between gap-3 py-1 text-xs">
                <span className="min-w-0 truncate">
                  {lookChangeText(change)}
                  <span className="text-muted-foreground">
                    {' · '}
                    {change.by ?? 'You'}
                    {' · '}
                    {new Date(change.at).toLocaleString(undefined, {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}
                  </span>
                </span>
                {index === 0 ? (
                  <span className="text-muted-foreground">Now</span>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    disabled={!!busy}
                    onClick={() => void goBack(change.seq)}
                  >
                    {busy === `undo:${change.seq}` ? <ActivityIndicator /> : 'Go back here'}
                  </Button>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
      {error && <p className="px-5 py-3 text-xs text-destructive-text">{error}</p>}
    </SettingsGroup>
  )
}

function Row({
  title,
  detail,
  action,
}: {
  title: string
  detail: string
  action: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="truncate text-sm leading-snug">{title}</p>
        <p className="truncate text-xs text-muted-foreground">{detail}</p>
      </div>
      {action}
    </div>
  )
}
