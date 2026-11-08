'use client'
// The product's version and the build this dashboard runs (docs/versions.md), at the foot of
// Preferences: quiet, seen only at the bottom, and a click copies both for a support message.
import { useState } from 'react'

const VERSION = process.env.NEXT_PUBLIC_VERSION
const BUILD = process.env.NEXT_PUBLIC_BUILD_ID

export function BuildInfo() {
  const [copied, setCopied] = useState(false)
  if (!VERSION || !BUILD) return null
  return (
    <button
      type="button"
      onClick={() => {
        // Without the clipboard (an insecure page, a refused permission) the line stays on
        // screen to read: no error to report.
        navigator.clipboard
          ?.writeText(`Brigade v${VERSION} (${BUILD})`)
          .then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
          .catch(() => {})
      }}
      aria-label={copied ? 'Copied' : `Copy Brigade v${VERSION}, build ${BUILD}`}
      className="text-muted-foreground hover:text-foreground self-start rounded font-mono text-xs transition-colors"
    >
      {copied ? 'Copied' : `Brigade v${VERSION} · build ${BUILD}`}
    </button>
  )
}
