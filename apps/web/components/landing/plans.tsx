import { c, Icon } from './parts'

function ClaudeMark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <g stroke="oklch(0.64 0.15 42)" strokeWidth="3.2" strokeLinecap="round">
        <path d="M16 4v24" />
        <path d="M4 16h24" />
        <path d="m7.5 7.5 17 17" />
        <path d="m24.5 7.5-17 17" />
      </g>
    </svg>
  )
}

function ChatGptMark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinejoin="round">
        <path d="M16 3.5 26.8 9.75v12.5L16 28.5 5.2 22.25V9.75z" />
        <path d="M16 10.2 21 13.1v5.8L16 21.8l-5-2.9v-5.8z" />
      </g>
    </svg>
  )
}

/** Bring your own sub: the plans members already pay for, the accounts in use, the relay to the next one, and a model per teammate.
 * The relay is between accounts of one provider (runner: harness/index.ts, account.switched);
 * the models are the product's own (packages/contracts/src/models.ts). */
export function Plans() {
  return (
    <section aria-labelledby="plans-title" className={c('sec byo-sec')} data-anim>
      <div className={c('wrap byo')}>
        <div className={c('byo-copy')}>
          <h2 className={c('h2')} id="plans-title">
            Bring your own sub.
          </h2>
          <ol className={c('byo-pts')}>
            <li>
              <span className={c('n')}>01</span>
              <div>
                <h3>The plan you already pay for</h3>
                <p>
                  Teammates run the real Claude Code and Codex, signed in with your accounts. We
                  never bill you for AI usage.
                </p>
              </div>
            </li>
            <li>
              <span className={c('n')}>02</span>
              <div>
                <h3>Stack your plans</h3>
                <p>
                  Connect several Claude or ChatGPT accounts. When one hits its limit, the teammate
                  carries on with the next account, in the middle of the task.
                </p>
              </div>
            </li>
            <li>
              <span className={c('n')}>03</span>
              <div>
                <h3>A different model per teammate</h3>
                <p>
                  Opus for your engineer, Sonnet for support, GPT for marketing. Pick it on each
                  teammate&apos;s page.
                </p>
              </div>
            </li>
          </ol>
        </div>

        <div className={c('byo-panel')} aria-hidden="true">
          <div className={c('cp-head')}>
            <span className={c('cp-l')}>Connected plans</span>
          </div>
          <div className={c('cp-body')}>
            <p className={c('cp-l')}>In use · 3 accounts</p>
            <div className={c('acct full')}>
              <div className={c('acct-t')}>
                <ClaudeMark />
                <b>Claude Max · account 1</b>
                <span className={c('cp-l warn')}>At limit</span>
              </div>
              <div className={c('acct-m')}>
                <span className={c('mono')}>Opus 5.5</span>
                <span className={c('acct-bar')}>
                  <span className={c('acct-f a')}></span>
                </span>
              </div>
            </div>
            <p className={c('cp-l warn cp-relay')}>Same plan, next account · continuing</p>
            <div className={c('acct')}>
              <div className={c('acct-t')}>
                <ClaudeMark />
                <b>Claude Max · account 2</b>
                <span className={c('cp-l')}>Working</span>
              </div>
              <div className={c('acct-m')}>
                <span className={c('mono')}>Opus 5.5</span>
                <span className={c('acct-bar')}>
                  <span className={c('acct-f b')}></span>
                </span>
              </div>
            </div>
            <div className={c('acct')}>
              <div className={c('acct-t')}>
                <ChatGptMark />
                <b>ChatGPT Pro</b>
                <span className={c('cp-l')}>In use</span>
              </div>
              <div className={c('acct-m')}>
                <span className={c('mono')}>GPT-6.1 Sol</span>
                <span className={c('acct-bar')}>
                  <span className={c('acct-f c')}></span>
                </span>
              </div>
            </div>
            <p className={c('cp-l cp-sep')}>Model per teammate</p>
            <div className={c('cp-tm')}>
              <span className={c('av')}>R</span>
              Riley
              <span className={c('cp-l')}>
                <ClaudeMark />
                Opus 5.5
              </span>
            </div>
            <div className={c('cp-tm')}>
              <span className={c('av sam')}>S</span>
              Sam
              <span className={c('cp-l')}>
                <ClaudeMark />
                Sonnet 5.5
              </span>
            </div>
            <div className={c('cp-tm')}>
              <span className={c('av mark')}>M</span>
              Mark
              <span className={c('cp-l')}>
                <ChatGptMark />
                GPT-6.1 Sol
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
