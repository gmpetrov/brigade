'use client'
import { useRef, useState, type SyntheticEvent } from 'react'
import { onMediaError, renewable, renewedSrc, staleOnRead } from '@/lib/renewing-media'

type MediaEvent = SyntheticEvent<HTMLMediaElement>

/**
 * The props of a <video> or <audio> whose file comes from a signed URL that expires
 * (lib/renewing-media.ts): left open long enough, it would stop playing until the page is
 * reloaded. Before it plays or seeks with an old address, and when it fails after it loaded,
 * it asks for its file again and goes on where it was, playing if it was.
 * `onFail` runs when the file cannot be read at all.
 */
export function useRenewingMedia(src: string, onFail?: () => void) {
  const [renewal, setRenewal] = useState({ src, n: 0 })
  const n = renewal.src === src ? renewal.n : 0
  const loadedAt = useRef(0)
  const loaded = useRef(false)
  const renewedAt = useRef(0)
  // Where to go on once the renewed address has loaded.
  const resume = useRef<{ time: number; play: boolean } | null>(null)

  const renew = (el: HTMLMediaElement, play: boolean) => {
    resume.current = { time: el.currentTime, play }
    renewedAt.current = Date.now()
    setRenewal({ src, n: n + 1 })
  }
  const onRead = (play: boolean) => (e: MediaEvent) => {
    if (resume.current || !renewable(src) || !staleOnRead(loadedAt.current, Date.now())) return
    renew(e.currentTarget, play)
  }

  return {
    src: renewedSrc(src, n),
    onLoadStart: () => {
      loadedAt.current = Date.now()
      loaded.current = false
    },
    onLoadedMetadata: (e: MediaEvent) => {
      loaded.current = true
      const at = resume.current
      if (!at) return
      resume.current = null
      const el = e.currentTarget
      el.currentTime = at.time
      // Refused without the person's click (autoplay rules): it waits on its play button.
      if (at.play) el.play().catch(() => {})
    },
    onPlay: onRead(true),
    onSeeking: (e: MediaEvent) => onRead(!e.currentTarget.paused)(e),
    onError: (e: MediaEvent) => {
      const el = e.currentTarget
      // A load replaced by the next one (a new address) is not a failure.
      if (el.error?.code === MediaError.MEDIA_ERR_ABORTED) return
      const next = onMediaError({
        loaded: loaded.current,
        renewedAt: renewedAt.current,
        now: Date.now(),
        src,
      })
      if (next === 'renew') renew(el, !el.paused || !!resume.current?.play)
      else {
        resume.current = null
        onFail?.()
      }
    },
  }
}
