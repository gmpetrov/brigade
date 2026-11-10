'use client'
// A <video> or <audio> whose file may come from a signed URL that expires: it asks for it again
// rather than stop playing (hooks/use-renewing-media.ts).
import type { ComponentProps } from 'react'
import { useRenewingMedia } from '@/hooks/use-renewing-media'

type Props<T extends 'video' | 'audio'> = Omit<ComponentProps<T>, 'src'> & {
  src: string
  /** The file cannot be read at all. */
  onFail?: () => void
}

export function RenewingVideo({ src, onFail, ...props }: Props<'video'>) {
  return <video {...props} {...useRenewingMedia(src, onFail)} />
}

export function RenewingAudio({ src, onFail, ...props }: Props<'audio'>) {
  return <audio {...props} {...useRenewingMedia(src, onFail)} />
}
