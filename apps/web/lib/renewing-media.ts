/**
 * A video or a sound from the bucket plays from a signed URL the API redirects to, which works
 * 5 minutes (apps/api/src/bucket.ts). The player keeps the URL it was redirected to and asks it
 * for more of the file as it plays or seeks: past those minutes it is refused, and the player
 * stops. So a player whose address is older than this asks the API again, at a new address so
 * the browser's copy of the redirect is not used.
 */
export const MEDIA_FRESH_MS = 4 * 60 * 1000

/** A renewal that fails again this soon is not tried again: the file is gone, or not ours. */
export const RENEW_RETRY_MS = 10 * 1000

/** Only addresses on the web are signed and expire: not this browser's own (blob:, data:). */
export const renewable = (src: string) => /^https?:\/\//i.test(src)

/** `src` asked for again: the n-th renewal, as a query the API ignores, before any #fragment. */
export function renewedSrc(src: string, n: number) {
  if (n <= 0 || !renewable(src)) return src
  const hash = src.indexOf('#')
  const [base, fragment] = hash === -1 ? [src, ''] : [src.slice(0, hash), src.slice(hash)]
  return `${base}${base.includes('?') ? '&' : '?'}renew=${n}${fragment}`
}

/**
 * What a player does when it is about to read more of its file (it plays or seeks), given
 * when its address was loaded: renew it when it may have expired.
 */
export const staleOnRead = (loadedAt: number, now: number) =>
  loadedAt > 0 && now - loadedAt > MEDIA_FRESH_MS

/**
 * What a player does when it fails: a file that never loaded is gone or not this person's
 * (give up); one that loaded and then failed most likely lost its address (renew it), unless
 * it was just renewed.
 */
export function onMediaError(state: {
  loaded: boolean
  renewedAt: number
  now: number
  src: string
}): 'renew' | 'fail' {
  if (!state.loaded || !renewable(state.src)) return 'fail'
  return state.now - state.renewedAt < RENEW_RETRY_MS ? 'fail' : 'renew'
}
