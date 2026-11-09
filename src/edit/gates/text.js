// QG-08 Layout and QG-09 Legibility (QUALITY_GATES §2, ED8). Both read what was
// actually drawn: text boxes measured in the tile's own DOM at each beat, face boxes
// mapped onto the output, and the composited pixels behind each text box.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"

import { outputFaces } from "../core/faces.js"
import { segmentArgs } from "../core/ffmpeg.js"
import { isSceneBlock, safeZoneFor } from "../core/layout.js"
import { wholeSegment } from "../core/plan.js"
import { captionComposition, READING_LIMITS, scriptOf } from "../engine/captions.js"
import { compositionFor, measureText } from "../engine/motion.js"

const FLICKS = 705_600_000
const SETTLE_MS = { caption: 350, block: 950 } // the entrances' lengths, so a beat sees text at rest

const MIN_PAGE_SECONDS = 1.2
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const frameMs = (fps) => (1000 * fps.d) / fps.n
const rounded = (box) => ({ x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) })

/** The times worth looking at in a tile, in ms from its start: at rest, each word, the last frame. */
export function beatsOf(tile, fps) {
  const length = Math.max(0, (tile.end - tile.at) / FLICKS) * 1000
  const last = Math.max(0, length - frameMs(fps))
  const times = [Math.min(last, SETTLE_MS[tile.kind] ?? 0), last]
  if (tile.kind === "caption") for (const word of tile.node.words) times.push((((word.at + word.end) / 2) / FLICKS) * 1000)
  return [...new Set(times.filter((t) => t >= Math.min(last, SETTLE_MS[tile.kind] ?? 0) && t <= last).map((t) => Math.round(t)))].sort((a, b) => a - b)
}

const textTiles = (plan) => plan.tiles.filter((tile) => tile.kind === "caption" || tile.kind === "block")

/**
 * Every text tile measured at every beat of every tile it shares the screen with.
 * @returns {Promise<{ t: number, tile: object, box: object }[]>} t: output flicks
 */
export async function measurePlan(plan, { motion, work, measure = measureText }) {
  const tiles = textTiles(plan)
  const beats = [...new Set(tiles.flatMap((tile) => beatsOf(tile, plan.output.fps).map((ms) => tile.at + Math.round((ms / 1000) * FLICKS))))].sort((a, b) => a - b)
  const frame = { output: plan.output, canvas: plan.canvas }
  const items = tiles.map((tile) => ({
    id: tile.key,
    html: compositionFor(tile, frame, captionComposition),
    times: beats.filter((t) => t >= tile.at && t < tile.end).map((t) => ((t - tile.at) / FLICKS) * 1000),
  }))
  mkdirSync(work, { recursive: true })
  const dir = mkdtempSync(join(work, "m-"))
  let measured
  try {
    measured = await measure({ items: items.filter((item) => item.times.length), work: dir, runtime: motion })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const out = []
  for (const [i, tile] of tiles.entries()) {
    const sets = measured.get(tile.key) ?? []
    sets.forEach((boxes, k) => {
      const t = tile.at + Math.round((items[i].times[k] / 1000) * FLICKS)
      for (const box of boxes) out.push({ t, tile, box })
    })
  }
  return out
}

/* ─────────────────────────────── QG-08 ─────────────────────────────── */

/**
 * @param {{ plan: object, project: object, index: object, measured: Awaited<ReturnType<typeof measurePlan>> }} input
 * @returns {{ status: "passed" | "failed", numbers: object, failures: object[] }}
 */
export function judgeLayout({ plan, project, index, measured }) {
  const { width, height } = plan.output
  const sx = width / plan.canvas.width
  const sy = height / plan.canvas.height
  const zone = safeZoneFor(project)
  const safe = { top: (zone.top ?? 0) * sy, right: (zone.right ?? 0) * sx, bottom: (zone.bottom ?? 0) * sy, left: (zone.left ?? 0) * sx }
  const sizeOf = (id) => project.assets.find((asset) => asset.id === id)?.facts
  const faces = outputFaces(wholeSegment(plan).node.picture, index.faces ?? [], sizeOf, { canvas: plan.canvas, output: plan.output })
  const failures = []
  const fail = (kind, item, extra = {}) => failures.push({ kind, t: item.t, seconds: Math.round((item.t / FLICKS) * 100) / 100, tile: item.tile.key, box: rounded(item.box), ...extra })
  for (const item of measured) {
    const { box } = item
    if (box.x < -0.5 || box.y < -0.5 || box.x + box.w > width + 0.5 || box.y + box.h > height + 0.5) fail("outside_frame", item)
    else if (box.y < safe.top - 0.5 || box.x < safe.left - 0.5 || box.x + box.w > width - safe.right + 0.5 || box.y + box.h > height - safe.bottom + 0.5) fail("outside_safe_zone", item, { safe: rounded({ x: safe.left, y: safe.top, w: width - safe.left - safe.right, h: height - safe.top - safe.bottom }) })
    if (box.clipped) fail("clipped", item)
    // Behind-the-speaker text may cross the face: the matte draws the speaker over it
    const behind = item.tile.node.behind === true && !item.tile.front
    // A scene covers the frame while it's on: no face is in the picture under its text or its captions
    // Other footage laid over the whole frame hides it the same way
    const covered = plan.tiles.some((tile) => isSceneBlock(tile.node) && tile.at <= item.t && item.t < tile.end) || wholeSegment(plan).node.overlays.some((o) => o.at <= item.t && item.t < o.end)
    if (!behind && !covered) {
      const face = faces.find((f) => Math.abs(f.t - item.t) <= FLICKS * 0.6 && overlaps(box, f.box))
      if (face) fail("on_face", item, { face: face.box })
    }
  }
  const byTime = new Map()
  for (const item of measured) byTime.set(item.t, [...(byTime.get(item.t) ?? []), item])
  for (const items of byTime.values()) {
    for (let i = 0; i < items.length; i++) for (let k = i + 1; k < items.length; k++) if (items[i].tile.key !== items[k].tile.key && overlaps(items[i].box, items[k].box)) fail("overlap", items[i], { with: items[k].tile.key })
  }
  const numbers = { beats: byTime.size, boxes: measured.length, faces: faces.length, failures: failures.length, safe: zone }
  return { status: failures.length ? "failed" : "passed", numbers, failures }
}

/* ─────────────────────────────── QG-09 ─────────────────────────────── */

/** WCAG relative luminance of an sRGB colour, 0 to 255 a channel. */
export function luminance([r, g, b]) {
  const lin = (c) => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
export const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)

export function parseColour(text) {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/.exec(text ?? "")
  return m ? { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], alpha: m[4] === undefined ? 1 : Number(m[4]) } : null
}

/**
 * The contrast text keeps against the pixels behind its box: each pixel under the
 * plate (if any) blended, the worst `share` of them. @param {Buffer} rgb a whole frame
 */
export function boxContrast(rgb, width, height, box, { colours, plate }, share = 0.1) {
  const x0 = Math.max(0, Math.floor(box.x))
  const y0 = Math.max(0, Math.floor(box.y))
  const x1 = Math.min(width, Math.ceil(box.x + box.w))
  const y1 = Math.min(height, Math.ceil(box.y + box.h))
  const texts = colours.map(parseColour).filter(Boolean).map((c) => luminance(c.rgb))
  const back = parseColour(plate)
  const a = back?.alpha ?? 0
  const values = []
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * width + x) * 3
      const px = [rgb[i], rgb[i + 1], rgb[i + 2]]
      const seen = a > 0 ? px.map((c, k) => back.rgb[k] * a + c * (1 - a)) : px
      const l = luminance(seen)
      values.push(Math.min(...texts.map((t) => contrast(t, l))))
    }
  }
  values.sort((p, q) => p - q)
  return values.length ? values[Math.floor(values.length * share)] : null
}

/** The contrast of text against its own outline, when the outline is thick enough to read as one; else null. */
export function strokeContrast({ colours, stroke, strokeWidth, size }) {
  const edge = parseColour(stroke)
  if (!edge || !(strokeWidth >= Math.max(2, (size ?? 0) * 0.05))) return null
  const texts = (colours ?? []).map(parseColour).filter(Boolean).map((c) => luminance(c.rgb))
  return texts.length ? Math.min(...texts.map((t) => contrast(t, luminance(edge.rgb)))) : null
}

/** Raw RGB frames of the plan, without the tiles `without` names, at frame numbers. */
async function stills(plan, frames, { inputPath, tilePath, run, without }) {
  const { width, height } = plan.output
  const size = width * height * 3
  const chunks = []
  const args = segmentArgs(plan, wholeSegment(plan), { input: inputPath, tile: tilePath, output: "pipe:1", encoder: [], frames, without })
  await run("ffmpeg", args, { timeoutMs: 600_000, onStdout: (chunk) => chunks.push(chunk) })
  const data = Buffer.concat(chunks)
  return frames.map((_, i) => data.subarray(i * size, (i + 1) * size)).filter((frame) => frame.length === size)
}

/**
 * @param {{ plan: object, measured: object[], inputPath: (asset: string) => string, tilePath: (key: string) => string, run: Function, thresholds: object }} input
 */
export async function judgeLegibility({ plan, measured, inputPath, tilePath, run, thresholds }) {
  const { width, height } = plan.output
  const fps = plan.output.fps
  const total = Math.floor((plan.duration * fps.n) / (FLICKS * fps.d))
  const failures = []
  const fail = (kind, item, extra) => failures.push({ kind, seconds: Math.round((item.t / FLICKS) * 100) / 100, tile: item.tile.key, box: rounded(item.box), ...extra })
  // One look per tile, at rest: the first beat measured
  const first = new Map()
  for (const item of measured) if (!first.has(item.tile.key) || first.get(item.tile.key).t > item.t) first.set(item.tile.key, item)
  const items = [...first.values()]
  const frameOf = (t) => Math.min(Math.max(0, total - 1), Math.floor((t * fps.n) / (FLICKS * fps.d)))
  let worst = Infinity
  // Captions over cards: a caption's background keeps the cards; a card's keeps neither
  for (const [kind, without] of [["caption", (part) => part.kind === "caption"], ["block", () => true]]) {
    const own = items.filter((item) => item.tile.kind === kind)
    if (!own.length) continue
    const frames = [...new Set(own.map((item) => frameOf(item.t)))].sort((a, b) => a - b)
    const pictures = await stills(plan, frames, { inputPath, tilePath, run, without })
    if (pictures.length !== frames.length) throw new Error("the frames behind the text couldn't be read")
    for (const item of own) {
      const seen = boxContrast(pictures[frames.indexOf(frameOf(item.t))], width, height, item.box, item.box)
      // A real outline separates text from any picture: it counts as what's behind the text (found on real footage)
      const outline = strokeContrast(item.box)
      const value = seen === null ? null : Math.max(seen, outline ?? 0)
      if (value === null) continue
      worst = Math.min(worst, value)
      if (value < thresholds.contrast) fail("low_contrast", item, { contrast: Math.round(value * 100) / 100, needed: thresholds.contrast })
    }
  }
  for (const item of items) {
    if (item.box.size / height < thresholds.minTextShare) fail("too_small", item, { px: item.box.size, minimum: Math.ceil(thresholds.minTextShare * height) })
    if (item.tile.kind !== "caption") continue
    const seconds = (item.tile.end - item.tile.at) / FLICKS
    const words = item.tile.node.words.length
    const script = scriptOf(item.tile.node.text)
    const rate = words / Math.max(seconds, 1e-3)
    // Captions show what's said, so a fast speaker's page can't be slower than the speech. What a reader can't take is a page that flashes by
    if (rate > READING_LIMITS[script] && seconds < MIN_PAGE_SECONDS) fail("too_fast", item, { wordsPerSecond: Math.round(rate * 100) / 100, limit: READING_LIMITS[script], script })
  }
  const numbers = { texts: items.length, worstContrast: worst === Infinity ? null : Math.round(worst * 100) / 100, needed: thresholds.contrast, failures: failures.length }
  return { status: failures.length ? "failed" : "passed", numbers, failures }
}
