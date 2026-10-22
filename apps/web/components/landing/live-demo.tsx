'use client'
import { useEffect, useState } from 'react'
import { DEMO_URL } from '@/lib/demo/flag'
import { c, Icon } from './parts'

// Wide enough for the dashboard's own layout, sidebar and all: narrower, the picture and a
// link to open the demo on its own.
const WIDE = '(min-width: 900px)'

/**
 * The live demo (demo.brigade.lol, docs/demo.md) under the hero: the real dashboard on a
 * sample workspace, running in a window on the page as soon as it opens. Its picture shows
 * while it loads, and on a phone, where the button opens the demo on its own.
 */
export function LiveDemo() {
  const [wide, setWide] = useState(false)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    const query = window.matchMedia(WIDE)
    const update = () => setWide(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return (
    <section id="demo" aria-label="Live demo" className={c('live-demo')}>
      <div className={c('wrap')}>
        <div className={c('demo-win')}>
          <div className={c('demo-bar')}>
            <i></i>
            <i></i>
            <i></i>
            <span className={c('demo-url mono')}>
              <span className={c('dot ok')}></span>demo.brigade.lol
            </span>
            <a href={`${DEMO_URL}/app`} target="_blank" rel="noopener">
              Open full screen <Icon name="arrow" />
            </a>
          </div>
          <div className={c('demo-view')}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className={c('demo-shot light-only')} src="/landing/demo-light.webp" alt="" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className={c('demo-shot dark-only')} src="/landing/demo-dark.webp" alt="" />
            {wide ? (
              <iframe
                // ?tour: Ada walks through a job on her own until the visitor takes over (lib/demo/tour.ts).
                src={`${DEMO_URL}/app?tour`}
                title="Brigade demo workspace: click around, nothing here is real"
                allow="clipboard-write"
                className={c(loaded ? 'shown' : '')}
                onLoad={() => setLoaded(true)}
              />
            ) : (
              <div className={c('demo-start')}>
                <a
                  className={c('btn pri lg')}
                  href={`${DEMO_URL}/app`}
                  target="_blank"
                  rel="noopener"
                >
                  Try the live demo
                </a>
              </div>
            )}
          </div>
        </div>
        <p className={c('demo-note')}>
          This is Acme, a demo workspace on the real Brigade dashboard. Click around: approve,
          merge, write to a teammate. Nothing here is real.
        </p>
      </div>
    </section>
  )
}
