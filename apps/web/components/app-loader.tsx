// What the whole app shows while it loads: the wordmark, alone, its letters coming into focus.

/**
 * The full-page loader: "Brigade" centred on the background, blurring in letter by letter (still
 * for less motion). `note`, under it: why it is still loading, when it knows.
 */
export function AppLoader({ note }: { note?: string }) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-3 bg-background">
      <div
        role="status"
        aria-label="Loading Brigade"
        className="loader-blur inline-flex px-2 py-1 font-sans text-[26px] font-extrabold tracking-[-0.045em]"
      >
        {[...'Brigade'].map((letter, i) => (
          <span key={i} aria-hidden="true">
            {letter}
          </span>
        ))}
      </div>
      {note && (
        <p role="status" className="text-muted-foreground text-sm">
          {note}
        </p>
      )}
    </div>
  )
}
