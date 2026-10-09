import type { Metadata } from 'next'
import { ThemeProvider } from 'next-themes'
import type { ReactNode } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { themeFontHrefs } from './theme-fonts'
import './globals.css'

export const metadata: Metadata = {
  title: 'Brigade',
  description: 'The control plane for a business run with AI teammates.',
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
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <TooltipProvider>{children}</TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
