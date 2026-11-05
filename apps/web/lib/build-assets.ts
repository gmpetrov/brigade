/**
 * The build files a page's HTML loads: its scripts and stylesheets under /_next/static/,
 * each once, in order. Their names carry their hash, so a new build's are new files the
 * browser has never cached; fetched ahead, a reload onto that build finds them at hand.
 */
export function buildAssets(html: string): string[] {
  const found = new Set<string>()
  for (const m of html.matchAll(
    /(?:src|href)="(\/_next\/static\/[^"?#]+\.(?:js|css))(?:[?#][^"]*)?"/g,
  ))
    found.add(m[1]!)
  return [...found]
}
