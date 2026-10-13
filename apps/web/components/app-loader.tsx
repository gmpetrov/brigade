// What the whole app shows while it loads: the wordmark, alone, a light passing over it.

/** The full-page loader: "Brigade" centred on the background, shimmering (still for less motion). */
export function AppLoader() {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background">
      <span
        role="status"
        aria-label="Loading Brigade"
        className="wordmark-shimmer font-sans text-[26px] font-extrabold tracking-[-0.045em]"
      >
        Brigade
      </span>
    </div>
  )
}
