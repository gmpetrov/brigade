// What the whole app shows while it loads: the wordmark, alone, its letters coming into focus.

/** The full-page loader: "Brigade" centred on the background, blurring in letter by letter (still for less motion). */
export function AppLoader() {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background">
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
    </div>
  )
}
