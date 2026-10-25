import type { Metadata, Viewport } from 'next'
import { ThemeProvider } from 'next-themes'
import type { ReactNode } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { themeFontHrefs } from './theme-fonts'
import './globals.css'

export const metadata: Metadata = {
  title: 'Brigade',
  description: 'The control plane for a business run with AI teammates.',
  // Added to the Home Screen, it opens as an app: the only way an iPhone gets notifications.
  appleWebApp: { capable: true, title: 'Brigade', statusBarStyle: 'default' },
}

export const viewport: Viewport = {
  // iOS zooms in on a field under 16px as it takes focus; this stops it (pinching still zooms).
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fdfdfd' },
    { media: '(prefers-color-scheme: dark)', color: '#1a1b1e' },
  ],
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {themeFontHrefs.map((href) => (
          <link key={href} rel="stylesheet" href={href} />
        ))}
      </head>
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          <TooltipProvider>{children}</TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
