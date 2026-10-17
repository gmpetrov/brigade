'use client'
import { useState, type ReactNode } from 'react'
import { Plug, Webhook } from 'lucide-react'
import type { Connection } from '@/lib/api'
import { cn } from '@/lib/utils'

export type ProviderKind = Connection['kind']

/**
 * Each service's own mark: Google's Gmail, Calendar, Drive, Docs and Sheets icons, Stripe's
 * app icon, Cloudflare's cloud, Google Cloud's four-color cloud, Neon's square N, Supabase's
 * bolt, GitHub's Invertocat (in the text color, so it reads in both themes), and a
 * generic webhook mark for custom apps.
 */
export function ProviderLogo({ kind, className }: { kind: ProviderKind; className?: string }) {
  const common = { 'aria-hidden': true, className: cn('size-6 shrink-0', className) } as const
  if (kind === 'gmail')
    return (
      <svg viewBox="52 42 88 66" {...common}>
        <path fill="#4285f4" d="M58 108h14V74L52 59v43c0 3.32 2.69 6 6 6" />
        <path fill="#34a853" d="M120 108h14c3.32 0 6-2.69 6-6V59l-20 15" />
        <path fill="#fbbc04" d="M120 48v26l20-15v-8c0-7.42-8.47-11.65-14.4-7.2" />
        <path fill="#ea4335" d="M72 74V48l24 18 24-18v26L96 92" />
        <path fill="#c5221f" d="M52 51v8l20 15V48l-5.6-4.2c-5.94-4.45-14.4-.22-14.4 7.2" />
      </svg>
    )
  if (kind === 'google_calendar')
    return (
      <svg viewBox="0 0 200 200" {...common}>
        <g transform="translate(3.75 3.75)">
          <path
            fill="#ffffff"
            d="M148.882,43.618l-47.368-5.263l-57.895,5.263L38.355,96.25l5.263,52.632l52.632,6.579l52.632-6.579 l5.263-53.947L148.882,43.618z"
          />
          <path
            fill="#1a73e8"
            d="M65.211,125.276c-3.934-2.658-6.658-6.539-8.145-11.671l9.132-3.763c0.829,3.158,2.276,5.605,4.342,7.342 c2.053,1.737,4.553,2.592,7.474,2.592c2.987,0,5.553-0.908,7.697-2.724s3.224-4.132,3.224-6.934c0-2.868-1.132-5.211-3.395-7.026 s-5.105-2.724-8.5-2.724h-5.276v-9.039H76.5c2.921,0,5.382-0.789,7.382-2.368c2-1.579,3-3.737,3-6.487 c0-2.447-0.895-4.395-2.684-5.855s-4.053-2.197-6.803-2.197c-2.684,0-4.816,0.711-6.395,2.145s-2.724,3.197-3.447,5.276 l-9.039-3.763c1.197-3.395,3.395-6.395,6.618-8.987c3.224-2.592,7.342-3.895,12.342-3.895c3.697,0,7.026,0.711,9.974,2.145 c2.947,1.434,5.263,3.421,6.934,5.947c1.671,2.539,2.5,5.382,2.5,8.539c0,3.224-0.776,5.947-2.329,8.184 c-1.553,2.237-3.461,3.947-5.724,5.145v0.539c2.987,1.25,5.421,3.158,7.342,5.724c1.908,2.566,2.868,5.632,2.868,9.211 s-0.908,6.776-2.724,9.579c-1.816,2.803-4.329,5.013-7.513,6.618c-3.197,1.605-6.789,2.421-10.776,2.421 C73.408,129.263,69.145,127.934,65.211,125.276z"
          />
          <path
            fill="#1a73e8"
            d="M121.25,79.961l-9.974,7.25l-5.013-7.605l17.987-12.974h6.895v61.197h-9.895L121.25,79.961z"
          />
          <path
            fill="#ea4335"
            d="M148.882,196.25l47.368-47.368l-23.684-10.526l-23.684,10.526l-10.526,23.684L148.882,196.25z"
          />
          <path
            fill="#34a853"
            d="M33.092,172.566l10.526,23.684h105.263v-47.368H43.618L33.092,172.566z"
          />
          <path
            fill="#4285f4"
            d="M12.039-3.75C3.316-3.75-3.75,3.316-3.75,12.039v136.842l23.684,10.526l23.684-10.526V43.618h105.263 l10.526-23.684L148.882-3.75H12.039z"
          />
          <path
            fill="#188038"
            d="M-3.75,148.882v31.579c0,8.724,7.066,15.789,15.789,15.789h31.579v-47.368H-3.75z"
          />
          <path
            fill="#fbbc04"
            d="M148.882,43.618v105.263h47.368V43.618l-23.684-10.526L148.882,43.618z"
          />
          <path
            fill="#1967d2"
            d="M196.25,43.618V12.039c0-8.724-7.066-15.789-15.789-15.789h-31.579v47.368H196.25z"
          />
        </g>
      </svg>
    )
  if (kind === 'webhook') return <Webhook {...common} />
  if (kind === 'mcp') return <Plug {...common} />
  if (kind === 'cloudflare')
    return (
      <svg viewBox="0 0 66 30" {...common}>
        <path
          fill="#f6821f"
          d="M52.688 13.028c-.22 0-.437.008-.654.015a.3.3 0 0 0-.102.024.37.37 0 0 0-.236.255l-.93 3.249c-.401 1.397-.252 2.687.422 3.634.618.876 1.646 1.39 2.894 1.45l5.045.306a.45.45 0 0 1 .435.41.5.5 0 0 1-.025.223.64.64 0 0 1-.547.426l-5.242.306c-2.848.132-5.912 2.456-6.987 5.29l-.378 1a.28.28 0 0 0 .248.382h18.054a.48.48 0 0 0 .464-.35c.32-1.153.482-2.344.48-3.54 0-7.22-5.79-13.072-12.933-13.072M44.807 29.578l.334-1.175c.402-1.397.253-2.687-.42-3.634-.62-.876-1.647-1.39-2.896-1.45l-23.665-.306a.47.47 0 0 1-.374-.199.5.5 0 0 1-.052-.434.64.64 0 0 1 .552-.426l23.886-.306c2.836-.131 5.9-2.456 6.975-5.29l1.362-3.6a.9.9 0 0 0 .04-.477C48.997 5.259 42.789 0 35.367 0c-6.842 0-12.647 4.462-14.73 10.665a6.92 6.92 0 0 0-4.911-1.374c-3.28.33-5.92 3.002-6.246 6.318a7.2 7.2 0 0 0 .18 2.472C4.3 18.241 0 22.679 0 28.133q0 .74.106 1.453a.46.46 0 0 0 .457.402h43.704a.57.57 0 0 0 .54-.418"
        />
      </svg>
    )
  if (kind === 'google_drive')
    return (
      <svg viewBox="0 0 87.3 78" {...common}>
        <path
          fill="#0066da"
          d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z"
        />
        <path
          fill="#00ac47"
          d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0-1.2 4.5h27.5z"
        />
        <path
          fill="#ea4335"
          d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z"
        />
        <path
          fill="#00832d"
          d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z"
        />
        <path
          fill="#2684fc"
          d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z"
        />
        <path
          fill="#ffba00"
          d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z"
        />
      </svg>
    )
  if (kind === 'google_docs')
    return (
      <svg viewBox="0 0 47 65" {...common}>
        <path
          fill="#4285f4"
          d="M29.375 0H4.406A4.406 4.406 0 0 0 0 4.406v56.188A4.406 4.406 0 0 0 4.406 65h38.188A4.406 4.406 0 0 0 47 60.594V17.625L29.375 0z"
        />
        <path fill="#a1c2fa" d="M29.375 0v13.219a4.406 4.406 0 0 0 4.406 4.406H47L29.375 0z" />
        <path
          fill="#f1f1f1"
          d="M11.75 47.531h23.5v-2.937h-23.5v2.937zm0 5.875h17.625v-2.937H11.75v2.937zm0-20.562v2.937h23.5v-2.937h-23.5zm0 8.812h23.5v-2.937h-23.5v2.937z"
        />
      </svg>
    )
  if (kind === 'google_sheets')
    return (
      <svg viewBox="0 0 47 65" {...common}>
        <path
          fill="#0f9d58"
          d="M29.375 0H4.406A4.406 4.406 0 0 0 0 4.406v56.188A4.406 4.406 0 0 0 4.406 65h38.188A4.406 4.406 0 0 0 47 60.594V17.625L29.375 0z"
        />
        <path fill="#87ceac" d="M29.375 0v13.219a4.406 4.406 0 0 0 4.406 4.406H47L29.375 0z" />
        <path
          fill="#f1f1f1"
          d="M11.75 31.719v20.562h23.5V31.719h-23.5zm10.281 17.625h-7.344v-3.672h7.344v3.672zm0-5.875h-7.344v-3.672h7.344v3.672zm0-5.875h-7.344v-3.672h7.344v3.672zm10.282 11.75h-7.344v-3.672h7.344v3.672zm0-5.875h-7.344v-3.672h7.344v3.672zm0-5.875h-7.344v-3.672h7.344v3.672z"
        />
      </svg>
    )
  if (kind === 'google_cloud')
    return (
      <svg viewBox="0 0 256 206" {...common}>
        <path
          fill="#ea4335"
          d="M170.25 56.82l22.25-22.25 1.48-9.37C153.44-11.68 88.98-7.5 52.42 33.92 42.27 45.42 34.73 59.76 30.72 74.57l7.97-1.12 44.5-7.34 3.44-3.51c19.8-21.75 53.27-24.67 76.13-6.17l7.5.39z"
        />
        <path
          fill="#4285f4"
          d="M224.2 73.92a100.3 100.3 0 0 0-30.22-48.72l-31.23 31.23a55.5 55.5 0 0 1 20.38 44.04v5.54c15.35 0 27.8 12.45 27.8 27.8s-12.45 27.48-27.8 27.48h-55.67l-5.47 5.94v33.34l5.47 5.23h55.67c39.93.31 72.55-31.49 72.86-71.42a72.3 72.3 0 0 0-31.79-60.46"
        />
        <path
          fill="#34a853"
          d="M71.87 205.8h55.59v-44.51H71.87a27.6 27.6 0 0 1-11.4-2.5l-7.89 2.42-22.41 22.25-1.95 7.58a72 72 0 0 0 43.65 14.76"
        />
        <path
          fill="#fbbc05"
          d="M71.87 61.43C31.94 61.66-.24 94.23 0 134.16a72.3 72.3 0 0 0 28.22 56.88l32.25-32.25c-13.99-6.32-20.21-22.79-13.89-36.78s22.79-20.21 36.78-13.89a27.8 27.8 0 0 1 13.89 13.89l32.25-32.25a72.2 72.2 0 0 0-57.63-28.34"
        />
      </svg>
    )
  if (kind === 'neon')
    return (
      <svg viewBox="18 17.5 144 145" {...common}>
        <path
          className="fill-[#37c38f] dark:fill-[#34d59a]"
          d="M162 17.5406V162.5L105.812 113.897V162.5H18V17.5L162 17.5406ZM35.6515 144.901H88.1606V75.278L144.349 124.843V35.1348L35.6515 35.1037V144.901Z"
        />
      </svg>
    )
  if (kind === 'supabase')
    return (
      <svg viewBox="0 0 109 113" {...common}>
        <defs>
          <linearGradient
            id="supabase-logo-a"
            x1="53.97"
            y1="54.97"
            x2="94.16"
            y2="71.83"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#249361" />
            <stop offset="1" stopColor="#3ecf8e" />
          </linearGradient>
          <linearGradient
            id="supabase-logo-b"
            x1="36.16"
            y1="30.58"
            x2="54.48"
            y2="65.08"
            gradientUnits="userSpaceOnUse"
          >
            <stop />
            <stop offset="1" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path
          fill="url(#supabase-logo-a)"
          d="M63.71 110.28c-2.86 3.6-8.66 1.63-8.73-2.97l-1-67.25h45.22c8.19 0 12.76 9.46 7.67 15.87z"
        />
        <path
          fill="url(#supabase-logo-b)"
          fillOpacity="0.2"
          d="M63.71 110.28c-2.86 3.6-8.66 1.63-8.73-2.97l-1-67.25h45.22c8.19 0 12.76 9.46 7.67 15.87z"
        />
        <path
          fill="#3ecf8e"
          d="M45.32 2.07c2.86-3.6 8.66-1.63 8.72 2.97l.44 67.25H9.83c-8.19 0-12.76-9.46-7.67-15.87z"
        />
      </svg>
    )
  if (kind === 'stripe')
    return (
      <svg viewBox="0 0 24 24" {...common}>
        <rect width="24" height="24" rx="5.5" fill="#635bff" />
        <path
          fill="#fff"
          transform="translate(4.7 4.8) scale(0.6)"
          d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z"
        />
      </svg>
    )
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...common}>
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  )
}

/** The logo on a tile, where a connection is listed. An MCP server shows its own icon, if any. */
export function ProviderTile({
  kind,
  small,
  icons,
}: {
  kind: ProviderKind
  small?: boolean
  /** Images to try, best first (an MCP server's icon, its site's); the kind's mark if none loads. */
  icons?: string[]
}) {
  const className = small ? 'size-[18px]' : 'size-6'
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center rounded-md bg-secondary text-foreground',
        small ? 'size-8' : 'size-11',
      )}
    >
      <ServerIcon
        key={icons?.join(' ')}
        icons={icons ?? []}
        className={className}
        fallback={<ProviderLogo kind={kind} className={className} />}
      />
    </span>
  )
}

/** The first of a server's images that loads, else the fallback. */
function ServerIcon({
  icons,
  className,
  fallback,
}: {
  icons: string[]
  className: string
  fallback: ReactNode
}) {
  const [failed, setFailed] = useState(0)
  const src = icons[failed]
  if (!src) return fallback
  return (
    // eslint-disable-next-line @next/next/no-img-element -- an MCP server's icon, on its own site
    <img
      src={src}
      alt=""
      referrerPolicy="no-referrer"
      className={cn(className, 'rounded-sm object-contain')}
      onError={() => setFailed((n) => n + 1)}
    />
  )
}
