'use client'
import { useEffect, useState } from 'react'
import { DEMO_URL } from '@/lib/demo/flag'
import type { Story } from '@/lib/demo/tour'
import { c, Icon } from './parts'

// Wide enough for the dashboard's own layout, sidebar and all: narrower, the picture and a
// link to open the demo on its own.
const WIDE = '(min-width: 900px)'

// The walkthroughs a visitor picks from, the window's tabs (lib/demo/tour.ts plays each one).
const STORIES: { id: Story; label: string }[] = [
  { id: 'bug', label: 'Fix a customer’s bug' },
  { id: 'feature', label: 'Ship a requested feature' },
  { id: 'call', label: 'Prep a sales call' },
  { id: 'payment', label: 'Chase a failed payment' },
]

/**
 * The live demo (demo.brigade.lol, docs/demo.md) under the hero: the real dashboard on a
 * sample workspace, running in a window on the page as soon as it opens, playing the story
 * picked in its tabs. Its picture shows while it loads, and on a phone, where the button opens
 * the demo on its own.
 */
export function LiveDemo() {
  const [wide, setWide] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [story, setStory] = useState<Story>('bug')
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
            {wide ? (
              // The stories are the window's tabs, as in a browser: picking one loads it.
              <div className={c('demo-tabs')} role="tablist" aria-label="Stories to watch">
                {STORIES.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    role="tab"
                    aria-selected={story === s.id}
                    className={c('demo-tab')}
                    onClick={() => {
                      if (story === s.id) return
                      setLoaded(false)
                      setStory(s.id)
                    }}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            ) : (
              <span className={c('demo-url mono')}>
                <span className={c('dot ok')}></span>demo.brigade.lol
              </span>
            )}
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
                // ?tour=<story>: a cursor walks through a job on its own until the visitor takes
                // over (lib/demo/tour.ts). Another story loads the demo afresh.
                key={story}
                src={`${DEMO_URL}/app?tour=${story}`}
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
      </div>
    </section>
  )
}
