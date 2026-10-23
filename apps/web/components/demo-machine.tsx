'use client'
import { Eye, Monitor, SquareTerminal, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SIGN_UP_URL } from '@/lib/demo/flag'

const WHAT = {
  preview: {
    Icon: Eye,
    title: 'The app preview runs on a real computer',
    text: 'In your workspace, a teammate starts the app it is building and you try it right here, then ask for changes in the thread.',
  },
  screen: {
    Icon: Monitor,
    title: 'A teammate’s screen shows here',
    text: 'In your workspace, you watch a teammate use a browser or apps on its computer, and take over the mouse and keyboard when you need to. Full computer use is on a Mac.',
  },
  terminal: {
    Icon: SquareTerminal,
    title: 'A terminal on the thread’s computer opens here',
    text: 'In your workspace, you get a shell in the thread’s folder, on your Mac or a cloud computer.',
  },
}

/**
 * In the demo (lib/demo/flag.ts), what needs a real computer: the app preview, a
 * teammate's screen, a terminal. Says what it would show, and where to get it.
 */
export function DemoMachine({ what, onClose }: { what: keyof typeof WHAT; onClose?: () => void }) {
  const { Icon, title, text } = WHAT[what]
  return (
    <div className="bg-card text-card-foreground relative flex min-h-64 flex-1 flex-col items-center justify-center gap-3 rounded-lg border p-8 text-center">
      {onClose && (
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close"
          className="absolute top-2 right-2"
          onClick={onClose}
        >
          <X />
        </Button>
      )}
      <Icon className="text-muted-foreground size-8" aria-hidden />
      <p className="font-semibold">{title}</p>
      <p className="text-muted-foreground max-w-sm text-sm">{text}</p>
      <Button asChild size="sm" className="mt-1 rounded-full">
        <a href={SIGN_UP_URL} target="_top">
          Start free on your Mac
        </a>
      </Button>
    </div>
  )
}
