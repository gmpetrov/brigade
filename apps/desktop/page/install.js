// The install animation (src/install-animation.ts drives it, through `window.install`):
//   start({ from, icon }): the app's pane (`from`, in this page's pixels) lights up along its
//     edge, folds into a rounded square and becomes the app's icon (a data: URL), which waits.
//   go({ to }): a streak of light, then the icon opens out into the app's window (`to`): the
//     screen darkens to a starfield around it, and a violet nebula blooms along its edge.
//     Resolves when the window should show, under the light.
//   done(): resolves once the light has faded. cancel(): everything fades away.
// In Brigade's violet (the dashboard's --primary). Light is drawn additively, so it only ever
// brightens what is under it; only the starfield's night darkens.
;(() => {
  const canvas = document.getElementById('stage')
  const ctx = canvas.getContext('2d')
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches

  let width = 0
  let height = 0
  function resize() {
    const ratio = devicePixelRatio || 1
    width = innerWidth
    height = innerHeight
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  }
  resize()
  addEventListener('resize', resize)

  // Brigade's violets, as r, g, b.
  const VIOLET = '139, 92, 246'
  const DEEP = '109, 40, 217'
  const LAVENDER = '196, 181, 253'
  const ORCHID = '192, 132, 252'
  const INDIGO = '99, 102, 241'
  const FUCHSIA = '217, 70, 239'
  const WHITE = '246, 243, 255'
  const NEBULA = [VIOLET, VIOLET, DEEP, ORCHID, ORCHID, INDIGO, LAVENDER, FUCHSIA]

  // Easing and helpers ---------------------------------------------------------------------
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v))
  const lerp = (a, b, t) => a + (b - a) * t
  const inOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
  const outCubic = (t) => 1 - (1 - t) ** 3
  const outExpo = (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t))
  const outBack = (t) => 1 + 2.4 * (t - 1) ** 3 + 1.4 * (t - 1) ** 2
  const phase = (t, start, duration) => clamp((t - start) / duration)
  const bell = (t) => Math.sin(Math.PI * clamp(t))
  const mixRect = (a, b, t) => ({
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    w: lerp(a.w, b.w, t),
    h: lerp(a.h, b.h, t),
  })
  const rect = (r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })
  const center = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })
  const random = (a, b) => a + Math.random() * (b - a)
  const pick = (list) => list[Math.floor(Math.random() * list.length)]

  function roundRect(r, radius) {
    const rad = Math.max(0, Math.min(radius, r.w / 2, r.h / 2))
    ctx.beginPath()
    ctx.roundRect(r.x, r.y, r.w, r.h, rad)
  }

  // A glowing edge: a wide violet halo, a lavender one, then a thin white-hot core.
  function glowRect(r, radius, alpha, scale = 1) {
    if (alpha <= 0.002) return
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    roundRect(r, radius)
    ctx.lineWidth = 3 * scale
    ctx.shadowColor = `rgba(${VIOLET}, ${alpha})`
    ctx.shadowBlur = 44 * scale
    ctx.strokeStyle = `rgba(${VIOLET}, ${0.6 * alpha})`
    ctx.stroke()
    ctx.shadowColor = `rgba(${ORCHID}, ${0.8 * alpha})`
    ctx.shadowBlur = 18 * scale
    ctx.lineWidth = 2 * scale
    ctx.strokeStyle = `rgba(${LAVENDER}, ${0.75 * alpha})`
    ctx.stroke()
    ctx.shadowBlur = 5
    ctx.shadowColor = `rgba(255, 255, 255, ${alpha})`
    ctx.lineWidth = 1.2 * scale
    ctx.strokeStyle = `rgba(${WHITE}, ${alpha})`
    ctx.stroke()
    ctx.restore()
  }

  function glowDot(x, y, radius, color, alpha) {
    if (alpha <= 0.002 || radius <= 0) return
    const g = ctx.createRadialGradient(x, y, 0, x, y, radius)
    g.addColorStop(0, `rgba(${color}, ${alpha})`)
    g.addColorStop(0.35, `rgba(${color}, ${alpha * 0.45})`)
    g.addColorStop(1, `rgba(${color}, 0)`)
    ctx.fillStyle = g
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2)
  }

  /** A point at `d` (0 to 1) along a rectangle's edge, clockwise from its top's middle. */
  function along(r, d) {
    const perimeter = 2 * (r.w + r.h)
    let s = (((d % 1) + 1) % 1) * perimeter
    const top = r.w / 2
    if (s < top) return { x: r.x + r.w / 2 + s, y: r.y }
    s -= top
    if (s < r.h) return { x: r.x + r.w, y: r.y + s }
    s -= r.h
    if (s < r.w) return { x: r.x + r.w - s, y: r.y + r.h }
    s -= r.w
    if (s < r.h) return { x: r.x, y: r.y + r.h - s }
    s -= r.h
    return { x: r.x + s, y: r.y }
  }

  /** The way out of a rectangle at a point of its edge, as a unit vector. */
  function outward(r, p) {
    const c = center(r)
    // Toward the nearest side, mostly: clouds hug the edge rather than flare from the center.
    const dx = (p.x - c.x) / (r.w / 2)
    const dy = (p.y - c.y) / (r.h / 2)
    const v =
      Math.abs(dx) > Math.abs(dy)
        ? { x: Math.sign(dx), y: dy * 0.35 }
        : { x: dx * 0.35, y: Math.sign(dy) }
    const len = Math.hypot(v.x, v.y) || 1
    return { x: v.x / len, y: v.y / len }
  }

  // State --------------------------------------------------------------------------------
  let from = null
  let iconRect = null
  let to = null
  let image = null
  let started = 0
  let went = 0
  let cancelled = 0
  let showAt = null
  let finished = null
  let particles = []
  let puffs = []
  let stars = []
  let sparkles = []
  let spawned = false
  let running = false

  const START = { trace: 650, fold: 760, appear: 520 }
  const GO = { streak: 300, expand: 860, show: 660, night: 1350, end: 1900 }

  function frame(now) {
    if (!running) return
    ctx.clearRect(0, 0, width, height)
    let fade = 1
    if (cancelled) {
      fade = 1 - clamp((now - cancelled) / 320)
      if (fade <= 0) {
        running = false
        ctx.clearRect(0, 0, width, height)
        if (finished) finished()
        return
      }
    }
    ctx.globalAlpha = fade
    if (!went) drawStart(now - started, now)
    else drawGo(now - went, now)
    ctx.globalAlpha = 1
    if (running) requestAnimationFrame(frame)
  }

  // The pane lights up, folds, and becomes the icon -------------------------------------
  function drawStart(t, now) {
    const trace = phase(t, 0, START.trace)
    const fold = phase(t, START.trace - 120, START.fold)
    const appear = phase(t, START.trace + START.fold - 220, START.appear)
    const radius = Math.min(iconRect.w, iconRect.h) * 0.23

    if (!reduced) {
      // The pane dims while its light gathers.
      const dim = bell(t / (START.trace + START.fold)) * 0.38
      if (dim > 0.01) {
        ctx.save()
        roundRect(from, 12)
        ctx.fillStyle = `rgba(8, 5, 20, ${dim})`
        ctx.fill()
        ctx.restore()
      }
      // Two comets run from the top's middle around the edge and meet at the bottom.
      if (trace < 1) {
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        const head = outCubic(trace) * 0.5
        for (const dir of [1, -1])
          for (let i = 0; i < 48; i++) {
            const back = i * 0.0055
            if (head - back < 0) break
            const p = along(from, dir * (head - back))
            const a = (1 - i / 48) ** 2 * (1 - trace * 0.3)
            glowDot(p.x, p.y, i === 0 ? 30 : 15, i < 5 ? WHITE : i < 16 ? LAVENDER : VIOLET, a)
          }
        ctx.restore()
      }
      // The edge it leaves, glowing, then folding in echoes into the icon's square.
      const edge = clamp(trace * 1.4) * (1 - appear)
      if (fold <= 0) glowRect(from, 12, edge)
      else
        for (let i = 5; i >= 0; i--) {
          // Stretched so that every echo arrives.
          const k = inOut(clamp(fold * 1.32 - i * 0.064))
          const r = mixRect(from, iconRect, k)
          glowRect(r, lerp(12, radius, k), edge * (1 - i / 6) * (i ? 0.5 : 1))
        }
    }
    if (appear > 0) drawIcon(appear, now, 1)
  }

  function drawIcon(appear, now, alpha, grow = 1) {
    const c = center(iconRect)
    const settle = clamp(appear * 2 - 1)
    const bob = reduced ? 0 : Math.sin(now / 520) * 1.6 * settle
    const s = (reduced ? 1 : lerp(0.72, 1, outBack(appear))) * grow
    const w = iconRect.w * s
    const h = iconRect.h * s
    const r = { x: c.x - w / 2, y: c.y - h / 2 + bob, w, h }
    const radius = Math.min(w, h) * 0.23
    // Its bloom, breathing while it waits.
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    const breath = 0.8 + Math.sin(now / 430) * 0.14
    glowDot(c.x, c.y + bob, w * 1.4, VIOLET, 0.42 * appear * breath * alpha)
    glowDot(c.x, c.y + bob, w * 0.85, ORCHID, 0.26 * appear * breath * alpha)
    ctx.restore()
    glowRect(r, radius, appear * alpha * 0.9, 0.8)
    if (image?.complete && image.naturalWidth) {
      ctx.save()
      ctx.globalAlpha *= clamp(appear * 1.6) * alpha
      roundRect(r, radius)
      ctx.clip()
      ctx.drawImage(image, r.x, r.y, r.w, r.h)
      ctx.restore()
    }
    // Sparks around it while it waits.
    if (!reduced && appear >= 1 && alpha > 0.5 && Math.random() < 0.22)
      sparkles.push({
        x: c.x + random(-1.1, 1.1) * w,
        y: c.y + random(-1.1, 1.1) * h,
        born: now,
        life: random(500, 1000),
        size: random(1, 2.6),
      })
    sparkles = sparkles.filter((s) => now - s.born < s.life)
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    for (const s of sparkles)
      glowDot(s.x, s.y, s.size * 5, LAVENDER, bell((now - s.born) / s.life) * 0.85 * alpha)
    ctx.restore()
  }

  // The icon opens out into the window ----------------------------------------------------
  function spawn(now) {
    spawned = true
    const scale = clamp((to.w + to.h) / 1860, 0.6, 1.5)
    // Dust: small bright clouds packed along the edge.
    for (let i = 0; i < Math.round(170 * scale); i++) {
      const p = along(to, Math.random())
      const o = outward(to, p)
      const push = random(-14, 34)
      puffs.push({
        x: p.x + o.x * push,
        y: p.y + o.y * push,
        vx: o.x * random(8, 46),
        vy: o.y * random(8, 46),
        born: now + random(0, 220),
        life: random(950, 1500),
        radius: random(22, 70),
        color: pick(NEBULA),
        peak: random(0.16, 0.34),
      })
    }
    // Clouds: wide and faint, further out, the nebula's body.
    for (let i = 0; i < Math.round(46 * scale); i++) {
      const p = along(to, Math.random())
      const o = outward(to, p)
      const push = random(20, 110)
      puffs.push({
        x: p.x + o.x * push,
        y: p.y + o.y * push,
        vx: o.x * random(10, 40),
        vy: o.y * random(10, 40),
        born: now + random(80, 320),
        life: random(1100, 1600),
        radius: random(100, 230),
        color: pick([VIOLET, DEEP, INDIGO, ORCHID]),
        peak: random(0.07, 0.14),
      })
    }
    // A night of stars around the window, out to the screen's edges.
    for (let i = 0; i < 260; i++) {
      const x = random(0, width)
      const y = random(0, height)
      if (x > to.x - 6 && x < to.x + to.w + 6 && y > to.y - 6 && y < to.y + to.h + 6) continue
      stars.push({
        x,
        y,
        size: random(0.4, 1.5),
        twinkle: random(0, Math.PI * 2),
        warm: Math.random() < 0.3,
      })
    }
  }

  function drawGo(t, now) {
    const c = center(iconRect)
    if (reduced) {
      const k = clamp(t / 300)
      drawIcon(1, now, 1 - k)
      glowRect(to, 12, bell(k) * 0.6)
      if (t >= 0 && showAt) {
        showAt()
        showAt = null
      }
      if (k >= 1) end()
      return
    }

    const expand = outExpo(phase(t, 120, GO.expand))
    const r = mixRect(iconRect, to, expand)
    const radius = lerp(Math.min(iconRect.w, iconRect.h) * 0.23, 12, expand)
    const linger = 1 - phase(t, 120 + GO.expand, GO.end - GO.expand - 380)

    // Night falls around the window as it forms, then lifts: a starfield, darker at the edges.
    const night = phase(t, 140, 360) * (1 - phase(t, GO.night, GO.end - GO.night - 150))
    if (night > 0 && t > 120) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(0, 0, width, height)
      ctx.roundRect(r.x, r.y, r.w, r.h, Math.max(0, Math.min(radius, r.w / 2, r.h / 2)))
      const v = ctx.createRadialGradient(
        to.x + to.w / 2,
        to.y + to.h / 2,
        Math.min(to.w, to.h) * 0.45,
        to.x + to.w / 2,
        to.y + to.h / 2,
        Math.hypot(width, height) * 0.62,
      )
      v.addColorStop(0, `rgba(10, 6, 26, ${0.42 * night})`)
      v.addColorStop(1, `rgba(3, 2, 10, ${0.7 * night})`)
      ctx.fillStyle = v
      ctx.fill('evenodd')
      ctx.restore()
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      for (const s of stars) {
        const a = night * (0.35 + 0.45 * Math.sin(now / 260 + s.twinkle) ** 2)
        glowDot(s.x, s.y, s.size * 3.2, s.warm ? LAVENDER : WHITE, a)
      }
      ctx.restore()
    }

    // The streak: a line of light through the icon, wide and gone in a blink.
    const streak = phase(t, 0, GO.streak)
    if (streak > 0 && streak < 1) {
      const reach = outExpo(streak) * Math.max(460, to.w * 0.75)
      const a = bell(streak)
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      const g = ctx.createLinearGradient(c.x - reach, 0, c.x + reach, 0)
      g.addColorStop(0, `rgba(${VIOLET}, 0)`)
      g.addColorStop(0.35, `rgba(${LAVENDER}, ${a * 0.6})`)
      g.addColorStop(0.5, `rgba(255, 255, 255, ${a})`)
      g.addColorStop(0.65, `rgba(${LAVENDER}, ${a * 0.6})`)
      g.addColorStop(1, `rgba(${VIOLET}, 0)`)
      ctx.fillStyle = g
      ctx.shadowColor = `rgba(${VIOLET}, ${a})`
      ctx.shadowBlur = 22
      ctx.fillRect(c.x - reach, c.y - 1.3, reach * 2, 2.6)
      glowDot(c.x, c.y, 70 * a + 10, LAVENDER, 0.5 * a)
      ctx.restore()
    }

    // The icon flares and goes as the frame leaves it.
    const leave = phase(t, 60, 460)
    if (leave < 1) drawIcon(1, now, 1 - outCubic(leave), 1 + 0.18 * outCubic(leave))

    if (t > 120) {
      // A faint light inside, as the window forms.
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      roundRect(r, radius)
      ctx.fillStyle = `rgba(${LAVENDER}, ${0.08 * bell(expand) * linger})`
      ctx.fill()
      ctx.restore()
    }

    // Stars thrown out from the edge as it moves.
    if (t > 120 && t < 120 + GO.expand)
      for (let i = 0; i < 10; i++) {
        const p = along(r, Math.random())
        const o = outward(r, p)
        const speed = random(40, 220)
        particles.push({
          x: p.x,
          y: p.y,
          vx: o.x * speed + random(-20, 20),
          vy: o.y * speed + random(-20, 20),
          born: now,
          life: random(600, 1300),
          size: random(0.6, 2),
          color: Math.random() < 0.55 ? WHITE : LAVENDER,
        })
      }

    if (t > 300 && !spawned) spawn(now)
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    puffs = puffs.filter((p) => now - p.born < p.life)
    for (const p of puffs) {
      const age = now - p.born
      if (age < 0) continue
      const k = age / p.life
      const a = (k < 0.25 ? k / 0.25 : 1 - (k - 0.25) / 0.75) * p.peak
      const s = age / 1000
      glowDot(p.x + p.vx * s, p.y + p.vy * s, p.radius * lerp(0.65, 1.45, outCubic(k)), p.color, a)
    }
    particles = particles.filter((p) => now - p.born < p.life)
    for (const p of particles) {
      const k = (now - p.born) / p.life
      const s = (now - p.born) / 1000
      glowDot(p.x + p.vx * s, p.y + p.vy * s, p.size * 4, p.color, (1 - k) ** 1.5)
    }
    ctx.restore()

    // The frame itself, on top: white-hot as it opens, then lingering and fading.
    if (t > 120) glowRect(r, radius, linger, lerp(0.8, 1.35, expand))

    if (showAt && t >= GO.show) {
      showAt()
      showAt = null
    }
    if (t >= GO.end && !puffs.length && !particles.length) end()
  }

  function end() {
    running = false
    ctx.clearRect(0, 0, width, height)
    if (finished) finished()
  }

  window.install = {
    start(input) {
      from = rect(input.from)
      const side = Math.round(clamp(Math.min(from.w, from.h) * 0.22, 64, 112))
      const c = center(from)
      iconRect = { x: c.x - side / 2, y: c.y - side / 2, w: side, h: side }
      image = new Image()
      image.src = input.icon
      started = performance.now()
      went = 0
      cancelled = 0
      particles = []
      puffs = []
      stars = []
      sparkles = []
      spawned = false
      running = true
      requestAnimationFrame(frame)
      return true
    },
    /** Resolves when the window should show; the light then fades over it. */
    go(input) {
      to = rect(input.to)
      // Not before the icon is there: the fold plays whole.
      const ready = START.trace + START.fold + START.appear - 220
      const wait = Math.max(0, started + ready - performance.now())
      return new Promise((resolve) =>
        setTimeout(() => {
          went = performance.now()
          showAt = () => resolve(true)
          if (!running) {
            running = true
            requestAnimationFrame(frame)
          }
        }, wait),
      )
    },
    /** Resolves once the light has faded. */
    done() {
      return new Promise((resolve) => {
        if (!running) return resolve(true)
        finished = () => resolve(true)
        setTimeout(() => resolve(true), 3500)
      })
    },
    cancel() {
      if (!cancelled) cancelled = performance.now()
      if (showAt) {
        showAt()
        showAt = null
      }
      return true
    },
  }
})()
