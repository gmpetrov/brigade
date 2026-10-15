'use client'

// A thread's title that, when it changes on screen (a new thread named by its
// first run, or a rename elsewhere), streams in a few letters at a time the way a
// model's answer does. A rename made here, and less motion, show it at once.
import { useEffect, useState } from 'react'

/** Titles this browser set itself, by thread: those appear without streaming. */
const renamed = new Map<string, string>()

/** A rename made here: the list shows it as typed, not streamed. */
export function renamedHere(threadId: string, title: string) {
  renamed.set(threadId, title)
}

/** Between one piece of the title and the next. */
const PIECE_MS = 60

/** The title in pieces of a few letters, each with the space before it, as a model's tokens. */
const pieces = (text: string) => text.match(/\s*\S{1,4}/g) ?? [text]

const lessMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** The title's text, for inside the element that holds it (and truncates it). */
export function StreamedTitle({ threadId, text }: { threadId: string; text: string }) {
  const [last, setLast] = useState({ threadId, text })
  const [stream, setStream] = useState<{ pieces: string[]; at: number } | null>(null)
  if (last.threadId !== threadId || last.text !== text) {
    setLast({ threadId, text })
    const streams = last.threadId === threadId && renamed.get(threadId) !== text && !lessMotion()
    setStream(streams ? { pieces: pieces(text), at: 1 } : null)
  }
  useEffect(() => {
    if (!stream) return
    // After the last piece, plain text again once it has faded in (.stream-piece).
    const done = stream.at >= stream.pieces.length
    const next = setTimeout(
      () => setStream((s) => (s && !done ? { ...s, at: s.at + 1 } : null)),
      done ? 400 : PIECE_MS,
    )
    return () => clearTimeout(next)
  }, [stream])
  if (!stream) return text
  return (
    <>
      <span className="sr-only">{text}</span>
      <span aria-hidden>
        {stream.pieces.slice(0, stream.at).map((piece, i) => (
          <span key={i} className="stream-piece">
            {piece}
          </span>
        ))}
      </span>
    </>
  )
}
