// The timeline (STUDIO_APP_AND_BROWSER §7): drawn on a canvas, flat for legibility,
// with a hidden focusable list mirroring the clips so the keyboard and screen readers
// have real elements. The same drawing, one row tall, is Direct mode's story strip.
// shortcut: draws on the main thread and the whole cut fits the width; an
// OffscreenCanvas worker and zoom come when long edits need them.

import { clear, h } from "./dom.js"
import { timecode } from "./time.js"

const ROWS = [
  { key: "picture", label: "Picture", colour: "--clip-picture" },
  { key: "overlays", label: "B-roll", colour: "--clip-broll" },
  { key: "audio", label: "Audio", colour: "--clip-audio" },
  { key: "captions", label: "Captions", colour: "--clip-caption" },
]
const ROW = 44
const GAP = 6

/**
 * @param {{ root: HTMLElement, compact?: boolean, onSeek: (t: number) => void, onSelect?: (clip: string | null) => void }} options
 */
export function createTimeline({ root, compact = false, onSeek, onSelect = () => {} }) {
  const rows = compact ? ROWS.slice(0, 1) : ROWS
  const canvas = h("canvas", { class: "lanes", "aria-hidden": "true" })
  const labels = compact ? null : h("div", { class: "lane-labels", "aria-hidden": "true" }, rows.map((row) => h("div", { class: "lane-label" }, row.label)))
  const list = h("ul", { class: "clip-list", "aria-label": compact ? "Story" : "Clips on the timeline" })
  root.append(...[labels, h("div", { class: "lanes-wrap" }, canvas), list].filter(Boolean))
  const ctx = canvas.getContext("2d")
  let timeline = { picture: [], overlays: [], audio: [], captions: [] }
  let duration = 0
  let fps = { n: 30, d: 1 }
  let t = 0
  let marks = []
  let pins = [] // the person's notes from the Review Room, by timeline time (ED15)
  let peaks = new Map() // asset → finest peaks per second level
  let selected = null
  let ghost = null // a proposal's picture, drawn dashed over the Picture row (Proposal mode)

  const colour = (name) => getComputedStyle(root).getPropertyValue(name).trim() || "#888"

  function draw() {
    const width = Math.max(1, canvas.clientWidth)
    const height = rows.length * (ROW + GAP)
    const ratio = window.devicePixelRatio || 1
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      canvas.style.height = `${height}px`
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, width, height)
    const x = (at) => (duration ? (at / duration) * width : 0)
    rows.forEach((row, r) => {
      const y = r * (ROW + GAP)
      ctx.fillStyle = colour("--lane")
      ctx.fillRect(0, y, width, ROW)
      for (const item of timeline[row.key] ?? []) {
        const left = x(item.at)
        const w = Math.max(2, x(item.end) - left)
        ctx.fillStyle = colour(row.colour)
        ctx.fillRect(left, y + 2, w - 1, ROW - 4)
        if (item.clip && item.clip === selected) {
          ctx.strokeStyle = colour("--focus")
          ctx.lineWidth = 2
          ctx.strokeRect(left + 1, y + 3, w - 3, ROW - 6)
        }
        const level = row.key === "audio" || (compact && row.key === "picture") ? peaks.get(item.asset) : null
        if (level && item.in !== undefined) {
          ctx.fillStyle = colour("--wave")
          const span = item.out - item.in
          for (let px = 0; px < w; px++) {
            const source = (item.in + (span * px) / w) / 705_600_000
            const peak = level.peaks[Math.floor(source * level.perSecond)] ?? 0
            const bar = peak * (ROW - 8)
            ctx.fillRect(left + px, y + ROW / 2 - bar / 2, 1, Math.max(1, bar))
          }
        }
      }
      if (row.key === "picture" && ghost) {
        ctx.strokeStyle = colour("--ghost")
        ctx.setLineDash([5, 4])
        ctx.lineWidth = 2
        const scale = Math.max(duration, ghost.duration) || 1
        for (const item of ghost.picture) ctx.strokeRect((item.at / scale) * width + 1, y + 6, Math.max(2, ((item.end - item.at) / scale) * width - 2), ROW - 12)
        ctx.setLineDash([])
      }
      if (row.key === "picture") {
        ctx.fillStyle = colour("--shot")
        for (const mark of marks) ctx.fillRect(x(mark.at) - 0.5, y, 1, 8)
      }
    })
    // A note from the Review Room: a pin along the top, in the playhead's colour
    ctx.fillStyle = colour("--playhead")
    for (const pin of pins) ctx.fillRect(x(pin.at) - 1, 0, 3, 8)
    ctx.fillStyle = colour("--playhead")
    ctx.fillRect(x(t) - 1, 0, 2, height)
  }

  let dragging = false
  const seekAt = (event) => {
    const rect = canvas.getBoundingClientRect()
    onSeek(Math.round(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * duration))
  }
  canvas.addEventListener("pointerdown", (event) => {
    dragging = true
    canvas.setPointerCapture(event.pointerId)
    seekAt(event)
  })
  canvas.addEventListener("pointermove", (event) => dragging && seekAt(event))
  canvas.addEventListener("pointerup", () => (dragging = false))
  new ResizeObserver(draw).observe(canvas)

  function select(clip) {
    selected = clip
    for (const el of list.querySelectorAll("button")) el.setAttribute("aria-pressed", String(el.dataset.clip === clip))
    onSelect(clip)
    draw()
  }

  return {
    load(next, { duration: total, fps: rate, marks: shotMarks = [], pins: notes = [] }) {
      pins = notes
      timeline = next
      duration = total
      fps = rate
      marks = shotMarks
      if (selected && !timeline.picture.some((p) => p.clip === selected)) selected = null
      clear(list)
      for (const piece of timeline.picture.filter((p, i, all) => all.findIndex((q) => q.clip === p.clip) === i)) {
        const button = h("button", { type: "button", "aria-pressed": String(piece.clip === selected), dataset: { clip: piece.clip }, onclick: () => (select(piece.clip), onSeek(piece.at)) }, `Clip ${piece.clip}, ${timecode(piece.at, fps)} to ${timecode(piece.end, fps)}`)
        list.append(h("li", {}, button))
      }
      draw()
    },
    setPeaks(asset, level) {
      peaks.set(asset, level)
      draw()
    },
    /** Shows a proposal's clips as ghosts until it is accepted or rejected; null clears them. */
    setGhost(next) {
      ghost = next
      draw()
    },
    setTime(next) {
      t = next
      draw()
    },
    select,
    get selected() {
      return selected
    },
    draw,
  }
}
