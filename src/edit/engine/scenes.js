// Explainer scenes (VISUAL_SCENES.md, EDD-51): the Director's cutaways, drawn by Kriya's own
// code from typed variables. A scene is an opaque tile, Web Animations only, so it seeks
// and renders like any other (EX-01): no model-written code, no clock, no randomness, no
// network. Layout is computed here, so a scene is the same in the preview and the render.

import { EngineFailure } from "./tool.js"

const FLICKS = 705_600_000

export const SCENE_BLOCK = "scene"
export const SCENE_VERSION = 1

/** Colours chosen so ink on plate holds WCAG 4.5:1 (tested). `band` backs a caption row on a light theme. */
export const SCENE_THEMES = {
  lab: { label: "Lab", bg: "#0b1f2a", plate: "#143545", ink: "#eaf6fb", accent: "#4fd1c5", hot: "#ffb347", line: "#2c5a6d" },
  blueprint: { label: "Blueprint", bg: "#0d2b52", plate: "#143c70", ink: "#f1f7ff", accent: "#7cc4ff", hot: "#ffd166", line: "#3a689f" },
  chalk: { label: "Chalkboard", bg: "#1b2a25", plate: "#273b33", ink: "#f5f1e6", accent: "#f4d35e", hot: "#ee964b", line: "#4c6358" },
  paper: { label: "Paper", bg: "#f6f1e7", plate: "#ffffff", ink: "#1c2530", accent: "#2a5cb3", hot: "#c8431f", line: "#c9c0ad", band: "#16232c" },
}

/** The kinds, what each needs, and what the Director and the Plan Card call it. */
export const SCENE_KINDS = {
  process: { label: "Steps", min: 2, max: 5, when: "steps that happen in order, or a chain of causes" },
  cycle: { label: "Cycle", min: 3, max: 5, when: "something that repeats and comes back to the start" },
  hub: { label: "Parts of an idea", min: 3, max: 6, when: "one term in the centre (the first item) and its parts or effects" },
  flow: { label: "Moving through", min: 2, max: 3, when: "something moving from one place to another; mode flows, blocked (stopped at the middle item or before the end) or floods (more and more of it arrives)" },
  compare: { label: "Side by side", min: 2, max: 2, when: "two things against each other, with their numbers if the speaker said them" },
  stat: { label: "Big number", min: 1, max: 1, values: true, when: "one number the speaker said; the item's value is that number" },
  bars: { label: "Number bars", min: 2, max: 6, values: true, when: "several numbers the speaker said, compared" },
}
export const FLOW_MODES = ["flows", "blocked", "floods"]
const TEXT_MAX = 32
const TITLE_MAX = 60
const UNIT_MAX = 8
const VALUE = /^\d{1,7}(?:[.,]\d{1,3})?$/

const cleanText = (value, max) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim() : "")

/**
 * A scene's shape, at every trust boundary (a model's answer, a browser's request). Unknown
 * fields go; text is cleaned. Whether its words were spoken is `groundProblems`' job.
 * @returns {object | null} null when it can't be a scene
 */
export function cleanScene(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const kind = Object.hasOwn(SCENE_KINDS, raw.kind ?? "") ? raw.kind : null
  if (!kind) return null
  const shape = SCENE_KINDS[kind]
  const items = (Array.isArray(raw.items) ? raw.items : []).slice(0, 6).map((item) => {
    const text = cleanText(item?.text, TEXT_MAX)
    const value = typeof item?.value === "string" && VALUE.test(item.value.trim()) ? item.value.trim() : undefined
    const unit = value !== undefined ? cleanText(item?.unit, UNIT_MAX) : ""
    return { text, ...(value !== undefined ? { value } : {}), ...(unit ? { unit } : {}) }
  })
  if (items.length < shape.min || items.length > shape.max || items.some((i) => !i.text)) return null
  if (shape.values && items.some((i) => i.value === undefined)) return null
  const id = (value) => (typeof value === "string" && /^[A-Za-z0-9:_-]{1,64}$/.test(value) ? value : null)
  return {
    kind,
    title: cleanText(raw.title, TITLE_MAX),
    items,
    theme: Object.hasOwn(SCENE_THEMES, raw.theme ?? "") ? raw.theme : "lab",
    ...(kind === "flow" ? { mode: FLOW_MODES.includes(raw.mode) ? raw.mode : "flows" } : {}),
    ...(id(raw.from) ? { from: id(raw.from) } : {}),
    ...(id(raw.to) ? { to: id(raw.to) } : {}),
  }
}

/** The kinds this scene's items can also be drawn as, its own first: what the Plan Card offers. */
export function swapsFor(scene) {
  const count = scene.items.length
  const valued = scene.items.every((i) => i.value !== undefined)
  const fits = Object.entries(SCENE_KINDS).filter(([, kind]) => count >= kind.min && count <= kind.max && (!kind.values || valued)).map(([id]) => id)
  return [scene.kind, ...fits.filter((id) => id !== scene.kind)]
}

/** Every word shown, for the copy gate and the timeline. */
export function sceneText(variables) {
  return [variables?.title, ...(variables?.items ?? []).flatMap((i) => [i.text, i.value !== undefined ? `${i.value}${i.unit ?? ""}` : ""])].filter(Boolean).join(" ")
}

/* ─────────────────────────────── geometry ─────────────────────────────── */

const escapeText = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
const round = (n) => Math.round(n * 100) / 100
const clampNumber = (n, a, b) => Math.max(a, Math.min(b, n))
// Spreads particles without randomness, so two renders are the same frame for frame
const seeded = (n) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

// Average glyph width in em, a little wide on purpose so a line never overflows its plate
const GLYPH = 0.6

/** Lines greedy wrap makes, long words broken. */
function linesAt(text, size, width) {
  const perLine = Math.max(1, Math.floor(width / (size * GLYPH)))
  let lines = 1
  let used = 0
  for (const word of String(text).split(" ")) {
    const length = word.length
    if (length > perLine) {
      lines += used ? 1 : 0
      lines += Math.ceil(length / perLine) - 1
      used = length % perLine
    } else if (used + (used ? 1 : 0) + length > perLine) {
      lines++
      used = length
    } else used += (used ? 1 : 0) + length
  }
  return lines
}

/** The biggest font that fits a box, never under the floor the legibility gate needs. */
export function fitFont(text, width, height, biggest, floor) {
  const longest = Math.max(...String(text).split(" ").map((word) => word.length))
  for (let size = Math.round(biggest); size > floor; size--) if (longest * size * GLYPH <= width && linesAt(text, size, width) * size * 1.2 <= height) return size
  return floor
}

const collide = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/**
 * Where each kind puts its boxes, inside `d`, the diagram's region. Plain data, tested for
 * overlap in every format. `tall`: the frame is portrait, so things stack.
 */
export function layoutKind(kind, count, d, base, tall = d.h > d.w) {
  const gap = Math.round(base * 0.9)
  const middle = { x: d.x + d.w / 2, y: d.y + d.h / 2 }
  if (kind === "process") {
    if (tall) {
      const h = Math.min((d.h - gap * (count - 1)) / count, base * 3.4)
      const total = h * count + gap * (count - 1)
      return Array.from({ length: count }, (_, i) => ({ x: d.x, y: d.y + (d.h - total) / 2 + i * (h + gap), w: d.w, h }))
    }
    const w = (d.w - gap * (count - 1)) / count
    const h = Math.min(d.h * 0.7, base * 6)
    return Array.from({ length: count }, (_, i) => ({ x: d.x + i * (w + gap), y: middle.y - h / 2, w, h }))
  }
  if (kind === "cycle") {
    let w = Math.min(d.w * (tall ? 0.5 : 0.28), base * 9.5)
    const h = Math.min(d.h * (tall ? 0.17 : 0.26), base * 3.2)
    for (;;) {
      const rx = (d.w - w) / 2
      const ry = (d.h - h) / 2
      const boxes = Array.from({ length: count }, (_, i) => {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / count
        return { x: middle.x + Math.cos(a) * rx - w / 2, y: middle.y + Math.sin(a) * ry - h / 2, w, h }
      })
      if (w <= base * 4 || !boxes.some((a, i) => boxes.some((b, k) => k > i && collide(a, b)))) return boxes
      w *= 0.94
    }
  }
  if (kind === "hub") {
    // The centre, with its parts in a row above and a row below: holds in every frame
    const spokes = count - 1
    const above = Math.ceil(spokes / 2)
    const rowH = Math.min((d.h - gap * 2) * 0.3, base * 3.3)
    const row = (n, y, from) => {
      const w = Math.min((d.w - gap * (n - 1)) / n, base * 9.5)
      const total = w * n + gap * (n - 1)
      return Array.from({ length: n }, (_, i) => ({ x: middle.x - total / 2 + i * (w + gap), y, w, h: rowH, from }))
    }
    const ch = Math.min(d.h - (rowH + gap * 1.6) * 2, base * 3.6)
    const cw = Math.min(d.w * 0.62, base * 11)
    const top = middle.y - ch / 2 - gap * 1.6 - rowH
    const bottom = middle.y + ch / 2 + gap * 1.6
    return [{ x: middle.x - cw / 2, y: middle.y - ch / 2, w: cw, h: ch }, ...row(above, top), ...row(spokes - above, bottom)]
  }
  if (kind === "flow") {
    const along = tall ? d.h : d.w
    const size = tall ? Math.min(along * 0.2, base * 3.4) : Math.min(along * (count === 3 ? 0.2 : 0.24), base * 7.5)
    const across = tall ? d.w : Math.min(d.h * 0.46, base * 4.8)
    const place = (u) => (tall ? { x: d.x, y: d.y + u * (d.h - size), w: across, h: size } : { x: d.x + u * (d.w - size), y: middle.y - across / 2, w: size, h: across })
    return count === 3 ? [place(0), place(0.5), place(1)] : [place(0), place(1)]
  }
  if (kind === "compare") {
    if (tall) {
      const h = (d.h - gap) / 2
      return [{ x: d.x, y: d.y, w: d.w, h }, { x: d.x, y: d.y + h + gap, w: d.w, h }]
    }
    const w = (d.w - gap) / 2
    return [{ x: d.x, y: d.y, w, h: d.h }, { x: d.x + w + gap, y: d.y, w, h: d.h }]
  }
  if (kind === "stat") return [{ x: d.x, y: d.y, w: d.w, h: d.h }]
  // bars: one row each
  const rowGap = Math.round(base * 0.45)
  const h = Math.min((d.h - rowGap * (count - 1)) / count, tall ? base * 3.6 : base * 2.6)
  const total = h * count + rowGap * (count - 1)
  return Array.from({ length: count }, (_, i) => ({ x: d.x, y: d.y + (d.h - total) / 2 + i * (h + rowGap), w: d.w, h }))
}

/* ─────────────────────────────── the composition ─────────────────────────────── */

const POP = { damping: 0.62, frequency: 13, ms: 560 }

/**
 * @param {{ variables: object, area: { x: number, y: number, w: number, h: number }, output: { width: number, height: number }, duration: number }} input
 * @param {(spring: object) => object[]} springKeyframes motion.js's, handed in so the two files don't import each other
 * @returns {{ css: string, body: string, animations: object[] }}
 */
export function buildScene({ variables, area, output, duration }, springKeyframes) {
  const scene = cleanScene(variables)
  if (!scene) throw new EngineFailure("plan", "bad_scene", "This scene's variables don't describe a scene.")
  const { kind, title, items } = scene
  const theme = SCENE_THEMES[scene.theme]
  const ms = (duration / FLICKS) * 1000
  const { width: W, height: H } = output
  const base = Math.round(Math.min(W, H) * 0.05)
  const tall = H > W
  const floor = Math.ceil(H * 0.0205)
  const titleSize = fitFont(title || " ", area.w, base * 3.4, base * 1.3, floor)
  const titleLines = title ? linesAt(title, titleSize, area.w) : 0
  const titleH = title ? Math.ceil(titleLines * titleSize * 1.2) : 0
  const room = titleH ? titleH + Math.round(base * 0.9) : 0
  const d = { x: area.x, y: area.y + room, w: area.w, h: area.h - room }
  const boxes = layoutKind(kind, items.length, d, base, tall).map((b) => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) }))

  // Each label when its word is spoken: code's times, or evenly through the first two thirds
  const start = Math.min(450, ms * 0.15)
  const last = Math.max(start, ms * 0.68)
  const reveals = items.map((item, i) => {
    const even = items.length === 1 ? start : start + ((last - start) * i) / (items.length - 1)
    return Math.round(clampNumber(variables.items?.[i]?.reveal ?? even, start, last))
  })

  const animations = []
  const animate = (id, keyframes, options) => animations.push({ id, keyframes, options: { fill: "both", ...options } })
  // The whole scene comes in and goes out, so the voice carries across
  const inMs = Math.min(240, ms * 0.1)
  const outMs = Math.min(200, ms * 0.08)
  animate("s", [{ opacity: 0, offset: 0 }, { opacity: 1, offset: round(inMs / ms) }, { opacity: 1, offset: round(1 - outMs / ms) }, { opacity: 0, offset: 1 }], { duration: ms })
  animate("w", [{ transform: "scale(1) translate(0,0)" }, { transform: "scale(1.04) translate(-0.6%,-0.4%)" }], { duration: ms, easing: "linear" })

  const pop = (id, at, from = { y: Math.round(base * 0.9), scale: 0.88, opacity: 0 }) => animate(id, springKeyframes({ ...POP, from, to: { y: 0, scale: 1, opacity: 1 } }), { duration: POP.ms, delay: at })
  const draw = (id, at, length = 420) => animate(id, [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: length, delay: Math.max(0, at), easing: "cubic-bezier(.3,0,.2,1)" })

  const parts = []
  const svg = []
  const label = (i, box, text, { size, plate = theme.plate, color = theme.ink, extra = "", align = "center", transparent = false } = {}) => {
    const pad = Math.round(base * 0.45)
    const font = size ?? fitFont(text, box.w - pad * 2, box.h - pad, base * 1.1, floor)
    const seen = plate === theme.bg
    parts.push(`<div id="l${i}" class="l" style="left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px;background:${transparent ? "transparent" : plate};justify-content:${align};${seen || transparent ? "border-color:transparent;" : ""}${extra}"><span data-text style="font-size:${font}px;background:${plate};color:${color};text-align:${align === "center" ? "center" : "left"}">${escapeText(text)}</span></div>`)
    pop(`l${i}`, reveals[i] ?? start)
    // A ring leaves the card as it lands, so the eye goes to what was just said
    if (!seen) animate(`l${i}`, [{ boxShadow: `0 0 0 0 ${theme.accent}cc` }, { boxShadow: `0 0 0 ${Math.round(base * 0.5)}px ${theme.accent}00` }], { duration: 620, delay: (reveals[i] ?? start) + 90, easing: "ease-out" })
  }
  const dash = `pathLength="1" stroke-dasharray="1" stroke-dashoffset="1"`
  const stroke = Math.max(4, Math.round(base * 0.14))
  const centerOf = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })
  // A point on a box's edge on the way to another point, so lines start at the plate, not inside it
  const edgeToward = (b, to) => {
    const c = centerOf(b)
    const dx = to.x - c.x
    const dy = to.y - c.y
    const scale = Math.min(dx ? b.w / 2 / Math.abs(dx) : Infinity, dy ? b.h / 2 / Math.abs(dy) : Infinity)
    return { x: Math.round(c.x + dx * scale), y: Math.round(c.y + dy * scale) }
  }
  const arrow = (id, a, b, at, colour = theme.accent) => {
    const from = edgeToward(a, centerOf(b))
    const to = edgeToward(b, centerOf(a))
    const angle = Math.atan2(to.y - from.y, to.x - from.x)
    const head = Math.round(base * 0.42)
    const tip = (t) => `${Math.round(to.x - head * Math.cos(angle + t))},${Math.round(to.y - head * Math.sin(angle + t))}`
    svg.push(`<path id="${id}" d="M${from.x} ${from.y}L${to.x} ${to.y}" fill="none" stroke="${colour}" stroke-width="${stroke}" stroke-linecap="round" ${dash}/>`)
    svg.push(`<polygon id="${id}h" points="${to.x},${to.y} ${tip(0.45)} ${tip(-0.45)}" fill="${colour}"/>`)
    draw(id, at - 380, 380)
    animate(`${id}h`, [{ opacity: 0 }, { opacity: 1 }], { duration: 120, delay: Math.max(0, at - 60) })
    return { from, to }
  }
  // A small light travelling a path for the rest of the scene, so a finished diagram still lives
  const pulses = []
  const runner = (id, path, at, loop, size = Math.round(base * 0.34), colour = theme.hot, offset = 0) => {
    pulses.push(`<i id="${id}" class="p" style="width:${size}px;height:${size}px;margin:${-size / 2}px 0 0 ${-size / 2}px;background:${colour};box-shadow:0 0 ${size}px ${colour};offset-path:path('${path}')"></i>`)
    const remaining = Math.max(1, ms - at)
    animate(id, [{ offsetDistance: "0%", opacity: 0, offset: 0 }, { opacity: 1, offset: 0.08 }, { opacity: 1, offset: 0.92 }, { offsetDistance: "100%", opacity: 0, offset: 1 }], { duration: loop, delay: at + offset, iterations: Math.max(1, Math.ceil(remaining / loop)), easing: "linear" })
  }

  if (kind === "process") {
    items.forEach((item, i) => {
      label(i, boxes[i], item.text)
      if (i) arrow(`a${i}`, boxes[i - 1], boxes[i], reveals[i])
    })
    const allIn = reveals.at(-1) + POP.ms
    items.slice(1).forEach((_, i) => {
      const from = edgeToward(boxes[i], centerOf(boxes[i + 1]))
      const to = edgeToward(boxes[i + 1], centerOf(boxes[i]))
      runner(`r${i}`, `M${from.x} ${from.y}L${to.x} ${to.y}`, allIn, 1400, undefined, undefined, i * 280)
    })
  } else if (kind === "cycle") {
    const c = { x: d.x + d.w / 2, y: d.y + d.h / 2 }
    const rx = Math.round((d.w - boxes[0].w) / 2)
    const ry = Math.round((d.h - boxes[0].h) / 2)
    const ring = `M${c.x} ${c.y - ry}A${rx} ${ry} 0 1 1 ${c.x} ${c.y + ry}A${rx} ${ry} 0 1 1 ${c.x} ${c.y - ry}`
    svg.push(`<path id="ring" d="${ring}" fill="none" stroke="${theme.line}" stroke-width="${stroke}" ${dash}/>`)
    draw("ring", start, Math.max(600, last - start))
    items.forEach((item, i) => label(i, boxes[i], item.text))
    const allIn = reveals.at(-1) + 200
    for (let i = 0; i < 3; i++) runner(`r${i}`, ring, allIn, 3200, undefined, i === 0 ? theme.hot : theme.accent, i * 1066)
  } else if (kind === "hub") {
    label(0, boxes[0], items[0].text, { plate: theme.accent, color: theme.bg })
    items.slice(1).forEach((item, i) => {
      const box = boxes[i + 1]
      const from = edgeToward(boxes[0], centerOf(box))
      const to = edgeToward(box, centerOf(boxes[0]))
      svg.push(`<path id="a${i}" d="M${from.x} ${from.y}L${to.x} ${to.y}" fill="none" stroke="${theme.accent}" stroke-width="${stroke}" stroke-linecap="round" ${dash}/>`)
      draw(`a${i}`, reveals[i + 1] - 320, 320)
      label(i + 1, box, item.text)
      runner(`r${i}`, `M${from.x} ${from.y}L${to.x} ${to.y}`, reveals[i + 1] + POP.ms, 1500, undefined, undefined, i * 220)
    })
  } else if (kind === "flow") {
    const first = boxes[0]
    const lastBox = boxes.at(-1)
    const a = edgeToward(first, centerOf(lastBox))
    const b = edgeToward(lastBox, centerOf(first))
    const mode = scene.mode
    const width = Math.round(base * (tall ? 3.4 : 2.6))
    // The vessel: a wide soft channel with its two walls drawn in
    const tube = `M${a.x} ${a.y}L${b.x} ${b.y}`
    svg.push(`<path d="${tube}" fill="none" stroke="${theme.plate}" stroke-width="${width}"/>`)
    const nx = tall ? width / 2 : 0
    const ny = tall ? 0 : width / 2
    for (const [n, sign] of [[0, 1], [1, -1]]) {
      svg.push(`<path id="wall${n}" d="M${a.x + sign * nx} ${a.y + sign * ny}L${b.x + sign * nx} ${b.y + sign * ny}" fill="none" stroke="${theme.line}" stroke-width="${Math.max(3, stroke - 2)}" ${dash}/>`)
      draw(`wall${n}`, start, 520)
    }
    // Stops short of the end when blocked: at the middle item if there is one, else a barrier
    const stopAt = items.length === 3 ? edgeToward(boxes[1], centerOf(first)) : { x: Math.round(a.x + (b.x - a.x) * 0.55), y: Math.round(a.y + (b.y - a.y) * 0.55) }
    const span = Math.hypot(b.x - a.x, b.y - a.y)
    const count = mode === "floods" ? 36 : 22
    const size = Math.round(base * 0.5)
    const window = Math.max(600, ms - start - 400)
    for (let i = 0; i < count; i++) {
      const lane = (seeded(i) - 0.5) * (width - size * 1.6)
      const ox = tall ? lane : 0
      const oy = tall ? 0 : lane
      const colour = seeded(i + 40) > 0.75 ? theme.accent : theme.hot
      const end = mode === "blocked" ? stopAt : b
      // Blocked: they pile up behind the stop, each a little further back than the last
      const pile = mode === "blocked" ? 1 - (seeded(i + 7) * 0.32 + (i / count) * 0.2) : 1
      const path = `M${a.x + ox} ${a.y + oy}L${Math.round(a.x + (end.x - a.x) * pile + ox)} ${Math.round(a.y + (end.y - a.y) * pile + oy)}`
      const u = (i + seeded(i + 20) * 0.6) / count
      // Floods: few at first, then more and more
      const when = start + 200 + window * 0.82 * (mode === "floods" ? Math.sqrt(u) : u)
      const travel = Math.max(450, (span / (base * 18)) * 1000) * (0.85 + seeded(i + 3) * 0.3)
      pulses.push(`<i id="q${i}" class="p" style="width:${size}px;height:${size}px;margin:${-size / 2}px 0 0 ${-size / 2}px;background:${colour};offset-path:path('${path}')"></i>`)
      if (mode === "blocked") animate(`q${i}`, [{ offsetDistance: "0%", opacity: 0, offset: 0 }, { opacity: 1, offset: 0.1 }, { offsetDistance: "100%", opacity: 1, offset: 1 }], { duration: travel, delay: when * 0.6, easing: "cubic-bezier(.2,.7,.3,1)" })
      else animate(`q${i}`, [{ offsetDistance: "0%", opacity: 0, offset: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 1, offset: 0.9 }, { offsetDistance: "100%", opacity: 0, offset: 1 }], { duration: travel, delay: when, iterations: Math.max(1, Math.ceil((ms - when) / travel)), easing: "linear" })
    }
    if (mode === "blocked" && items.length === 2) {
      const bar = Math.round(width * 0.62)
      const gx = stopAt.x
      const gy = stopAt.y
      svg.push(`<path id="stop" d="${tall ? `M${gx - bar} ${gy}L${gx + bar} ${gy}` : `M${gx} ${gy - bar}L${gx} ${gy + bar}`}" fill="none" stroke="${theme.hot}" stroke-width="${stroke * 2}" stroke-linecap="round" ${dash}/>`)
      draw("stop", start + 260, 260)
    }
    if (mode === "floods") {
      // The far end fills up
      parts.push(`<div class="c" style="left:${lastBox.x}px;top:${lastBox.y}px;width:${lastBox.w}px;height:${lastBox.h}px;background:${theme.plate}"></div><div id="fill" class="c" style="left:${lastBox.x}px;top:${lastBox.y}px;width:${lastBox.w}px;height:${lastBox.h}px;background:${theme.hot};transform-origin:50% 100%"></div>`)
      animate("fill", [{ transform: "scaleY(0)", opacity: 0.9 }, { transform: "scaleY(1)", opacity: 0.9 }], { duration: Math.max(400, ms - start - 300), delay: start + 200, easing: "cubic-bezier(.5,0,.8,.6)" })
    }
    items.forEach((item, i) => label(i, boxes[i], item.text, mode === "floods" && i === items.length - 1 ? { transparent: true } : {}))
  } else if (kind === "compare") {
    const numbers = items.map((i) => Number(String(i.value ?? "").replace(",", ".")))
    const bothNumbers = numbers.every((n) => Number.isFinite(n) && n >= 0) && items.every((i) => i.value !== undefined)
    const largest = Math.max(1e-9, ...numbers.filter(Number.isFinite))
    items.forEach((item, i) => {
      const box = boxes[i]
      const colour = i ? theme.hot : theme.accent
      const pad = Math.round(base * 0.7)
      parts.push(`<div id="c${i}" class="c" style="left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px;background:${theme.plate}"></div>`)
      pop(`c${i}`, reveals[i])
      const textBox = { x: box.x + pad, y: box.y + pad, w: box.w - pad * 2, h: Math.round((box.h - pad * 2) * (item.value !== undefined ? 0.42 : 1)) }
      label(i, textBox, item.text, { size: fitFont(item.text, textBox.w - base, textBox.h - base * 0.4, base * 1.3, floor), extra: "border-color:transparent;" })
      if (item.value !== undefined) {
        const numberBox = { x: box.x + pad, y: textBox.y + textBox.h + Math.round(base * 0.2), w: box.w - pad * 2, h: Math.round((box.h - pad * 2) * 0.34) }
        const text = `${item.value}${item.unit ?? ""}`
        const size = Math.max(floor, Math.min(Math.round(numberBox.h * 0.8), Math.floor((numberBox.w - base) / (text.length * 0.66))))
        parts.push(`<div id="n${i}" class="l" style="left:${numberBox.x}px;top:${numberBox.y}px;width:${numberBox.w}px;height:${numberBox.h}px;background:${theme.plate};border-color:transparent"><span class="n" data-text style="font-size:${size}px;background:${theme.plate};color:${colour};text-align:center">${escapeText(text)}</span></div>`)
        pop(`n${i}`, reveals[i] + 140)
        if (bothNumbers) {
          const track = { x: box.x + pad, y: numberBox.y + numberBox.h + Math.round(base * 0.2), w: box.w - pad * 2, h: Math.round(base * 0.55) }
          parts.push(`<div class="c" style="left:${track.x}px;top:${track.y}px;width:${track.w}px;height:${track.h}px;background:${theme.bg}"></div><div id="b${i}" class="c" style="left:${track.x}px;top:${track.y}px;width:${Math.max(track.h, Math.round((track.w * numbers[i]) / largest))}px;height:${track.h}px;background:${colour};transform-origin:0 50%"></div>`)
          animate(`b${i}`, [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: 700, delay: reveals[i] + 200, easing: "cubic-bezier(.2,.8,.2,1)" })
        }
      }
    })
  } else if (kind === "stat") {
    const item = items[0]
    const box = boxes[0]
    const value = String(item.value)
    const unit = item.unit ?? ""
    const numberH = Math.round(box.h * 0.46)
    const size = Math.round(Math.min(numberH * 0.86, (box.w * 0.92) / (value.length * 0.62 + unit.length * 1.05)))
    const top = box.y + Math.round(box.h * 0.1)
    const cellW = Math.round(size * 0.62)
    const unitW = Math.ceil(size * 1.05 * unit.length)
    const totalW = cellW * value.length + unitW
    let x = box.x + Math.round((box.w - totalW) / 2)
    const cellH = Math.round(size * 1.16)
    const rail = Array.from({ length: 10 }, (_, n) => `<b style="height:${cellH}px;line-height:${cellH}px">${n}</b>`).join("")
    let column = 0
    for (const ch of value) {
      if (/\d/.test(ch)) {
        const id = `d${column}`
        parts.push(`<div class="o" style="left:${x}px;top:${top}px;width:${cellW}px;height:${cellH}px;font-size:${size}px;color:${theme.hot}"><div id="${id}" style="position:absolute;left:0;top:0;width:100%;text-align:center">${rail}</div></div>`)
        // Rolls through the digits and settles on the spoken one
        const target = -Number(ch) * cellH
        animate(id, [{ transform: `translateY(${cellH * 0}px)` }, { transform: `translateY(${target}px)` }], { duration: 760 + column * 90, delay: reveals[0], easing: "cubic-bezier(.16,.9,.28,1)" })
        column++
      } else parts.push(`<div class="o" style="left:${x}px;top:${top}px;width:${cellW}px;height:${cellH}px;font-size:${size}px;line-height:${cellH}px;color:${theme.hot};text-align:center">${escapeText(ch)}</div>`)
      x += cellW
    }
    if (unit) parts.push(`<div id="u" class="o" style="left:${x}px;top:${top}px;width:${unitW}px;height:${cellH}px;font-size:${size}px;line-height:${cellH}px;color:${theme.accent};text-align:left;white-space:nowrap">${escapeText(unit)}</div>`)
    if (unit) pop("u", reveals[0] + 500)
    // A share of 100 fills a line under the number
    const whole = Number(value.replace(",", "."))
    const barY = top + cellH + Math.round(base * 0.6)
    if (unit === "%" && whole >= 0 && whole <= 100) {
      const barH = Math.round(base * 0.5)
      const barX = box.x + Math.round(box.w * 0.08)
      const barW = Math.round(box.w * 0.84)
      parts.push(`<div class="c" style="left:${barX}px;top:${barY}px;width:${barW}px;height:${barH}px;background:${theme.plate}"></div><div id="fillbar" class="c" style="left:${barX}px;top:${barY}px;width:${Math.max(barH, Math.round((barW * whole) / 100))}px;height:${barH}px;background:${theme.hot};transform-origin:0 50%"></div>`)
      animate("fillbar", [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: 800, delay: reveals[0] + 200, easing: "cubic-bezier(.2,.8,.2,1)" })
    }
    const labelY = barY + Math.round(base * 1.4)
    label(0, { x: box.x, y: labelY, w: box.w, h: Math.max(Math.round(base * 2.4), box.y + box.h - labelY) }, item.text, { size: fitFont(item.text, box.w - base, Math.max(Math.round(base * 2.4), box.y + box.h - labelY) - base * 0.4, base * 1.3, floor) })
  } else {
    const numbers = items.map((i) => Number(String(i.value).replace(",", ".")))
    const largest = Math.max(1e-9, ...numbers)
    items.forEach((item, i) => {
      const box = boxes[i]
      const stacked = tall
      const labelW = stacked ? box.w : Math.round(box.w * 0.36)
      const labelH = stacked ? Math.round(box.h * 0.52) : box.h
      const trackY = stacked ? box.y + labelH : box.y + Math.round(box.h * 0.2)
      const trackX = stacked ? box.x : box.x + labelW + Math.round(base * 0.4)
      const trackH = stacked ? box.h - labelH : Math.round(box.h * 0.6)
      const valueText = `${item.value}${item.unit ?? ""}`
      const valueW = Math.round(Math.max(base * 2.4, (valueText.length * base * 0.72) + base * 0.9))
      const trackW = box.x + box.w - trackX - valueW - Math.round(base * 0.3)
      const size = fitFont(item.text, labelW - base, labelH - base * 0.2, base, floor)
      label(i, { x: box.x, y: box.y, w: labelW, h: labelH }, item.text, { size, align: "flex-start" })
      const barW = Math.max(trackH, Math.round((trackW * numbers[i]) / largest))
      const colour = numbers[i] === largest ? theme.hot : theme.accent
      parts.push(`<div class="c" style="left:${trackX}px;top:${trackY}px;width:${trackW}px;height:${trackH}px;background:${theme.plate}"></div><div id="b${i}" class="c" style="left:${trackX}px;top:${trackY}px;width:${barW}px;height:${trackH}px;background:${colour};transform-origin:0 50%"></div>`)
      animate(`b${i}`, [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: 760, delay: reveals[i] + 60, easing: "cubic-bezier(.2,.8,.2,1)" })
      const numberSize = Math.max(floor, Math.min(base, Math.floor((valueW - base * 0.9) / (valueText.length * 0.66)), Math.floor(trackH / 1.2)))
      parts.push(`<div id="n${i}" class="l" style="left:${trackX + trackW + Math.round(base * 0.3)}px;top:${trackY}px;width:${valueW}px;height:${trackH}px;background:${theme.plate};justify-content:center"><span class="n" data-text style="font-size:${numberSize}px;background:${theme.plate};color:${colour};text-align:center">${escapeText(valueText)}</span></div>`)
      pop(`n${i}`, reveals[i] + 260)
    })
  }

  // A few slow motes behind everything, so a finished diagram still lives
  const motes = []
  for (let i = 0; i < 14; i++) {
    const size = Math.round(base * (0.14 + seeded(i + 60) * 0.2))
    const x = Math.round(seeded(i + 80) * W)
    const y = Math.round(seeded(i + 100) * H)
    const drift = Math.round(base * (2 + seeded(i + 120) * 3))
    motes.push(`<i id="m${i}" class="p" style="left:${x}px;top:${y}px;width:${size}px;height:${size}px;background:${i % 3 ? theme.accent : theme.hot};opacity:.22"></i>`)
    animate(`m${i}`, [{ transform: "translate(0,0)" }, { transform: `translate(${Math.round((seeded(i + 140) - 0.5) * drift)}px,${-drift}px)` }], { duration: ms, easing: "linear" })
  }

  // The caption row on a light theme keeps its own dark band, so white captions read
  const bandTop = area.y + area.h
  const band = variables.band && theme.band ? `<div class="c" style="left:0;top:${bandTop}px;width:${W}px;height:${H - bandTop}px;background:${theme.band};border-radius:0"></div>` : ""
  const titleHtml = title ? `<div id="t" class="t" style="left:${area.x}px;top:${area.y}px;width:${area.w}px"><span data-text style="font-size:${titleSize}px;background:${theme.bg}">${escapeText(title)}</span></div>` : ""
  if (title) pop("t", Math.min(120, ms * 0.04), { y: Math.round(base * 0.6), opacity: 0 })
  const dots = Math.round(base * 1.1)
  const pattern = scene.theme === "blueprint" || scene.theme === "paper" ? `background-image:linear-gradient(${theme.line}33 1px,transparent 1px),linear-gradient(90deg,${theme.line}33 1px,transparent 1px);background-size:${dots * 2}px ${dots * 2}px` : `background-image:radial-gradient(${theme.line}66 ${Math.max(1, Math.round(base * 0.05))}px,transparent 0);background-size:${dots}px ${dots}px`

  return {
    css: `#s{position:absolute;inset:0;background:${theme.bg};overflow:hidden;font-family:'Helvetica Neue',Helvetica,Arial,'Noto Sans','Noto Sans Devanagari','Noto Sans Telugu',sans-serif;color:${theme.ink}}#w{position:absolute;inset:-4%;${pattern}}#v{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 45%,${theme.accent}26,transparent 68%)}#g{position:absolute;left:0;top:0;width:${W}px;height:${H}px;overflow:visible}.l,.c,.o,.t,.p{position:absolute}.l{display:flex;align-items:center;border-radius:${Math.round(base * 0.4)}px;box-sizing:border-box;padding:0 ${Math.round(base * 0.4)}px;border:${Math.max(2, Math.round(base * 0.05))}px solid ${theme.line}}.l span{display:block;width:100%;font-weight:700;line-height:1.2;overflow-wrap:anywhere;border-radius:.2em}.l span.n{white-space:nowrap;overflow-wrap:normal;font-weight:800}.c{border-radius:${Math.round(base * 0.4)}px}.o{overflow:hidden;font-weight:800;font-variant-numeric:tabular-nums}.o b{display:block;font-weight:800}.t{text-align:center}.t span{font-weight:800;line-height:1.2;display:inline-block;max-width:100%}.p{left:0;top:0;border-radius:50%;offset-rotate:0deg}`,
    body: `<div id="s"><div id="w"></div><div id="v"></div>${motes.join("")}${band}<svg id="g" viewBox="0 0 ${W} ${H}">${svg.join("")}</svg>${pulses.join("")}${titleHtml}${parts.join("")}</div>`,
    animations,
  }
}
