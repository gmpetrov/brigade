'use client'
import { useState } from 'react'
import { DEMO_URL } from '@/lib/demo/flag'
import { c, Icon } from './parts'

/**
 * The live demo (demo.brigade.lol, docs/demo.md): the real dashboard on a sample workspace,
 * in a window on the page. A picture of it until the visitor starts it, so the page loads
 * none of the dashboard; on a phone, the button opens the demo on its own.
 */
export function LiveDemo() {
  const [started, setStarted] = useState(false)
  return (
    <section id="demo" aria-labelledby="demo-title" className={c('sec live-demo')}>
      <div className={c('wrap')}>
        <div className={c('sec-head')}>
          <h2 className={c('h2')} id="demo-title">
            Click around a real workspace.
          </h2>
          <p className={c('lead')}>
            This is Acme, a sample company on the real Brigade dashboard. Approve a refund, merge a
            pull request, ask Riley to build something. Nothing you do here is real.
          </p>
        </div>
        <div className={c('demo-win')}>
          <div className={c('demo-bar')}>
            <i></i>
            <i></i>
            <i></i>
            <span className={c('mono')}>demo.brigade.lol</span>
            <a href={`${DEMO_URL}/app`} target="_blank" rel="noopener">
              Open full screen <Icon name="arrow" />
            </a>
          </div>
          <div className={c('demo-view')}>
            {started ? (
              <iframe
                src={`${DEMO_URL}/app`}
                title="Brigade demo workspace"
                allow="clipboard-write"
              />
            ) : (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  className={c('demo-shot light-only')}
                  src="/landing/demo-light.webp"
                  alt=""
                  loading="lazy"
                />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  className={c('demo-shot dark-only')}
                  src="/landing/demo-dark.webp"
                  alt=""
                  loading="lazy"
                />
                <div className={c('demo-start')}>
                  <button
                    type="button"
                    className={c('btn pri lg demo-desk')}
                    onClick={() => setStarted(true)}
                  >
                    Try the live demo
                  </button>
                  <a
                    className={c('btn pri lg demo-phone')}
                    href={`${DEMO_URL}/app`}
                    target="_blank"
                    rel="noopener"
                  >
                    Try the live demo
                  </a>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
