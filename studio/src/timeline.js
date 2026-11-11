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
// Trim handles (TP3, editing.livePreview): a narrow strip just inside each end of a picture clip.
// Anywhere else a press still scrubs (EH-67). A finger gets 22 px inside each clip, so 44 across a cut
export const HANDLE = { mouse: 6, touch: 22 }
const SNAP_PX = 8 // a dragged edge lands on a word's edge or a beat this close

/** The picture clip edge under x on the Picture row, or null. Clips too short for both handles have none. */
export function handleAt(picture, x, { width, duration, pointer = "mouse" }) {
  if (!duration) return null
  const reach = pointer === "touch" ? HANDLE.touch : HANDLE.mouse
  const px = (at) => (at / duration) * width
  const clips = new Map()
  for (const item of picture) {
    const clip = clips.get(item.clip) ?? { clip: item.clip, at: item.at, end: item.end }
    clips.set(item.clip, { ...clip, at: Math.min(clip.at, item.at), end: Math.max(clip.end, item.end) })
  }
  for (const clip of clips.values()) {
    const [left, right] = [px(clip.at), px(clip.end)]
    if (right - left < reach * 3) continue
    if (x >= left && x < left + reach) return { clip: clip.clip, edge: "in", at: clip.at }
    if (x >= right - reach && x < right) return { clip: clip.clip, edge: "out", at: clip.end }
  }
  return null
}

/** t moved onto the nearest snap time within SNAP_PX, or left where it is. */
export function snapTo(t, snaps, { width, duration }) {
  let best = t
  let off = (SNAP_PX / width) * duration
  for (const s of snaps) if (Math.abs(s - t) <= off) [best, off] = [s, Math.abs(s - t)]
  return best
}

/**
 * @param {{ root: HTMLElement, compact?: boolean, onSeek: (t: number) => void, onSelect?: (clip: string | null) => void, onTrim?: (trim: { clip: string, edge: "in" | "out", at: number }) => void }} options
 * onTrim: edge handles are on (TP3); without it the timeline is what it was
 */
export function createTimeline({ root, compact = false, onSeek, onSelect = () => {}, onTrim }) {
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
  const trims = Boolean(onTrim) && !compact
  let snaps = [] // timeline times a trimmed edge lands on: word edges and beats
  let trimming = null // { clip, edge, at }: the edge being dragged, drawn where it would land

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
      if (row.key === "picture" && trims) {
        // A small grip at each end of every clip long enough to have one
        ctx.fillStyle = colour("--ink-2")
        for (const item of timeline.picture) {
          const [left, right] = [x(item.at), x(item.end)]
          if (right - left < HANDLE.mouse * 3) continue
          if (!timeline.picture.some((p) => p.clip === item.clip && p.end === item.at)) ctx.fillRect(left + 1, y + ROW / 2 - 8, 2, 16)
          if (!timeline.picture.some((p) => p.clip === item.clip && p.at === item.end)) ctx.fillRect(right - 3, y + ROW / 2 - 8, 2, 16)
        }
        if (trimming) {
          ctx.fillStyle = colour("--focus")
          ctx.fillRect(x(trimming.at) - 1, y, 3, ROW)
        }
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
  // An edge handle under the pointer, only on the Picture row (the first)
  const handleUnder = (event) => {
    if (!trims) return null
    const rect = canvas.getBoundingClientRect()
    if (event.clientY - rect.top > ROW) return null
    return handleAt(timeline.picture, event.clientX - rect.left, { width: rect.width, duration, pointer: event.pointerType === "touch" ? "touch" : "mouse" })
  }
  const trimAt = (event) => {
    const rect = canvas.getBoundingClientRect()
    const raw = Math.round(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * duration)
    trimming = { ...trimming, at: snapTo(raw, snaps, { width: rect.width, duration }) }
    draw()
  }
  canvas.addEventListener("pointerdown", (event) => {
    canvas.setPointerCapture(event.pointerId)
    const handle = handleUnder(event)
    if (handle) {
      trimming = { ...handle, from: handle.at }
      return draw()
    }
    dragging = true
    seekAt(event)
  })
  canvas.addEventListener("pointermove", (event) => {
    if (trimming) return trimAt(event)
    if (dragging) return seekAt(event)
    if (trims) canvas.style.cursor = handleUnder(event) ? "ew-resize" : ""
  })
  canvas.addEventListener("pointerup", () => {
    dragging = false
    if (!trimming) return
    const done = trimming
    trimming = null
    draw()
    // A press on a handle that didn't move it changes nothing
    if (done.at !== done.from) onTrim({ clip: done.clip, edge: done.edge, at: done.at })
  })
  if (trims)
    canvas.addEventListener("pointercancel", () => {
      dragging = false
      trimming = null
      draw()
    })
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
    /** Where a trimmed edge snaps: timeline times of word edges and beats (TP3). */
    setSnaps(next) {
      snaps = next
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
