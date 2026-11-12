// Edit DNA 2 (TP6, CRAFT_UPGRADE §4.1, EDD-65), behind editing.referenceIntent: a reference's
// method, measured on this computer by code and kept as numbers and fixed words only. Frames
// and samples are read through a pipe, measured and dropped; nothing of the reference's picture,
// sound or wording is kept, and checkDna2 proves it before anything stores a result. No model
// sees a reference (EDD-66 stays off).
// Heavier than dna.js, so it runs only as a job with progress and a cancel, over a bounded
// number of sampled frames, never inside a plan or a make (EH-73). A trait code can't read
// well says so (`read: "no"`, or a null number): "couldn't read", never a guess.
// Thresholds are spike TPX-03's, measured on references Kriya rendered itself (SPIKES.md §8).

import { analyseMusic, musicArgs, pcmCollector, RATE as PCM_RATE } from "../index/layers/music.js"
import { statsOf } from "./color.js"
import { paceOf } from "./dna.js"
import { loudnessArgs, readLoudness } from "./loudness.js"
import { probe } from "./probe.js"
import { runTool } from "./tool.js"

const FLICKS = 705_600_000
export const DNA2_VERSION = "dna-2"
// The bound on work (EH-73): a longer reference is sampled more thinly, never read longer
export const LIMITS = { motionFrames: 7200, motionFps: 15, detailFrames: 1200, detailFps: 4, colourFrames: 48, soundSeconds: 600, motionSide: 96, detailSide: 480 }
// Below this rate a gradual join has too few samples to tell its kind
const KIND_FPS = 10
export const JOIN_KINDS = ["cut", "fade", "dip", "flash", "wipe", "slide", "zoom"]
// Under this confidence a trait is reported as not read
export const CONFIDENCE_FLOOR = 0.5

const round = (value, places = 3) => (value === null || value === undefined || !Number.isFinite(value) ? null : Math.round(value * 10 ** places) / 10 ** places)
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const median = (list) => (list.length ? [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)] : null)
const even = (n) => Math.max(2, Math.round(n / 2) * 2)

/* ───────────────────────────── frames through a pipe ───────────────────────────── */

/** Calls onFrame(bytes, n) for each sampled frame; `bytes` is only valid during the call. */
async function eachFrame(file, { fps, width, height, format, max, run, signal }, onFrame) {
  const size = width * height * (format === "gray" ? 1 : 3)
  let carry = Buffer.alloc(0)
  let n = 0
  const take = (chunk) => {
    carry = carry.length ? Buffer.concat([carry, chunk]) : chunk
    let at = 0
    for (; carry.length - at >= size && n < max; at += size) onFrame(carry.subarray(at, at + size), n++)
    carry = carry.subarray(at)
  }
  await run("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-protocol_whitelist", "file,pipe", "-i", file, "-an", "-sn", "-dn", "-vf", `fps=${fps.toFixed(4)},scale=${width}:${height}:flags=area,format=${format}`, "-frames:v", String(max), "-f", "rawvideo", "-"], { onStdout: take, signal, stallMs: 60_000 })
  return n
}

/* ───────────────────────────── small-frame measures ───────────────────────────── */

const mad = (a, b) => {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i])
  return sum / a.length
}
// The share of the picture that changed: a join changes most of it, a caption or a graphic arriving only its own patch
const changed = (a, b) => {
  let n = 0
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 12) n++
  return n / a.length
}
const meanOf = (a) => {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i]
  return sum / a.length
}

/** `a` scaled by `s` about (cx, cy) in 0…1, nearest pixel: what a punch-in or a zoom shows. */
function zoomed(a, w, h, s, cx = 0.5, cy = 0.5, out = new Uint8Array(a.length)) {
  const [px, py] = [cx * (w - 1), cy * (h - 1)]
  for (let y = 0; y < h; y++) {
    const sy = clamp(Math.round(py + (y - py) / s), 0, h - 1) * w
    for (let x = 0; x < w; x++) out[y * w + x] = a[sy + clamp(Math.round(px + (x - px) / s), 0, w - 1)]
  }
  return out
}

/**
 * Is `b` a scaled `a`? The best scale (above 1: closer; below 1: wider) and how much of the
 * change it explains (1 − residual ÷ the plain difference).
 */
export function scaleFit(a, b, w, h, scales, centres = [0.3, 0.4, 0.5, 0.6, 0.7]) {
  // Each pixel's difference counts up to a ceiling, so a caption changing over the picture at the same moment doesn't hide the move
  const mad = (x, y) => {
    let sum = 0
    for (let i = 0; i < x.length; i++) sum += Math.min(SCALE_CEILING, Math.abs(x[i] - y[i]))
    return sum / x.length
  }
  const plain = mad(a, b)
  if (plain < 0.3) return { scale: 1, gain: 0, plain }
  const scratch = new Uint8Array(a.length)
  let best = { scale: 1, gain: 0, plain }
  for (const s of scales) {
    for (const cx of centres) {
      for (const cy of centres) {
        // Closer: b is a zoomed; wider: a is b zoomed
        const closer = 1 - mad(zoomed(a, w, h, s, cx, cy, scratch), b) / plain
        if (closer > best.gain) best = { scale: s, gain: closer, plain }
        const wider = 1 - mad(zoomed(b, w, h, s, cx, cy, scratch), a) / plain
        if (wider > best.gain) best = { scale: 1 / s, gain: wider, plain }
      }
    }
  }
  return best
}
const PUNCH_SCALES = [1.08, 1.12, 1.16, 1.2, 1.25, 1.3, 1.35, 1.4, 1.5, 1.6]
const EASE_SCALES = [1.02, 1.04, 1.06, 1.09, 1.12, 1.16, 1.2]
// A scale must explain this much of the change to be called a zoom (TPX-03)
const SCALE_GAIN = 0.55
const SCALE_CEILING = 24

/** The least-squares mix of `a` toward `b` that gives `m`, and what it leaves unexplained (a mean absolute difference). */
function blendFit(a, b, m) {
  let [num, den] = [0, 0]
  for (let i = 0; i < a.length; i++) {
    const d = b[i] - a[i]
    num += (m[i] - a[i]) * d
    den += d * d
  }
  const alpha = den ? clamp(num / den, 0, 1) : 0
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(m[i] - (a[i] + alpha * (b[i] - a[i])))
  return { alpha, residual: sum / a.length }
}

/** The best straight moving edge: `m` is `a` on one side and `b` on the other. Every split in O(pixels). */
function wipeFit(a, b, m, w, h) {
  let best = Infinity
  for (const across of [true, false]) {
    const n = across ? w : h
    const errA = new Float64Array(n)
    const errB = new Float64Array(n)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        errA[across ? x : y] += Math.abs(m[i] - a[i])
        errB[across ? x : y] += Math.abs(m[i] - b[i])
      }
    const [allA, allB] = [errA.reduce((s, v) => s + v, 0), errB.reduce((s, v) => s + v, 0)]
    let [headA, headB] = [0, 0]
    for (let k = 1; k < n; k++) {
      headA += errA[k - 1]
      headB += errB[k - 1]
      // a first then b, or b first then a
      best = Math.min(best, headA + (allB - headB), headB + (allA - headA))
    }
  }
  return best / a.length
}

/** The best push: `a` slides out as `b` slides in, in any of four directions. */
function slideFit(a, b, m, w, h) {
  let best = Infinity
  for (const across of [true, false]) {
    const n = across ? w : h
    for (let k = 2; k < n - 1; k += 2) {
      // k: how far the incoming picture has come. forward: a leaves toward 0, b enters from the far edge
      let [forward, backward] = [0, 0]
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const p = across ? x : y
          const at = (q) => (across ? y * w + q : q * w + x)
          const i = y * w + x
          forward += Math.abs(m[i] - (p < n - k ? a[at(p + k)] : b[at(p - (n - k))]))
          backward += Math.abs(m[i] - (p < k ? b[at(p + (n - k))] : a[at(p - k)]))
        }
      best = Math.min(best, forward, backward)
    }
  }
  return best / a.length
}

/** A zoom into `a` mixing to `b`: what FFmpeg's and most editors' zoom joins draw. */
function zoomFit(a, b, m, w, h) {
  let best = Infinity
  const scratch = new Uint8Array(a.length)
  for (const s of [1.2, 1.5, 2, 3, 5]) best = Math.min(best, blendFit(zoomed(a, w, h, s, 0.5, 0.5, scratch), b, m).residual)
  return best
}

/**
 * The kind of a gradual join, from the frames inside it: each is fitted as a mix (dissolve), a
 * straight moving edge (wipe), a push (slide) and a zoom into the outgoing picture; through black
 * and through white are read from brightness alone. The models' mean misses are returned too.
 * @param {Uint8Array} a the last frame before it
 * @param {Uint8Array} b the first frame after it
 * @param {Uint8Array[]} mids the frames inside it
 * @returns {{ kind: string, miss: Record<string, number> }} kind "unread" when no model fits
 */
export function joinKind(a, b, mids, w, h) {
  const apart = mad(a, b)
  const [meanA, meanB] = [meanOf(a), meanOf(b)]
  const means = mids.map(meanOf)
  // Darker than both ends: through black. A dissolve never is. Brighter than both: through white
  if (Math.min(...means) < 0.5 * Math.min(meanA, meanB)) return { kind: "dip", miss: {} }
  const top = Math.max(meanA, meanB)
  // Most of the way to white: a zoom into a bright middle (out of bars and dark corners) brightens too, but not this far
  if (Math.max(...means) > top + FLASH * (255 - top)) return { kind: "flash", miss: {} }
  // Only frames that are really between the two pictures say anything
  const telling = mids.filter((m) => Math.min(mad(m, a), mad(m, b)) > 0.12 * apart)
  if (!telling.length || apart < 1) return { kind: "unread", miss: {} }
  const miss = { fade: 0, wipe: 0, slide: 0, zoom: 0 }
  for (const m of telling) {
    miss.fade += blendFit(a, b, m).residual / apart / telling.length
    miss.wipe += wipeFit(a, b, m, w, h) / apart / telling.length
    miss.slide += slideFit(a, b, m, w, h) / apart / telling.length
    miss.zoom += zoomFit(a, b, m, w, h) / apart / telling.length
  }
  for (const key of Object.keys(miss)) miss[key] = round(miss[key])
  // A zoom is a dissolve with one more freedom, so it must fit clearly better to be named
  const ranked = Object.entries({ ...miss, zoom: miss.zoom / JOIN_FIT.zoomEdge }).sort((x, y) => x[1] - y[1])
  const [kind, least] = ranked[0]
  return { kind: least <= JOIN_FIT.miss ? kind : "unread", miss }
}
// A model must leave no more than this share of the join unexplained; a zoom must beat a dissolve by this factor (TPX-03)
const FLASH = 0.6
export const JOIN_FIT = { miss: 0.3, zoomEdge: 0.7 }

/* ───────────────────────────── pass A: motion ───────────────────────────── */

// A frame differs from the one before by more than this (grey levels, mean) when the picture is changing
const ACTIVE = 1.2
// A one-frame change at least this large is a cut
const CUT = 6
// and a join changes at least this share of the picture (a caption page changing is a few percent of it)
const JOIN_SHARE = 0.25

/**
 * Picture changes from small grey frames: hard cuts, gradual joins by kind, punch-ins, eased
 * zooms, and how much the frame shakes. Keeps a ring of the last second and a half of frames.
 * @returns {{ add: (frame: Uint8Array) => void, finish: () => object }}
 */
export function motionReader(w, h, fps) {
  const keep = Math.ceil(fps * 1.5) + 3
  const ring = [] // { n, frame }
  const frameAt = (n) => ring.find((r) => r.n === n)?.frame ?? null
  const joins = [] // { t, end, kind }
  const zooms = [] // { t, scale, ease }
  const misses = []
  let n = 0
  let run = null // { from, last, peak }
  let moving = false
  let quietFor = 0
  let [motionSum, motionN] = [0, 0]
  let opening = 0
  let [shake, shakeN] = [0, 0]
  let lastShift = null
  let eased = null // { t, scale, n }
  let lastJoin = -1 // the last frame of the last join or zoom: the half-second look back never reaches across one
  const recent = [] // the last few differences, to spot a cut inside movement
  const t = (frame) => frame / fps

  // How far the picture moved as a whole, from its column and row sums
  const profile = (frame) => {
    const cols = new Float64Array(w)
    const rows = new Float64Array(h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) (cols[x] += frame[y * w + x], rows[y] += frame[y * w + x])
    return { cols, rows }
  }
  const shiftOf = (p, q, len) => {
    let [best, at] = [Infinity, 0]
    for (let s = -4; s <= 4; s++) {
      let sum = 0
      for (let i = 4; i < len - 4; i++) sum += Math.abs(p[i] - q[i + s])
      if (sum < best) [best, at] = [sum, s]
    }
    return at
  }
  let lastProfile = null

  function close(endFrame) {
    const { from, last, peak, peakAt, sum } = run
    run = null
    const length = last - from + 1
    // One frame carries the change (anything else moving with it is small): a cut or a punch-in, at that frame
    if (length <= 2 || peak >= 0.7 * sum) {
      const [a, b] = [frameAt(peakAt - 1), frameAt(peakAt)]
      if (!a || !b || peak < ACTIVE) return
      const fit = scaleFit(a, b, w, h, PUNCH_SCALES)
      if (fit.gain >= SCALE_GAIN) return void (zooms.push({ t: t(peakAt), scale: fit.scale, ease: "snap" }), (lastJoin = last))
      if (peak >= CUT && changed(a, b) >= JOIN_SHARE) (joins.push({ t: t(peakAt), end: t(peakAt), kind: "cut" }), (lastJoin = last))
      return
    }
    const a = frameAt(from - 1)
    const b = frameAt(last)
    if (!a || !b) return
    const apart = mad(a, b)
    // In and straight back out inside one stretch (a punch-in on a single word): the middle is the picture, closer
    const middle = frameAt(Math.round((from + last) / 2))
    const through = middle && changed(a, b) < JOIN_SHARE ? scaleFit(a, middle, w, h, PUNCH_SCALES) : null
    if (through?.gain >= SCALE_GAIN && through.scale > 1) return void (zooms.push({ t: t(from), scale: through.scale, ease: "snap" }), (lastJoin = last))
    // The picture came back to itself, only scaled: a move inside a shot, not a join
    const fit = scaleFit(a, b, w, h, PUNCH_SCALES)
    if (fit.gain >= SCALE_GAIN) return void (zooms.push({ t: t(from), scale: fit.scale, ease: "eased" }), (lastJoin = last))
    // Back to a picture like the one before, but most of the frame changed on the way: a join between two alike shots
    if ((apart < CUT || changed(a, b) < JOIN_SHARE) && !(middle && changed(a, middle) >= JOIN_SHARE)) return
    const mids = []
    for (let i = from; i < last; i++) frameAt(i) && mids.push(frameAt(i))
    const found = fps >= KIND_FPS && mids.length ? joinKind(a, b, mids, w, h) : { kind: "unread", miss: {} }
    misses.push(found.miss)
    joins.push({ t: t(from), end: t(endFrame), kind: found.kind })
    lastJoin = last
  }

  return {
    add(bytes) {
      const frame = Uint8Array.from(bytes)
      const prev = ring.at(-1)?.frame
      ring.push({ n, frame })
      if (ring.length > keep) ring.shift()
      if (prev) {
        const d = mad(frame, prev)
        const active = d > ACTIVE
        if (t(n) <= 3) opening += d
        if (moving) {
          // Inside long movement, a cut is a change far above the movement around it
          const around = recent.length ? recent.reduce((s, v) => s + v, 0) / recent.length : 0
          if (d >= CUT && d > 3 * around && changed(prev, frame) >= JOIN_SHARE) (joins.push({ t: t(n), end: t(n), kind: "cut" }), (lastJoin = n))
          quietFor = active ? 0 : quietFor + 1
          if (quietFor >= 2) moving = false
        } else if (active) {
          run ??= { from: n, last: n, peak: 0, peakAt: n, sum: 0 }
          run.last = n
          run.sum += d
          if (d > run.peak) [run.peak, run.peakAt] = [d, n]
          quietFor = 0
          // Longer than any join: movement, read for cuts by their size instead
          if (run.last - run.from + 1 > fps * 1.2) {
            run = null
            moving = true
          }
        } else if (run && ++quietFor >= 2) {
          // Held on black or white in the middle of a dip or a flash: the join isn't over
          const before = frameAt(run.from - 1)
          const [was, now] = [before ? meanOf(before) : 0, meanOf(frame)]
          const held = before && ((now < 0.5 * was && now < 28) || now > Math.max(228, was + 20))
          if (!held || n - run.from > fps * 1.2) close(n)
        }
        if (!active && !run) {
          motionSum += d
          motionN++
        }
        recent.push(d)
        if (recent.length > 4) recent.shift()
        // Shake: the whole picture's jitter between quiet frames, as a share of its width
        const now = profile(frame)
        if (lastProfile && d < CUT) {
          const shift = [shiftOf(lastProfile.cols, now.cols, w), shiftOf(lastProfile.rows, now.rows, h)]
          if (lastShift) (shake += Math.hypot(shift[0] - lastShift[0], shift[1] - lastShift[1]) / w, shakeN++)
          lastShift = shift
        } else lastShift = null
        lastProfile = now
        // An eased zoom: the picture half a second ago, scaled, is the picture now
        const back = Math.max(2, Math.round(fps / 2))
        if (n % back === 0 && n - back > lastJoin && !run) {
          const old = frameAt(n - back)
          const fit = old ? scaleFit(old, frame, w, h, EASE_SCALES, [0.4, 0.5, 0.6]) : { gain: 0, plain: 0 }
          if (fit.gain >= SCALE_GAIN && fit.plain >= ACTIVE * 0.6) {
            if (eased && eased.n === n - back) (eased.scale *= fit.scale, (eased.n = n))
            else {
              if (eased) zooms.push({ t: eased.t, scale: eased.scale, ease: "eased" })
              eased = { t: t(n - back), scale: fit.scale, n }
            }
          }
        }
      }
      n++
    },
    finish() {
      if (run) close(n - 1)
      if (eased) zooms.push({ t: eased.t, scale: eased.scale, ease: "eased" })
      return { frames: n, joins: joins.sort((x, y) => x.t - y.t), zooms: zooms.sort((x, y) => x.t - y.t), misses, opening: n ? opening / Math.min(n, Math.ceil(3 * fps)) : null, still: motionN ? motionSum / motionN : null, shake: shakeN ? shake / shakeN : null }
    },
  }
}

/* ───────────────────────────── pass B: detail ───────────────────────────── */

const LINEAR = Float64Array.from({ length: 256 }, (_, v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4))
const CELL = 8
// Behind the letters is a plate when it is darker than this share of the picture around
const PLATE = 0.62
// A stroke edge: a step this large across two pixels
const EDGE = 44

/**
 * Text regions of one RGB frame, as boxes in pixels: cells where sharp vertical strokes of both
 * polarities crowd together, joined across a word gap. Only where text is, never what it says.
 * @returns {{ x0: number, y0: number, x1: number, y1: number, lines: number, plate: string | null, contrast: number | null, marked: boolean }[]}
 */
export function textRegions(rgb, w, h) {
  const luma = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) luma[i] = (rgb[i * 3] * 54 + rgb[i * 3 + 1] * 183 + rgb[i * 3 + 2] * 19) >> 8
  const [cw, ch] = [Math.floor(w / CELL), Math.floor(h / CELL)]
  const rise = new Uint16Array(cw * ch)
  const fall = new Uint16Array(cw * ch)
  const edge = new Uint8Array(w * h)
  for (let y = 0; y < ch * CELL; y++)
    for (let x = 1; x < cw * CELL - 1; x++) {
      const step = luma[y * w + x + 1] - luma[y * w + x - 1]
      if (Math.abs(step) < EDGE) continue
      edge[y * w + x] = 1
      const cell = Math.floor(y / CELL) * cw + Math.floor(x / CELL)
      step > 0 ? rise[cell]++ : fall[cell]++
    }
  // Text: both polarities in a cell (a letter's two sides); a box's one edge has only one
  const texty = new Uint8Array(cw * ch)
  for (let i = 0; i < cw * ch; i++) texty[i] = rise[i] >= 3 && fall[i] >= 3 ? 1 : 0
  // Join across one empty cell sideways (a space between words)
  const joined = Uint8Array.from(texty)
  for (let y = 0; y < ch; y++) for (let x = 1; x < cw - 1; x++) if (!texty[y * cw + x] && texty[y * cw + x - 1] && texty[y * cw + x + 1]) joined[y * cw + x] = 1
  const seen = new Uint8Array(cw * ch)
  const regions = []
  for (let start = 0; start < cw * ch; start++) {
    if (!joined[start] || seen[start]) continue
    const stack = [start]
    seen[start] = 1
    let [cx0, cy0, cx1, cy1, cells] = [cw, ch, 0, 0, 0]
    while (stack.length) {
      const i = stack.pop()
      const [x, y] = [i % cw, Math.floor(i / cw)]
      cells += texty[i]
      cx0 = Math.min(cx0, x)
      cx1 = Math.max(cx1, x)
      cy0 = Math.min(cy0, y)
      cy1 = Math.max(cy1, y)
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const [nx, ny] = [x + dx, y + dy]
        if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue
        const j = ny * cw + nx
        if (joined[j] && !seen[j]) (seen[j] = 1), stack.push(j)
      }
    }
    // At least three cells of strokes side by side: a word, not a speck
    if (cx1 - cx0 + 1 < 3 || cells < 3) continue
    // Tight edges in pixels, from the strokes themselves
    let [x0, y0, x1, y1] = [w, h, 0, 0]
    const rowHits = new Uint16Array((cy1 - cy0 + 1) * CELL)
    const colHits = new Uint16Array((cx1 - cx0 + 1) * CELL)
    for (let y = cy0 * CELL; y < (cy1 + 1) * CELL; y++)
      for (let x = cx0 * CELL; x < (cx1 + 1) * CELL; x++)
        if (edge[y * w + x]) {
          rowHits[y - cy0 * CELL]++
          colHits[x - cx0 * CELL]++
          x0 = Math.min(x0, x)
          x1 = Math.max(x1, x)
          y0 = Math.min(y0, y)
          y1 = Math.max(y1, y)
        }
    // Lines: runs of rows with strokes
    let [lines, empty, inside] = [0, 2, false]
    for (const v of rowHits) {
      if (v >= 1) {
        if (!inside && empty >= 2) lines++
        inside = true
        empty = 0
      } else if (++empty >= 2) inside = false
    }
    lines = Math.max(1, lines)
    const lineHeight = (y1 - y0 + 1) / lines
    // What is behind the letters: a plate of its own, a dark outline, or the picture
    let [textN, insideN, insideSum, neutral, coloured, textLight, behindLight] = [0, 0, 0, 0, 0, 0, 0]
    // Relative luminance, as WCAG's contrast counts it
    const light = (i) => 0.2126 * LINEAR[rgb[i * 3]] + 0.7152 * LINEAR[rgb[i * 3 + 1]] + 0.0722 * LINEAR[rgb[i * 3 + 2]]
    const pad = Math.round(lineHeight * 0.2)
    const [bx0, by0, bx1, by1] = [Math.max(0, x0 - pad), Math.max(0, y0 - pad), Math.min(w - 1, x1 + pad), Math.min(h - 1, y1 + pad)]
    for (let y = by0; y <= by1; y++)
      for (let x = bx0; x <= bx1; x++) {
        const i = y * w + x
        if (luma[i] > 170) {
          textN++
          const [r, g, b] = [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]]
          Math.max(r, g, b) - Math.min(r, g, b) > 70 ? coloured++ : neutral++
          textLight += light(i)
        } else {
          insideN++
          insideSum += luma[i]
          behindLight += light(i)
        }
      }
    // The picture well clear of the text, to compare with what sits right behind the letters
    let [ringN, ringSum] = [0, 0]
    const out = Math.round(lineHeight * 1.5) + CELL
    for (let y = Math.max(0, y0 - out); y <= Math.min(h - 1, y1 + out); y++)
      for (let x = Math.max(0, x0 - out); x <= Math.min(w - 1, x1 + out); x++) {
        if (x >= x0 - out + CELL && x <= x1 + out - CELL && y >= y0 - out + CELL && y <= y1 + out - CELL) continue
        ringN++
        ringSum += luma[y * w + x]
      }
    const insideMean = insideN ? insideSum / insideN : 0
    const ringMean = ringN ? ringSum / ringN : null
    // A dark plate behind light letters; an outline can't be told from none at this size, and on a dark
    // picture a plate and no plate look the same, so that isn't read (TPX-03)
    const plate = !textN || ringMean === null || ringMean < 60 ? null : insideMean < PLATE * ringMean ? "box" : "none"
    // The letters against what is right behind them (small frames soften both, so this reads a little low)
    const contrast = textN && insideN ? (textLight / textN + 0.05) / (behindLight / insideN + 0.05) : null
    regions.push({ x0, y0, x1: x1 + 1, y1: y1 + 1, lines, plate, contrast, marked: textN > 0 && coloured / textN > 0.15 && neutral / textN > 0.15 })
  }
  return regions
}

/**
 * Captions, graphics, colour, grain, corner falloff and bars from sampled RGB frames.
 * @returns {{ add: (rgb: Uint8Array) => void, finish: () => object }}
 */
export function detailReader(w, h, fps, { colourEvery = 1 } = {}) {
  const perFrame = [] // regions as shares of the frame: numbers only
  const thirds = [[], [], []]
  let n = 0
  let [grain, grainN] = [0, 0]
  let [falloff, falloffN] = [0, 0]
  const darkRows = new Uint32Array(h)
  let rowFrames = 0
  let total = null

  return {
    /** @param {number} of how many frames there will be, for the thirds */
    expect: (of) => (total = of),
    add(rgb) {
      perFrame.push(textRegions(rgb, w, h).map((r) => ({ x0: r.x0 / w, y0: r.y0 / h, x1: r.x1 / w, y1: r.y1 / h, lines: r.lines, plate: r.plate, contrast: r.contrast, marked: r.marked })))
      // Bars: rows that are black in this frame
      let lit = 0
      const rowMean = new Float64Array(h)
      for (let y = 0; y < h; y++) {
        let sum = 0
        for (let x = 0; x < w; x++) sum += rgb[(y * w + x) * 3 + 1]
        rowMean[y] = sum / w
        if (rowMean[y] < 14) darkRows[y]++
        else lit++
      }
      // A frame that is black all over (a dip) says nothing about bars
      if (lit > h * 0.2) rowFrames++
      else for (let y = 0; y < h; y++) if (rowMean[y] < 14) darkRows[y]--
      if (n % colourEvery === 0) {
        const third = thirds[Math.min(2, Math.floor((n * 3) / Math.max(1, total ?? n + 1)))]
        // Every sixteenth pixel is plenty for a mean and a covariance
        for (let i = 0; i < w * h; i += 16) third.push(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2])
        // Grain: how far a pixel sits from its four neighbours, where the picture is flat
        let [sum, count] = [0, 0]
        for (let y = 2; y < h - 2; y += 3)
          for (let x = 2; x < w - 2; x += 3) {
            const g = (xx, yy) => rgb[(yy * w + xx) * 3 + 1]
            const around = (g(x - 1, y) + g(x + 1, y) + g(x, y - 1) + g(x, y + 1)) / 4
            // Flat: the wider neighbours agree with each other
            if (Math.abs(g(x - 2, y) - g(x + 2, y)) > 10 || Math.abs(g(x, y - 2) - g(x, y + 2)) > 10 || around < 20) continue
            sum += Math.abs(g(x, y) - around)
            count++
          }
        if (count > 50) (grain += sum / count, grainN++)
        // Corner falloff: the corners against the middle, inside any bars
        const rows = []
        for (let y = 0; y < h; y++) if (rowMean[y] >= 14) rows.push(y)
        if (rows.length > h * 0.3) {
          const [top, bottom] = [rows[0], rows.at(-1)]
          const span = bottom - top + 1
          const patch = (fx, fy) => {
            let [s, c] = [0, 0]
            for (let y = top + Math.floor(fy * span); y < top + Math.floor((fy + 0.12) * span); y++) for (let x = Math.floor(fx * w); x < Math.floor((fx + 0.12) * w); x++) (s += rgb[(y * w + x) * 3 + 1], c++)
            return c ? s / c : 0
          }
          const corners = (patch(0, 0) + patch(0.88, 0) + patch(0, 0.88) + patch(0.88, 0.88)) / 4
          // The middle of each side, so a left-to-right ramp in the picture cancels out
          const sides = (patch(0.44, 0) + patch(0.44, 0.88) + patch(0, 0.44) + patch(0.88, 0.44)) / 4
          const middle = patch(0.44, 0.44)
          if (middle > 30) (falloff += clamp(1 - (corners + sides) / 2 / middle, -1, 1), falloffN++)
        }
      }
      n++
    },
    finish() {
      const minutes = Math.max(n / fps / 60, 1 / 60)
      /* captions: the band where text recurs */
      const all = perFrame.flat()
      const bins = new Array(20).fill(0)
      for (const frame of perFrame) for (const bin of new Set(frame.map((r) => Math.min(19, Math.floor(((r.y0 + r.y1) / 2) * 20))))) bins[bin]++
      const peak = bins.indexOf(Math.max(...bins))
      const present = n > 0 && bins[peak] + (bins[peak - 1] ?? 0) + (bins[peak + 1] ?? 0) >= Math.max(3, n * 0.2)
      const inBand = (r) => present && Math.abs(Math.min(19, Math.floor(((r.y0 + r.y1) / 2) * 20)) - peak) <= 1
      // A caption changes its words; a strap in the same band doesn't. A page: text in the band until it
      // goes, or until its place or width jumps (the next page arriving with no gap)
      let pages = 0
      let last = null
      const captionFrames = []
      for (const frame of perFrame) {
        const here = frame.filter(inBand)
        if (!here.length) {
          last = null
          continue
        }
        captionFrames.push(here)
        const now = { x0: Math.min(...here.map((r) => r.x0)), x1: Math.max(...here.map((r) => r.x1)) }
        if (!last || Math.abs(now.x0 - last.x0) > 0.06 || Math.abs(now.x1 - last.x1) > 0.06) pages++
        last = now
      }
      const cap = captionFrames.flat()
      const plates = cap.map((r) => r.plate).filter(Boolean)
      const mostly = (list) => {
        const counts = {}
        for (const v of list) counts[v] = (counts[v] ?? 0) + 1
        const [word, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] ?? [null, 0]
        return list.length && count / list.length >= 0.6 ? word : null
      }
      const captions = present && pages >= 2
      /* graphics: text outside the caption band (or a band whose words never change), followed from frame to frame */
      const overlap = (p, q) => {
        const [ix, iy] = [Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0), Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0)]
        return ix > 0 && iy > 0 ? (ix * iy) / Math.min((p.x1 - p.x0) * (p.y1 - p.y0), (q.x1 - q.x0) * (q.y1 - q.y0)) : 0
      }
      const shown = [] // { box, frames }
      let open = []
      let full = 0
      for (const frame of perFrame) {
        // Lines of one graphic (a name over a title) are one thing: boxes that share a column and nearly touch
        const here = []
        for (const r of frame.filter((r) => !captions || !inBand(r)).sort((p, q) => p.y0 - q.y0)) {
          const above = here.find((o) => r.y0 - o.y1 < 0.05 && Math.min(o.x1, r.x1) > Math.max(o.x0, r.x0))
          if (above) Object.assign(above, { x0: Math.min(above.x0, r.x0), x1: Math.max(above.x1, r.x1), y1: Math.max(above.y1, r.y1) })
          else here.push({ ...r })
        }
        const next = []
        for (const r of here) {
          const going = open.find((o) => overlap(o.box, r) > 0.3)
          if (going) (going.frames++, next.push(going))
          else {
            const fresh = { box: r, frames: 1 }
            shown.push(fresh)
            next.push(fresh)
          }
        }
        open = next
        if (here.reduce((sum, r) => sum + (r.x1 - r.x0) * (r.y1 - r.y0), 0) > 0.25) full++
      }
      // One sample could be a join passing through: a graphic holds for two or more
      const graphics = shown.filter((g) => g.frames >= 2)
      const merged = new Uint8Array([...thirds[0], ...thirds[1], ...thirds[2]])
      const colour = merged.length ? statsOf(merged) : null
      const parts = thirds.filter((t) => t.length >= 300).map((t) => statsOf(new Uint8Array(t)).mean)
      const drift = colour && parts.length === 3 ? Math.max(...parts.map((m) => Math.hypot(m[0] - colour.mean[0], m[1] - colour.mean[1], m[2] - colour.mean[2]))) : null
      // Bars: rows black in nearly every frame, counted in from the top and the bottom
      const barred = (y) => rowFrames > 0 && darkRows[y] >= rowFrames * 0.95
      let [top, bottom] = [0, 0]
      while (top < h && barred(top)) top++
      while (bottom < h - top && barred(h - 1 - bottom)) bottom++
      return {
        frames: n,
        captions: { present: captions, top: captions ? median(cap.map((r) => r.y0)) : null, bottom: captions ? median(cap.map((r) => r.y1)) : null, height: captions ? median(cap.map((r) => (r.y1 - r.y0) / r.lines)) : null, lines: captions ? median(cap.map((r) => r.lines)) : null, pagesPerMinute: captions ? pages / minutes : null, plate: captions ? mostly(plates) : null, contrast: captions ? median(cap.map((r) => r.contrast).filter((v) => v !== null)) : null, marked: captions ? cap.filter((r) => r.marked).length / cap.length >= 0.3 : null, share: n ? captionFrames.length / n : 0 },
        graphics: { perMinute: graphics.length / minutes, seconds: graphics.length ? graphics.reduce((s, g) => s + g.frames, 0) / graphics.length / fps : null, full: n ? full / n : null, lower: graphics.some((g) => (g.box.x0 + g.box.x1) / 2 < 0.5 && (g.box.y0 + g.box.y1) / 2 > 0.55), count: graphics.length },
        text: { top: all.length ? Math.min(...all.map((r) => r.y0)) : null, bottom: all.length ? 1 - Math.max(...all.map((r) => r.y1)) : null, early: perFrame.slice(0, Math.max(1, Math.round(2 * fps))).some((f) => f.length > 0), earlyGraphic: perFrame.slice(0, Math.max(1, Math.round(2 * fps))).some((f) => f.some((r) => !captions || !inBand(r))) },
        colour,
        drift,
        grain: grainN ? grain / grainN : null,
        vignette: falloffN ? falloff / falloffN : null,
        letterbox: rowFrames ? (top + bottom) / h : null,
      }
    },
  }
}

/* ───────────────────────────── pass C: sound ───────────────────────────── */

/** Silence, energy across the running time and a steady pulse, from mono samples. */
export function soundOf(samples, rate = PCM_RATE) {
  const step = Math.round(rate / 10)
  const windows = Math.floor(samples.length / step)
  if (windows < 10) return null
  const db = new Float64Array(windows)
  for (let i = 0; i < windows; i++) {
    let sum = 0
    for (let k = i * step; k < (i + 1) * step; k++) sum += samples[k] * samples[k]
    db[i] = 10 * Math.log10(1e-10 + sum / step)
  }
  let quiet = 0
  for (const v of db) if (v < -50) quiet++
  const energy = Array.from({ length: 10 }, (_, tenth) => {
    const [from, to] = [Math.floor((tenth * windows) / 10), Math.floor(((tenth + 1) * windows) / 10)]
    let sum = 0
    for (let i = from; i < to; i++) sum += db[i]
    return round(clamp((sum / Math.max(1, to - from) + 60) / 60, 0, 1))
  })
  // What is left in the gaps, against the loud parts: near 0 when something plays throughout (a bed), far below when the gaps are empty
  const sorted = [...db].sort((x, y) => x - y)
  const bed = sorted[Math.floor(windows * 0.1)] - sorted[Math.floor(windows * 0.9)]
  return { silence: quiet / windows, energy, bed }
}

/**
 * How steady a pulse is: the share of tracked beats that have a hit on them. A bed with drums
 * scores near 1; speech, room sound and pads without drums score low (TPX-03: 0.88 or more
 * against 0.36 or less). Beats in seconds.
 */
export function pulseOf(samples, beats, rate = PCM_RATE) {
  if (beats.length < 8) return 0
  const hop = Math.round(rate * 0.02)
  const frames = Math.floor(samples.length / hop)
  const energy = new Float64Array(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    for (let i = f * hop; i < (f + 1) * hop; i++) sum += samples[i] * samples[i]
    energy[f] = Math.log10(1e-10 + sum / hop)
  }
  const rises = []
  for (let f = 3; f < frames; f++) {
    const at = (f * hop) / rate
    if (energy[f] - Math.min(energy[f - 1], energy[f - 2], energy[f - 3]) > 0.4 && energy[f] > -4.5 && !(rises.length && at - rises.at(-1) < 0.08)) rises.push(at)
  }
  let on = 0
  for (const beat of beats) if (rises.some((r) => Math.abs(r - beat) <= 0.06)) on++
  return on / beats.length
}
// A pulse this steady is music with a beat
export const PULSE = 0.7

/* ───────────────────────────── the measure ───────────────────────────── */

const READ = { enum: ["yes", "no"] }
const NUM = "num"
// The shape an Edit DNA 2 may have: numbers, true or false, and these fixed words. Nothing else
// (EDD-23, EDD-65): no free text, no path, no word from the reference, no pixel
export const DNA2_SHAPE = {
  kind: "edit-dna",
  version: DNA2_VERSION,
  seconds: NUM,
  sampled: { motionFps: NUM, motionFrames: NUM, detailFps: NUM, detailFrames: NUM },
  rhythm: { read: READ, confidence: NUM, shots: NUM, cutsPerMinute: NUM, median: NUM, p10: NUM, p90: NUM, curve: [NUM, 10], onBeats: NUM },
  opening: { read: READ, confidence: NUM, firstCut: NUM, motion: NUM, textEarly: "bool", style: { enum: ["cold_open", "title_first", "straight_in"] } },
  transitions: { read: READ, confidence: NUM, perMinute: { cut: NUM, fade: NUM, dip: NUM, flash: NUM, wipe: NUM, slide: NUM, zoom: NUM }, unread: NUM, seconds: NUM },
  moves: { read: READ, confidence: NUM, zoomsPerMinute: NUM, scale: NUM, ease: { enum: ["snap", "eased"] }, shake: NUM },
  captions: { read: READ, confidence: NUM, present: "bool", top: NUM, bottom: NUM, height: NUM, lines: NUM, pagesPerMinute: NUM, plate: { enum: ["box", "none"] }, contrast: NUM, highlight: "bool" },
  graphics: { read: READ, confidence: NUM, perMinute: NUM, seconds: NUM, fullFrame: NUM, lowerBand: "bool" },
  colour: { read: READ, confidence: NUM, mean: [NUM, 3], cov: [[NUM, 3], 3], luma: [NUM, 16], contrast: NUM, saturation: NUM, drift: NUM, grain: NUM, vignette: NUM, letterbox: NUM },
  sound: { read: READ, confidence: NUM, lufs: NUM, range: NUM, truePeak: NUM, bed: NUM, bpm: NUM, silence: NUM },
  structure: { read: READ, confidence: NUM, energy: [NUM, 10] },
  format: { read: READ, confidence: NUM, aspect: NUM, shape: { enum: ["vertical", "portrait", "square", "landscape"] }, fps: NUM, clearTop: NUM, clearBottom: NUM },
}

function conforms(value, shape, path) {
  if (typeof shape === "string" && shape !== NUM && shape !== "bool") {
    if (value !== shape) throw new RangeError(`${path} must be "${shape}"`)
    return
  }
  if (value === null) return
  if (shape === NUM) {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new RangeError(`${path} must be a number`)
  } else if (shape === "bool") {
    if (typeof value !== "boolean") throw new RangeError(`${path} must be true or false`)
  } else if (Array.isArray(shape)) {
    if (!Array.isArray(value) || value.length !== shape[1]) throw new RangeError(`${path} must be a list of ${shape[1]}`)
    value.forEach((item, i) => conforms(item, shape[0], `${path}[${i}]`))
  } else if (Array.isArray(shape.enum)) {
    if (typeof value !== "string" || !shape.enum.includes(value)) throw new RangeError(`${path} must be one of ${shape.enum.join(", ")}`)
  } else {
    if (typeof value !== "object" || Array.isArray(value)) throw new RangeError(`${path} must be an object`)
    const extra = Object.keys(value).find((key) => !Object.hasOwn(shape, key))
    if (extra) throw new RangeError(`${path}.${extra} isn't part of an Edit DNA 2`)
    for (const key of Object.keys(shape)) conforms(value[key], shape[key], `${path}.${key}`)
  }
}

/** Throws unless `dna` is numbers, booleans and the fixed words, in the Edit DNA 2 shape; returns it. */
export function checkDna2(dna) {
  if (dna === null || typeof dna !== "object" || Array.isArray(dna)) throw new RangeError("dna must be an object")
  conforms(dna, DNA2_SHAPE, "dna")
  return dna
}

/**
 * A kept analysis, read back: an Edit DNA 2 of this version, or null. Anything else (an Edit DNA 1,
 * an older or newer shape, a damaged file, a field that isn't a number or a fixed word) is never
 * read as this shape: it counts as not measured, and is measured again (EH-73).
 */
export function readDna2(text) {
  try {
    const dna = JSON.parse(text)
    return dna?.kind === "edit-dna" && dna.version === DNA2_VERSION ? checkDna2(dna) : null
  } catch {
    return null
  }
}

// A trait that wasn't read: every number null, so nothing can be taken from it
const unread = (shape) => Object.fromEntries(Object.keys(shape).map((key) => [key, key === "read" ? "no" : key === "confidence" ? 0 : Array.isArray(shape[key]) && !Array.isArray(shape[key][0]) ? new Array(shape[key][1]).fill(null) : typeof shape[key] === "object" && !Array.isArray(shape[key]) && !shape[key].enum ? Object.fromEntries(Object.keys(shape[key]).map((k) => [k, null])) : null]))
const trait = (name, confidence, values) => (confidence >= CONFIDENCE_FLOOR ? { read: "yes", confidence: round(confidence, 2), ...values } : unread(DNA2_SHAPE[name]))

/** The sampling plan for a video this long and this shape: bounded, whatever its length. */
export function samplingFor(seconds, width, height) {
  const side = (long) => (width >= height ? [long, even((long * height) / width)] : [even((long * width) / height), long])
  const motionFps = Math.min(LIMITS.motionFps, LIMITS.motionFrames / seconds)
  const detailFps = Math.min(LIMITS.detailFps, LIMITS.detailFrames / seconds)
  return { motion: { fps: motionFps, size: side(LIMITS.motionSide), max: LIMITS.motionFrames }, detail: { fps: detailFps, size: side(LIMITS.detailSide), max: LIMITS.detailFrames } }
}

/**
 * Builds an Edit DNA 2 from what the three passes measured. Pure: the unit tests feed it numbers.
 * @param {{ seconds: number, width: number, height: number, fps: number | null, plan: object, motion: object | null, detail: object | null, sound: object | null }} m
 */
export function dnaFrom({ seconds, width, height, fps, plan, motion, detail, sound }) {
  const minutes = seconds / 60
  const dna = { kind: "edit-dna", version: DNA2_VERSION, seconds: round(seconds), sampled: { motionFps: round(plan.motion.fps, 2), motionFrames: motion?.frames ?? 0, detailFps: round(plan.detail.fps, 2), detailFrames: detail?.frames ?? 0 } }
  const enough = motion && motion.frames >= 8
  // Every change of picture counts toward the rhythm: joins and punch-ins alike
  const changes = enough ? [...motion.joins.map((j) => j.t), ...motion.zooms.filter((z) => z.ease === "snap").map((z) => z.t)].sort((a, b) => a - b) : []
  const shots = [0, ...changes].map((start, i, list) => ({ start, length: (list[i + 1] ?? seconds) - start }))
  const pace = enough ? paceOf(shots, seconds) : null
  const tolerance = Math.max(2 / (fps || 30), 1 / plan.motion.fps)
  const beats = sound?.beats ?? []
  dna.rhythm = trait("rhythm", !enough ? 0 : shots.length >= 3 ? 0.9 : 0.6, { shots: pace?.shots, cutsPerMinute: pace?.cutsPerMinute, median: pace?.median, p10: pace?.p10, p90: pace?.p90, curve: pace?.curve, onBeats: beats.length >= 8 && changes.length ? round(changes.filter((c) => beats.some((b) => Math.abs(b - c) <= tolerance)).length / changes.length) : null })
  const firstCut = changes[0] ?? null
  const early = detail?.text.early ?? null
  // Title first: text that isn't a caption is up in the first two seconds. Cold open: a first, short piece, then a cut
  const style = detail?.text.earlyGraphic ? "title_first" : firstCut !== null && firstCut >= 1.5 && firstCut <= 6 && shots.length >= 3 && firstCut < (pace?.median ?? 0) * 0.75 ? "cold_open" : "straight_in"
  dna.opening = trait("opening", !enough ? 0 : detail ? 0.7 : 0.5, { firstCut: round(firstCut), motion: round(motion?.opening), textEarly: early, style: detail ? style : null })
  const joins = enough ? motion.joins : []
  const unreadJoins = joins.filter((j) => j.kind === "unread").length
  const gradual = joins.filter((j) => j.kind !== "cut" && j.kind !== "unread")
  dna.transitions = trait("transitions", !enough || plan.motion.fps < KIND_FPS ? 0 : joins.length ? 1 - unreadJoins / joins.length : 0.6, { perMinute: Object.fromEntries(JOIN_KINDS.map((kind) => [kind, round(joins.filter((j) => j.kind === kind).length / minutes, 2)])), unread: round(unreadJoins / minutes, 2), seconds: gradual.length ? round(median(gradual.map((j) => j.end - j.t)), 2) : null })
  // A punch-in's release (the picture going wide again soon after) is the same move, counted once
  const zooms = enough ? motion.zooms.filter((z, i, list) => z.scale > 1 || !list.slice(0, i).some((p) => p.scale > 1 && z.t - p.t < 4)) : []
  const snap = zooms.filter((z) => z.ease === "snap").length
  dna.moves = trait("moves", enough ? 0.8 : 0, { zoomsPerMinute: round(zooms.length / minutes, 2), scale: zooms.length ? round(median(zooms.map((z) => (z.scale >= 1 ? z.scale : 1 / z.scale))), 2) : null, ease: zooms.length ? (snap * 2 >= zooms.length ? "snap" : "eased") : null, shake: round(motion?.shake, 4) })
  const c = detail?.captions
  // Sure that there are none when nothing recurs; sure of what was found by how much of the time it was there
  dna.captions = trait("captions", !detail || detail.frames < 6 ? 0 : c.present ? clamp(0.5 + c.share, 0, 0.95) : 0.8, c ? { present: c.present, top: round(c.top), bottom: round(c.bottom), height: round(c.height, 4), lines: c.lines, pagesPerMinute: round(c.pagesPerMinute, 1), plate: c.plate, contrast: round(c.contrast, 1), highlight: c.marked } : {})
  const g = detail?.graphics
  dna.graphics = trait("graphics", !detail || detail.frames < 6 ? 0 : 0.7, g ? { perMinute: round(g.perMinute, 1), seconds: round(g.seconds, 2), fullFrame: round(g.full), lowerBand: g.lower } : {})
  const col = detail?.colour
  dna.colour = trait("colour", col ? 0.9 : 0, col ? { mean: col.mean.map((v) => round(v, 4)), cov: col.cov.map((row) => row.map((v) => round(v, 5))), luma: col.luma.map((v) => round(v, 4)), contrast: round(col.contrast, 4), saturation: round(col.saturation, 4), drift: round(detail.drift, 4), grain: round(detail.grain, 2), vignette: round(detail.vignette), letterbox: round(detail.letterbox) } : {})
  // Music's share of the time, its level under speech against the gaps, and hits that aren't speech need the voice
  // apart from the rest, which code here can't do: they aren't in an Edit DNA 2 at all. A tempo is read only from a steady pulse
  dna.sound = trait("sound", sound ? 0.8 : 0, sound ? { lufs: round(sound.lufs, 1), range: round(sound.range, 1), truePeak: round(sound.truePeak, 1), bed: round(sound.bed, 1), bpm: sound.pulse >= PULSE ? round(sound.bpm, 0) : null, silence: round(sound.silence) } : {})
  dna.structure = trait("structure", sound?.energy ? 0.7 : 0, { energy: sound?.energy })
  const aspect = width / height
  dna.format = trait("format", width && height ? 1 : 0, { aspect: round(aspect), shape: aspect < 0.7 ? "vertical" : aspect < 0.95 ? "portrait" : aspect <= 1.05 ? "square" : "landscape", fps: round(fps, 2), clearTop: round(detail?.text.top), clearBottom: round(detail?.text.bottom) })
  return checkDna2(dna)
}

/**
 * The three bounded passes through a pipe, as dnaFrom takes them; `onStep` says how far along,
 * `signal` cancels between and inside passes. Join times stay here: the DNA keeps only rates.
 */
export async function measureDna2(file, { run = runTool, signal, onStep = () => {} } = {}) {
  const { facts } = await probe(file, { run })
  const seconds = (facts.duration ?? 0) / FLICKS
  if (!(seconds > 0) || !facts.width) throw new RangeError("This reference has no picture to measure.")
  const plan = samplingFor(seconds, facts.width, facts.height)
  const steps = 100
  onStep(1, steps)
  const [mw, mh] = plan.motion.size
  const motionRead = motionReader(mw, mh, plan.motion.fps)
  const expected = Math.max(1, Math.min(plan.motion.max, Math.floor(seconds * plan.motion.fps)))
  await eachFrame(file, { fps: plan.motion.fps, width: mw, height: mh, format: "gray", max: plan.motion.max, run, signal }, (frame, n) => {
    motionRead.add(frame)
    if (n % 30 === 0) onStep(1 + Math.floor((45 * n) / expected), steps)
  })
  signal?.throwIfAborted()
  const [dw, dh] = plan.detail.size
  const detailFrames = Math.max(1, Math.min(plan.detail.max, Math.floor(seconds * plan.detail.fps)))
  const detailRead = detailReader(dw, dh, plan.detail.fps, { colourEvery: Math.max(1, Math.ceil(detailFrames / LIMITS.colourFrames)) })
  detailRead.expect(detailFrames)
  await eachFrame(file, { fps: plan.detail.fps, width: dw, height: dh, format: "rgb24", max: plan.detail.max, run, signal }, (frame, n) => {
    detailRead.add(frame)
    if (n % 10 === 0) onStep(46 + Math.floor((40 * n) / detailFrames), steps)
  })
  signal?.throwIfAborted()
  let sound = null
  if (facts.hasAudio !== false) {
    const pcm = pcmCollector()
    await run("ffmpeg", [...musicArgs(file).slice(0, -1), "-t", String(LIMITS.soundSeconds), "pipe:1"], { onStdout: pcm.add, signal, timeoutMs: 600_000 })
    onStep(92, steps)
    const samples = pcm.finish()
    const heard = soundOf(samples)
    if (heard) {
      const music = analyseMusic(samples)
      const beats = music.beats.map((b) => b.t / FLICKS)
      const text = await run("ffmpeg", loudnessArgs(file), { signal, timeoutMs: 600_000 })
      const loud = readLoudness(text)
      const range = [...text.matchAll(/lavfi\.r128\.LRA=(-?[\d.]+)/g)].at(-1)?.[1]
      const pulse = pulseOf(samples, beats)
      sound = { ...heard, lufs: loud.integrated, range: range === undefined ? null : Number(range), truePeak: loud.truePeak, bpm: music.bpm, pulse, beats: pulse >= PULSE ? beats : [] }
    }
  }
  signal?.throwIfAborted()
  onStep(99, steps)
  return { seconds, width: facts.width, height: facts.height, fps: facts.fps ? facts.fps.n / facts.fps.d : null, plan, motion: motionRead.finish(), detail: detailRead.finish(), sound }
}

/**
 * Measures a reference video into an Edit DNA 2.
 * @returns {Promise<object>} checked by checkDna2
 */
export async function extractDna2(file, options = {}) {
  return dnaFrom(await measureDna2(file, options))
}
