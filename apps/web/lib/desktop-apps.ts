'use client'
// Installing a library app on this computer (docs/apps.md, Installed apps), from its menu in the
// dashboard, in Brigade.app only: the app then opens in a window of its own, from its own icon.
// The dashboard gives Brigade.app the title and the icon, drawn here from the app's picture
// (thumbnail.png), or a gradient and the title's first letter when it has none; Brigade.app asks
// the person, then installs it (apps/desktop/src/app-windows.ts).
import { TOOL_THUMBNAIL, type LibraryFile } from '@brigade/contracts'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { desktopBridge, type InstalledDesktopApp } from '@/lib/desktop-bridge'
import { contentUrl } from '@/lib/library-urls'

/** Whether this page can install apps: in Brigade.app's dashboard window, recent enough. */
export const canInstallApps = () => {
  const bridge = desktopBridge()
  return bridge?.info.window === 'main' && !!bridge.apps
}

/** The apps installed on this computer, kept current; undefined where none can be. */
export function useInstalledApps(): InstalledDesktopApp[] | undefined {
  const [list, setList] = useState<InstalledDesktopApp[]>()
  useEffect(() => {
    if (!canInstallApps()) return
    const apps = desktopBridge()!.apps!
    let live = true
    apps.installed().then(
      (l) => live && setList(l),
      () => live && setList([]),
    )
    const stop = apps.onChanged((l) => live && setList(l))
    return () => {
      live = false
      stop()
    }
  }, [])
  return list
}

/** A hue of its own for each title, the same each time. */
export function hueOf(title: string) {
  let h = 0
  for (const c of title) h = (h * 31 + (c.codePointAt(0) ?? 0)) >>> 0
  return h % 360
}

/** The letter its drawn icon shows: the title's first letter or digit. */
export function initialOf(title: string) {
  const match = /[\p{L}\p{N}]/u.exec(title.normalize('NFC'))
  return (match?.[0] ?? '•').toLocaleUpperCase()
}

const SIZE = 1024

function roundedSquare(ctx: CanvasRenderingContext2D, x: number, size: number, radius: number) {
  ctx.beginPath()
  ctx.roundRect(x, x, size, size, radius)
  ctx.closePath()
}

/**
 * The app's icon, a 1024px PNG: its picture cropped to a square (or the drawn one) in a rounded
 * square. macOS icons keep a margin around the square, as the system's own do.
 */
export async function drawAppIcon(title: string, picture: Blob | undefined, platform?: string) {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not draw the icon')
  const mac = platform === 'darwin'
  const inset = mac ? 100 : 0
  const size = SIZE - inset * 2
  const radius = mac ? 185 : 160
  roundedSquare(ctx, inset, size, radius)
  ctx.save()
  ctx.clip()
  const hue = hueOf(title)
  const gradient = ctx.createLinearGradient(0, inset, 0, inset + size)
  gradient.addColorStop(0, `hsl(${hue} 70% 58%)`)
  gradient.addColorStop(1, `hsl(${(hue + 40) % 360} 72% 42%)`)
  ctx.fillStyle = gradient
  ctx.fillRect(inset, inset, size, size)
  let drawn = false
  if (picture) {
    try {
      const image = await createImageBitmap(picture)
      // Its top left, the app's header and first content, as a square.
      const side = Math.min(image.width, image.height)
      ctx.drawImage(image, 0, 0, side, side, inset, inset, size, size)
      image.close()
      drawn = true
    } catch {
      // Not an image after all: the drawn icon.
    }
  }
  if (!drawn) {
    ctx.fillStyle = 'white'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = `600 ${Math.round(size * 0.56)}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`
    ctx.fillText(initialOf(title), SIZE / 2, SIZE / 2 + size * 0.03)
  }
  ctx.restore()
  if (mac) {
    // The thin edge macOS icons have, so a light picture keeps its shape on a light Dock.
    roundedSquare(ctx, inset + 1, size - 2, radius)
    ctx.strokeStyle = 'rgba(0,0,0,0.12)'
    ctx.lineWidth = 2
    ctx.stroke()
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('Could not draw the icon')
  return new Uint8Array(await blob.arrayBuffer())
}

/** The app's picture (its thumbnail.png), if it has one. */
async function pictureOf(folder: string) {
  try {
    const files = await api<LibraryFile[]>('/library')
    const file = files.find((f) => f.path === `${folder}/${TOOL_THUMBNAIL}`)
    if (!file) return undefined
    const response = await fetch(contentUrl(file.id), { credentials: 'include' })
    return response.ok ? await response.blob() : undefined
  } catch {
    return undefined
  }
}

/** Installs the app (Brigade.app asks first): what it was installed as, or null if not. */
export async function installApp(input: {
  appId: string
  folder: string
  title: string
  workspace: { id: string; name: string }
}) {
  const bridge = desktopBridge()
  if (!bridge?.apps) throw new Error('Update Brigade to install apps.')
  const iconPng = await drawAppIcon(
    input.title,
    await pictureOf(input.folder),
    bridge.info.platform,
  )
  return bridge.apps.install({
    appId: input.appId,
    path: input.folder,
    title: input.title,
    iconPng,
    workspaceId: input.workspace.id,
    workspaceName: input.workspace.name,
  })
}
