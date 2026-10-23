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

/** Bring your own AI: the plans members already pay for, stacked, with a model per teammate.
 * The relay is between accounts of one provider (runner: harness/index.ts, account.switched);
 * the models are the product's own (packages/contracts/src/models.ts). */
export function Plans() {
  return (
    <section aria-labelledby="plans-title" className={c('sec byo-sec')} data-anim>
      <div className={c('wrap byo')}>
        <div className={c('byo-copy')}>
          <p className={c('eyebrow')}>Bring your own AI</p>
          <h2 className={c('h2')} id="plans-title">
            Your Claude and ChatGPT plans, working as a team.
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
                <h3>A model per teammate</h3>
                <p>
                  Opus for your engineer, Sonnet for support, GPT for marketing. Pick it on each
                  teammate&apos;s page.
                </p>
              </div>
            </li>
          </ol>
        </div>

        <div className={c('byo-panel')} aria-hidden="true">
          <div className={c('rl-head')}>
            <span className={c('av')}>R</span>
            <div className={c('tx')}>
              <b>Riley</b>
              <span>Fix the refund rounding bug</span>
            </div>
            <span className={c('badge run')}>working</span>
          </div>

          <div className={c('rl')}>
            <div className={c('rl-axis mono')}>
              <span>13:40</span>
              <span className={c('rl-at')}>14:02</span>
              <span>14:25</span>
            </div>
            <div className={c('rl-lane')}>
              <span className={c('rl-acc')}>
                <ClaudeMark />
                <span>
                  Claude Max <em className={c('mono')}>ada@</em>
                </span>
              </span>
              <span className={c('rl-track')}>
                <span className={c('rl-bar a')}></span>
                <span className={c('rl-cap')}>limit</span>
              </span>
            </div>
            <div className={c('rl-lane')}>
              <span className={c('rl-acc')}>
                <ClaudeMark />
                <span>
                  Claude Max <em className={c('mono')}>ops@</em>
                </span>
              </span>
              <span className={c('rl-track')}>
                <span className={c('rl-bar b')}></span>
              </span>
            </div>
            <div className={c('rl-switch')}></div>
          </div>

          <div className={c('rl-log')}>
            <div className={c('rl-ln')}>
              <span className={c('mono')}>14:02</span>
              <span className={c('rl-i warn')}>
                <Icon name="clock" />
              </span>
              <span>
                <b>ada@</b> reached its usage limit
              </span>
            </div>
            <div className={c('rl-ln')}>
              <span className={c('mono')}>14:02</span>
              <span className={c('rl-i')}>
                <Icon name="swap" />
              </span>
              <span>
                Same task, same files, now on <b>ops@</b>
              </span>
            </div>
            <div className={c('rl-ln')}>
              <span className={c('mono')}>14:25</span>
              <span className={c('rl-i ok')}>
                <Icon name="check" />
              </span>
              <span>Opened a pull request</span>
            </div>
          </div>

          <div className={c('rl-models')}>
            <p className={c('ovl')}>A model per teammate</p>
            <div className={c('rl-m')}>
              <span className={c('av xs')}>R</span>
              <b>Riley</b>
              <span className={c('sp')}></span>
              <ClaudeMark />
              Opus 5.5
            </div>
            <div className={c('rl-m')}>
              <span className={c('av xs sam')}>S</span>
              <b>Sam</b>
              <span className={c('sp')}></span>
              <ClaudeMark />
              Sonnet 5.5
            </div>
            <div className={c('rl-m')}>
              <span className={c('av xs mark')}>M</span>
              <b>Mark</b>
              <span className={c('sp')}></span>
              <ChatGptMark />
              GPT-6.1 Sol
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
