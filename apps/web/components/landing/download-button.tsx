'use client'

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { API_URL } from '@/lib/config'
import { detectDevice } from '@/lib/device'
import { LINUX_APPIMAGE_URL, LINUX_DEB_URL } from '@/lib/linux-app'
import { MAC_APP_URL } from '@/lib/mac-app'
import { visitSource } from '@/lib/signup-source'
import { WINDOWS_APP_URL } from '@/lib/windows-app'
import { c, Icon } from './parts'

const RELEASES_URL = 'https://github.com/gmpetrov/brigade/releases/latest'

type Os = 'mac' | 'windows' | 'linux'

function AppleMark() {
  return (
    <svg className={c('os')} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
    </svg>
  )
}

function WindowsMark() {
  return (
    <svg className={c('os')} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 3h8.5v8.5H3zM12.5 3H21v8.5h-8.5zM3 12.5h8.5V21H3zM12.5 12.5H21V21h-8.5z" />
    </svg>
  )
}

function LinuxMark() {
  return (
    <svg className={c('os')} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.5c-2.2 0-3.6 1.8-3.6 4.4 0 1.2.3 2-.4 3.3-.9 1.6-2.6 3.6-2.6 6.2 0 .6.1 1.1.3 1.6-.8.3-1.6.7-1.4 1.5.2.9 1.6.6 2.8 1.2 1.2.6 2.3.9 3-.1.5.1 1.2.2 1.9.2s1.4-.1 1.9-.2c.7 1 1.8.7 3 .1 1.2-.6 2.6-.3 2.8-1.2.2-.8-.6-1.2-1.4-1.5.2-.5.3-1 .3-1.6 0-2.6-1.7-4.6-2.6-6.2-.7-1.3-.4-2.1-.4-3.3 0-2.6-1.4-4.4-3.6-4.4zm-1.5 3.3c.4 0 .7.5.7 1.1s-.3 1.1-.7 1.1-.7-.5-.7-1.1.3-1.1.7-1.1zm3 0c.4 0 .7.5.7 1.1s-.3 1.1-.7 1.1-.7-.5-.7-1.1.3-1.1.7-1.1zM12 8.6c.9 0 2 .6 2 1.1s-1.1 1.1-2 1.1-2-.6-2-1.1 1.1-1.1 2-1.1z" />
    </svg>
  )
}

const MAIN: Record<Os, { label: string; url: string; mark: ReactNode }> = {
  mac: { label: 'Download free for Mac', url: MAC_APP_URL, mark: <AppleMark /> },
  windows: { label: 'Download free for Windows', url: WINDOWS_APP_URL, mark: <WindowsMark /> },
  linux: { label: 'Download free for Linux', url: LINUX_DEB_URL, mark: <LinuxMark /> },
}

const ITEMS: { os?: Os; name: string; detail: string; url: string; mark: ReactNode }[] = [
  {
    os: 'mac',
    name: 'macOS',
    detail: 'Apple Silicon and Intel · .dmg',
    url: MAC_APP_URL,
    mark: <AppleMark />,
  },
  {
    os: 'windows',
    name: 'Windows',
    detail: 'Installer · .exe',
    url: WINDOWS_APP_URL,
    mark: <WindowsMark />,
  },
  {
    os: 'linux',
    name: 'Linux · Ubuntu, Debian',
    detail: '.deb',
    url: LINUX_DEB_URL,
    mark: <LinuxMark />,
  },
  { name: 'Linux · other', detail: '.AppImage', url: LINUX_APPIMAGE_URL, mark: <LinuxMark /> },
]

/**
 * Tell the API where this visit came from, for the guest Brigade.app makes from the same
 * address (apps/api/src/download-source.ts): the app's window knows nothing of the site. A
 * beacon, so leaving for the download does not cut it; plain text, so no preflight.
 */
function noteDownload() {
  try {
    navigator.sendBeacon(
      `${API_URL}/api/downloads`,
      new Blob([JSON.stringify(visitSource())], { type: 'text/plain' }),
    )
  } catch {
    // Nothing to do: the guest is then direct.
  }
}

/**
 * The hero's download: a split button that names the visitor's system and downloads its
 * Brigade.app (lib/mac-app.ts, windows-app.ts, linux-app.ts), and a menu with the other builds.
 * The page is prerendered, so it reads "Download free" until the browser says which system it
 * runs on. Hidden on phones (landing.module.css), where there is nothing to install.
 */
export function DownloadButton() {
  const [os, setOs] = useState<Os>()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const items = useRef<(HTMLAnchorElement | null)[]>([])

  useEffect(() => {
    const device = detectDevice(navigator.userAgent)
    if (device === 'mac' || device === 'windows' || device === 'linux') setOs(device)
  }, [])

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  function focusItem(i: number) {
    const list = items.current.filter(Boolean) as HTMLAnchorElement[]
    list[(i + list.length) % list.length]?.focus()
  }

  function onMenuKey(e: KeyboardEvent) {
    const list = items.current.filter(Boolean)
    const i = list.indexOf(document.activeElement as HTMLAnchorElement)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      focusItem(i + 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      focusItem(i - 1)
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  const main = os ? MAIN[os] : undefined

  return (
    // Escape closes the menu wherever focus is in it, the toggle included (opened by a click or
    // Enter, focus stays there), and puts focus back on the toggle.
    <div
      className={c('dl')}
      ref={box}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          setOpen(false)
          toggle.current?.focus()
        }
      }}
    >
      <div className={c('split')}>
        <a className={c('split-main')} href={main?.url ?? RELEASES_URL} onClick={noteDownload}>
          {main?.mark ?? <Icon name="download" />}
          {main?.label ?? 'Download free'}
        </a>
        <button
          ref={toggle}
          type="button"
          className={c('split-more')}
          aria-label="Other platforms"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setOpen(true)
              requestAnimationFrame(() => focusItem(0))
            }
          }}
        >
          <Icon name="chevron" />
        </button>
      </div>
      {open && (
        <div
          className={c('dl-menu')}
          role="menu"
          aria-label="Download Brigade.app"
          onKeyDown={onMenuKey}
        >
          <div className={c('dl-lbl')}>Download Brigade.app</div>
          {ITEMS.map((item, i) => (
            <a
              key={item.url}
              ref={(el) => {
                items.current[i] = el
              }}
              role="menuitem"
              href={item.url}
              aria-current={item.os && item.os === os ? 'true' : undefined}
              onClick={() => {
                noteDownload()
                setOpen(false)
              }}
            >
              {item.mark}
              <span className={c('dl-t')}>
                <b>{item.name}</b>
                <span>{item.detail}</span>
              </span>
              <span className={c('dl-ck')}>
                <Icon name="check" />
              </span>
            </a>
          ))}
          <hr />
          <a
            ref={(el) => {
              items.current[ITEMS.length] = el
            }}
            role="menuitem"
            className={c('dl-all')}
            href={RELEASES_URL}
            target="_blank"
            rel="noreferrer"
            onClick={() => setOpen(false)}
          >
            <Icon name="external" />
            <span className={c('dl-t')}>
              <b>All releases on GitHub</b>
            </span>
          </a>
        </div>
      )}
    </div>
  )
}
