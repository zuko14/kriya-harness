import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { hashProject } from "../src/edit/core/project.js"
import { applyStyleBrief, cleanOff, FLOOR, styleBrief, tickable, TRAIT_IDS } from "../src/edit/core/style-brief.js"
import { LOOKS, MORE_CAPTION_LOOKS } from "../src/edit/engine/captions.js"
import { referenceCube } from "../src/edit/engine/reference2.js"
import { sampleCube, parseCube, toOklab } from "../src/edit/engine/color.js"
import { checkDna } from "../src/edit/engine/dna.js"
import { checkDna2, detailReader, DNA2_SHAPE, DNA2_VERSION, dnaFrom, JOIN_KINDS, joinKind, LIMITS, motionReader, pulseOf, readDna2, samplingFor, scaleFit, soundOf, textRegions } from "../src/edit/engine/dna2.js"
import { MOODS } from "../src/edit/engine/music-bed.js"
import { GATES, verdictOf } from "../src/edit/gates/index.js"
import { referenceFit, sayFit, TOLERANCE } from "../src/edit/gates/reference.js"
import { createJobs } from "../src/edit/host/jobs.js"
import { replayAsk } from "../src/edit/loop/replay.js"
import { planReel } from "../src/edit/recipes/reel.js"
import { fetchFeatures } from "../src/edit/runtime/fetch.js"

// TP6 (TOP_TIER_PLAN §5, ET-RF2-01…08): Edit DNA 2, the style brief and QG-16, with no media and no
// model. Frames are arrays this file draws; the real FFmpeg and Kriya-made references are
// tests/edit/media/reference2.test.js.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const [W, H] = [64, 36]
// Two pictures with detail everywhere, far apart
const picture = (fn) => Uint8Array.from({ length: W * H }, (_, i) => Math.max(0, Math.min(255, Math.round(fn(i % W, Math.floor(i / W))))))
const A = picture((x, y) => 60 + 2 * x + 30 * Math.sin(y / 3) + ((x >> 3) % 2 ? 25 : 0))
const B = picture((x, y) => 200 - 2.5 * y - 20 * Math.sin(x / 4) - ((y >> 2) % 2 ? 30 : 0))
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t))
const zoomed = (a, s) => picture((x, y) => a[Math.max(0, Math.min(H - 1, Math.round((H - 1) / 2 + (y - (H - 1) / 2) / s))) * W + Math.max(0, Math.min(W - 1, Math.round((W - 1) / 2 + (x - (W - 1) / 2) / s)))])
const wipe = (a, b, t) => picture((x, y) => (x >= W * (1 - t) ? b : a)[y * W + x])
const slide = (a, b, t) => picture((x, y) => (x < W * (1 - t) ? a[y * W + Math.min(W - 1, x + Math.round(W * t))] : b[y * W + (x - Math.round(W * (1 - t)))]))
const dark = (a, t) => a.map((v) => Math.round(v * t))
const steps = [0.2, 0.4, 0.6, 0.8]

test("ET-RF2-01: a join's kind from the frames inside it: dissolve, wipe, slide, zoom, through black, through white; none fits, it is unread", () => {
  const kinds = {
    fade: steps.map((t) => mix(A, B, t)),
    wipe: steps.map((t) => wipe(A, B, t)),
    slide: steps.map((t) => slide(A, B, t)),
    zoom: [zoomed(A, 1.2), zoomed(A, 1.5), mix(zoomed(A, 2), B, 0.4), mix(zoomed(A, 3), B, 0.8)],
    dip: [dark(A, 0.5), dark(A, 0.1), dark(B, 0.1), dark(B, 0.6)],
    flash: [mix(A, picture(() => 255), 0.6), picture(() => 255), mix(B, picture(() => 255), 0.5)],
  }
  for (const [kind, mids] of Object.entries(kinds)) assert.equal(joinKind(A, B, mids, W, H).kind, kind, kind)
  assert.deepEqual(Object.keys(kinds).sort(), JOIN_KINDS.filter((k) => k !== "cut").sort(), "every kind Kriya makes is read")
  // Frames that are neither picture, nor between them: no model fits, so it isn't guessed
  const other = (k) => picture((x, y) => ((x * 7 + y * 13 + k * 31) % 64) * 4)
  assert.equal(joinKind(A, B, [other(1), other(2), other(3)], W, H).kind, "unread")
})

test("ET-RF2-01: the motion reader finds a hard cut, a punch-in, an eased zoom and a held dip, and keeps only times and kinds", () => {
  const fps = 15
  const feed = (frames) => {
    const reader = motionReader(W, H, fps)
    for (const frame of frames) reader.add(frame)
    return reader.finish()
  }
  const hold = (frame, n) => Array.from({ length: n }, () => frame)
  // A cut at frame 20; a punch-in (the same picture, closer) at frame 40; back out at 55
  const cut = feed([...hold(A, 20), ...hold(B, 20), ...hold(zoomed(B, 1.25), 15), ...hold(B, 15)])
  assert.deepEqual(cut.joins.map((j) => [Math.round(j.t * fps), j.kind]), [[20, "cut"]])
  assert.deepEqual(cut.zooms.map((z) => [Math.round(z.t * fps), z.ease, Math.round(z.scale * 100) / 100]), [[40, "snap", 1.25], [55, "snap", 0.8]])
  // A dissolve over 6 frames, and a dip that sits on black for 3: one join each, by kind
  const gradual = feed([...hold(A, 20), ...steps.map((t) => mix(A, B, t)), ...hold(B, 20), dark(B, 0.5), dark(B, 0.05), ...hold(dark(B, 0), 3), dark(A, 0.05), dark(A, 0.5), ...hold(A, 20)])
  assert.deepEqual(gradual.joins.map((j) => j.kind), ["fade", "dip"])
  // A slow zoom in over a second and a half is a move inside the shot, not a join
  const eased = feed([...hold(A, 15), ...Array.from({ length: 22 }, (_, i) => zoomed(A, 1 + (0.3 * (i + 1)) / 22)), ...hold(zoomed(A, 1.3), 15)])
  assert.equal(eased.joins.length, 0)
  assert.ok(eased.zooms.length >= 1 && eased.zooms.every((z) => z.ease === "eased" && z.scale > 1), JSON.stringify(eased.zooms))
  // What comes out is numbers and fixed words: no frame is kept
  assert.doesNotMatch(JSON.stringify(cut), /Uint8Array|"frame"/)
  assert.equal(scaleFit(A, zoomed(A, 1.3), W, H, [1.2, 1.3, 1.4]).scale, 1.3)
  assert.ok(scaleFit(A, B, W, H, [1.2, 1.3, 1.4]).gain < 0.3, "another picture isn't a zoom")
})

/* ───────────────────────────── text, colour, sound ───────────────────────────── */

const [DW, DH] = [320, 180]
/** A grey frame with "words" of white strokes at a row, on a dark plate or not, plus bars, corners and grain when asked. */
function detailFrame({ words = [], plate = false, bars = 0, corners = 0, grain = 0, seed = 1, base = 120 } = {}) {
  const rgb = new Uint8Array(DW * DH * 3)
  let state = seed
  const noise = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5) * 2 * grain
  for (let y = 0; y < DH; y++)
    for (let x = 0; x < DW; x++) {
      const edge = Math.hypot((x - DW / 2) / (DW / 2), (y - DH / 2) / (DH / 2))
      let v = (base + 30 * (x / DW)) * (1 - corners * Math.max(0, edge - 0.5)) + noise()
      if (y < bars * DH || y >= DH - bars * DH) v = 0
      rgb.fill(Math.max(0, Math.min(255, Math.round(v))), (y * DW + x) * 3, (y * DW + x) * 3 + 3)
    }
  for (const { x, y, w, h = 12, colour = [255, 255, 255] } of words) {
    if (plate) for (let yy = y - 5; yy < y + h + 5; yy++) for (let xx = x - 6; xx < x + w + 6; xx++) rgb.fill(12, (yy * DW + xx) * 3, (yy * DW + xx) * 3 + 3)
    // Letters: strokes two pixels wide, two apart
    for (let xx = x; xx < x + w; xx += 4) for (let yy = y; yy < y + h; yy++) for (let k = 0; k < 2; k++) rgb.set(colour, (yy * DW + xx + k) * 3)
  }
  return rgb
}

test("ET-RF2-02: text regions say where text is, how tall, on a plate or not, and never what it says", () => {
  const boxed = textRegions(detailFrame({ words: [{ x: 100, y: 150, w: 60 }, { x: 168, y: 150, w: 48, colour: [255, 210, 40] }], plate: true }), DW, DH)
  assert.equal(boxed.length, 1)
  assert.deepEqual([boxed[0].lines, boxed[0].plate, boxed[0].marked], [1, "box", true], JSON.stringify(boxed[0]))
  assert.ok(Math.abs(boxed[0].y0 - 150) <= 1 && Math.abs(boxed[0].y1 - 162) <= 1 && boxed[0].x0 <= 101 && boxed[0].x1 >= 214)
  assert.ok(boxed[0].contrast > 7, `white on a dark plate reads ${boxed[0].contrast}`)
  const bare = textRegions(detailFrame({ words: [{ x: 100, y: 150, w: 116 }] }), DW, DH)
  assert.deepEqual([bare[0].plate, bare[0].marked], ["none", false])
  assert.ok(bare[0].contrast < 4.5, "white on mid grey is under 4.5:1")
  // On a dark picture a plate and no plate look the same: not read, never guessed
  assert.equal(textRegions(detailFrame({ words: [{ x: 100, y: 150, w: 116 }], base: 20 }), DW, DH)[0].plate, null)
  // One edge of a box isn't text, and a plain picture has none
  assert.deepEqual(textRegions(detailFrame(), DW, DH), [])
  assert.deepEqual(Object.keys(boxed[0]).sort(), ["contrast", "lines", "marked", "plate", "x0", "x1", "y0", "y1"])
})

test("ET-RF2-02: captions (band, height, pages a minute), graphics, grain, corners and bars from sampled frames", () => {
  const fps = 4
  const read = (frames) => {
    const reader = detailReader(DW, DH, fps)
    reader.expect(frames.length)
    frames.forEach((f) => reader.add(f))
    return reader.finish()
  }
  // 30 s: a caption page for a second, a gap, the next page elsewhere; a strap upper left for 2 s at 10 s
  const frames = Array.from({ length: 120 }, (_, n) => {
    const second = Math.floor(n / fps)
    const page = second % 2 === 0 && n % 8 < 5 ? [{ x: 90 + ((second / 2) % 3) * 12, y: 150, w: 100 - ((second / 2) % 3) * 20 }] : []
    const strap = second >= 10 && second < 12 ? [{ x: 24, y: 40, w: 80 }] : []
    return detailFrame({ words: [...page, ...strap], plate: true, seed: n + 1 })
  })
  const plain = read(frames)
  assert.equal(plain.captions.present, true)
  assert.ok(Math.abs(plain.captions.top - 150 / DH) < 0.01 && Math.abs(plain.captions.height - 12 / DH) < 0.01, JSON.stringify(plain.captions))
  assert.ok(Math.abs(plain.captions.pagesPerMinute - 30) <= 2, `${plain.captions.pagesPerMinute} pages a minute, 15 were shown in 30 s`)
  assert.equal(plain.captions.plate, "box")
  assert.deepEqual([plain.graphics.count, Math.round(plain.graphics.seconds)], [1, 2])
  assert.ok(plain.grain < 0.8 && Math.abs(plain.vignette) < 0.1 && plain.letterbox === 0, JSON.stringify([plain.grain, plain.vignette, plain.letterbox]))
  // The same film with grain, dark corners and bars
  const dressed = read(Array.from({ length: 40 }, (_, n) => detailFrame({ bars: 0.1, corners: 0.8, grain: 14, seed: n + 1 })))
  assert.ok(dressed.grain > 2, `grain ${dressed.grain}`)
  assert.ok(dressed.vignette > 0.2, `corners ${dressed.vignette}`)
  assert.ok(Math.abs(dressed.letterbox - 0.2) < 0.02, `bars ${dressed.letterbox}`)
  assert.equal(dressed.captions.present, false)
  // Colour statistics are OKLab numbers; the thirds give a drift
  assert.ok(plain.colour.mean.every(Number.isFinite) && plain.drift < 0.02)
})

test("ET-RF2-02: sound: silence, a bed under the gaps, and a tempo only from a steady pulse", () => {
  const rate = 11_025
  const seconds = 20
  const kicks = new Float32Array(rate * seconds)
  const beats = []
  // A kick every half second (120 bpm) over a quiet pad
  for (let b = 0; b < seconds * 2; b++) {
    beats.push(b * 0.5)
    for (let i = 0; i < rate * 0.08; i++) kicks[Math.round(b * 0.5 * rate) + i] += 0.6 * Math.sin((2 * Math.PI * 60 * i) / rate) * Math.exp(-i / (rate * 0.03))
  }
  for (let i = 0; i < kicks.length; i++) kicks[i] += 0.02 * Math.sin((2 * Math.PI * 220 * i) / rate)
  assert.ok(pulseOf(kicks, beats, rate) > 0.9)
  // Speech-like bursts at uneven times against the same grid: no pulse, so no tempo is claimed
  const speech = new Float32Array(rate * seconds)
  for (const at of [0.3, 1.1, 1.7, 3.2, 4.05, 5.5, 6.1, 7.9, 9.3, 10.2, 12.8, 13.3, 15.1, 16.6, 18.2]) for (let i = 0; i < rate * 0.4; i++) speech[Math.round(at * rate) + i] = 0.3 * Math.sin((2 * Math.PI * 170 * i) / rate)
  assert.ok(pulseOf(speech, beats, rate) < 0.5)
  const [bed, gaps] = [soundOf(kicks, rate), soundOf(speech, rate)]
  assert.ok(bed.bed > -30 && gaps.bed < -30, `${bed.bed} with a bed, ${gaps.bed} with empty gaps`)
  assert.ok(gaps.silence > 0.5 && bed.silence < 0.05)
  assert.equal(bed.energy.length, 10)
})

/* ───────────────────────────── the DNA, its confidence, its check ───────────────────────────── */

const plan = samplingFor(30, 1080, 1920)
const measured = (over = {}) => ({
  seconds: 30,
  width: 1080,
  height: 1920,
  fps: 30,
  plan,
  motion: { frames: 450, joins: [{ t: 3, end: 3, kind: "cut" }, { t: 6, end: 6.4, kind: "slide" }, { t: 9, end: 9, kind: "cut" }, { t: 12, end: 12.4, kind: "slide" }, { t: 15, end: 15, kind: "cut" }, { t: 18, end: 18.4, kind: "slide" }, { t: 21, end: 21, kind: "cut" }, { t: 24, end: 24.4, kind: "slide" }, { t: 27, end: 27, kind: "cut" }], zooms: [{ t: 7, scale: 1.25, ease: "snap" }, { t: 8.2, scale: 0.8, ease: "snap" }, { t: 19, scale: 1.25, ease: "snap" }], misses: [], opening: 0.4, still: 0.02, shake: 0.001 },
  detail: {
    frames: 120,
    captions: { present: true, top: 0.84, bottom: 0.884, height: 0.042, lines: 1, pagesPerMinute: 36, plate: "box", contrast: 8.7, marked: true, share: 0.6 },
    graphics: { perMinute: 4, seconds: 1.4, full: 0, lower: true, count: 2 },
    text: { top: 0.68, bottom: 0.11, early: true, earlyGraphic: false },
    colour: { mean: [0.55, 0.004, 0.03], cov: [[0.027, 0, 0], [0, 0.004, 0], [0, 0, 0.004]], luma: new Array(16).fill(1 / 16), contrast: 0.16, saturation: 0.08 },
    drift: 0.04,
    grain: 3.1,
    vignette: 0.43,
    letterbox: 0,
  },
  sound: { silence: 0.01, energy: new Array(10).fill(0.6), bed: -19, lufs: -9.2, range: 1, truePeak: -1, bpm: 110, pulse: 0.8, beats: [1, 2, 6.02, 9.4, 12.01, 13.5, 18.03, 24, 25.5, 26.2] },
  ...over,
})

test("ET-RF2-03: each trait carries a confidence, and one that can't be read is reported as not read, never guessed", () => {
  const dna = dnaFrom(measured())
  for (const name of ["rhythm", "opening", "transitions", "moves", "captions", "graphics", "colour", "sound", "structure", "format"]) assert.deepEqual([dna[name].read, dna[name].confidence >= 0.5], ["yes", true], name)
  assert.deepEqual([dna.rhythm.shots, dna.transitions.perMinute.slide, dna.transitions.perMinute.cut, dna.moves.zoomsPerMinute, dna.moves.scale], [13, 8, 10, 4, 1.25])
  assert.equal(dna.rhythm.onBeats, 0.333, "four of the twelve picture changes are within two frames of a beat")
  assert.deepEqual([dna.format.shape, dna.sound.bpm, dna.captions.plate, dna.opening.style], ["vertical", 110, "box", "straight_in"])
  // A long video is sampled too thinly to tell a dissolve from a wipe: its transitions aren't read at all
  const long = samplingFor(3600, 1920, 1080)
  assert.ok(long.motion.fps <= 2 && long.motion.fps * 3600 <= LIMITS.motionFrames && long.detail.fps * 3600 <= LIMITS.detailFrames, "bounded however long the reference is (EH-73)")
  const thin = dnaFrom(measured({ seconds: 3600, plan: long }))
  assert.deepEqual([thin.transitions.read, thin.transitions.confidence, thin.transitions.perMinute.slide, thin.transitions.perMinute.cut], ["no", 0, null, null])
  assert.equal(thin.rhythm.read, "yes", "its pace still is")
  // No sound, no picture detail, too few frames: each says so
  const bare = dnaFrom(measured({ sound: null, detail: null, motion: { ...measured().motion, frames: 4 } }))
  for (const name of ["rhythm", "transitions", "moves", "captions", "graphics", "colour", "sound", "structure"]) assert.equal(bare[name].read, "no", name)
  assert.equal(bare.colour.mean.every((v) => v === null) && bare.colour.cov === null, true)
  // Voice only: no steady pulse, so no tempo; a tempo is never taken from speech
  assert.equal(dnaFrom(measured({ sound: { ...measured().sound, pulse: 0.4, beats: [] } })).sound.bpm, null)
  // Captions on a dark picture: there, but the plate isn't read
  assert.equal(dnaFrom(measured({ detail: { ...measured().detail, captions: { ...measured().detail.captions, plate: null } } })).captions.plate, null)
})

test("ET-RF2-04, ET-SEC-08: checkDna2 takes numbers, true or false and its fixed words; any text, path, extra field or other shape is refused", () => {
  const dna = dnaFrom(measured())
  assert.equal(checkDna2(structuredClone(dna)).version, DNA2_VERSION)
  // Every string in a DNA is one of the shape's own fixed words
  const allowed = new Set(["edit-dna", DNA2_VERSION])
  const collect = (shape) => (Array.isArray(shape?.enum) ? shape.enum.forEach((w) => allowed.add(w)) : shape && typeof shape === "object" && !Array.isArray(shape) ? Object.values(shape).forEach(collect) : null)
  collect(DNA2_SHAPE)
  const strings = []
  JSON.stringify(dna, (_, v) => (typeof v === "string" && strings.push(v), v))
  assert.deepEqual(strings.filter((s) => !allowed.has(s)), [])
  assert.ok(JSON.stringify(dna).length < 2400, `${JSON.stringify(dna).length} bytes`)
  const bad = (change, why) => {
    const copy = structuredClone(dna)
    change(copy)
    assert.throws(() => checkDna2(copy), RangeError, why)
  }
  bad((d) => (d.captions.text = "Start small"), "a caption's words")
  bad((d) => (d.source = "/Users/x/reference.mp4"), "a path")
  bad((d) => (d.opening.style = "like MrBeast"), "a word that isn't in the list")
  bad((d) => (d.captions.plate = "outline"), "a word from another list")
  bad((d) => (d.rhythm.median = "2.1"), "a number as text")
  bad((d) => (d.colour.luma = [...d.colour.luma, 0.5]), "an array of another length (pixels)")
  bad((d) => (d.colour.mean = { r: 1 }), "an object where numbers go")
  bad((d) => (d.rhythm.curve[0] = [1, 2, 3]), "a list inside a list")
  bad((d) => (d.format.fps = Infinity), "not a finite number")
  bad((d) => (d.sound.frames = new Array(100).fill(7)), "a field that isn't part of it")
  bad((d) => (d.version = "dna-1"), "another version")
  bad((d) => (d.captions.present = "yes"), "text for true")
  bad((d) => delete d.kind, "no kind")
  assert.throws(() => checkDna2("edit-dna"), RangeError)
  assert.throws(() => checkDna2(null), RangeError)
  // An Edit DNA 1 isn't an Edit DNA 2, and the other way round
  assert.throws(() => checkDna(dna), RangeError)
})

test("ET-RF2-08 (cache): an older cached analysis is never read as the new shape: it counts as not measured", () => {
  const dna = dnaFrom(measured())
  assert.deepEqual(readDna2(JSON.stringify(dna)), dna)
  const v1 = { kind: "edit-dna", version: "dna-1", seconds: 40, pace: { shots: 16, cutsPerMinute: 22, median: 4, p10: 1, p90: 4, curve: new Array(10).fill(1) }, structure: { firstCut: 1, lastShot: 4 }, colour: null, captions: null, sound: null }
  assert.equal(checkDna(v1), v1, "a real Edit DNA 1")
  assert.equal(readDna2(JSON.stringify(v1)), null)
  // reference.js's kept analysis (the `.2.json` cache), a future version, a damaged file, a tampered one
  assert.equal(readDna2(JSON.stringify({ kind: "video", lines: ["Pace: the picture changes every 4.0 s"], parts: {} })), null)
  assert.equal(readDna2(JSON.stringify({ ...dna, version: "dna-3" })), null)
  assert.equal(readDna2("{ not json"), null)
  assert.equal(readDna2(JSON.stringify({ ...dna, note: "see /tmp/ref.mp4" })), null)
  const hostCode = readFileSync(join(ROOT, "src/edit/host/projects.js"), "utf8")
  assert.match(hostCode, /\$\{asset\.fingerprint\}\.dna2\.json/, "its own cache name")
  assert.match(hostCode, /\$\{asset\.fingerprint\}\.2\.json/, "ED13's cache is still read by ED13's code, under its own name")
})

/* ───────────────────────────── the style brief ───────────────────────────── */

const can = (over = {}) => ({ looks: { ...LOOKS, ...MORE_CAPTION_LOOKS }, moods: MOODS, motion: true, craft: true, tall: true, safe: { top: 0.12, bottom: 0.22 }, ...over })
const line = (brief, id) => brief.lines.find((l) => l.id === id)

test("ET-RF2-05: the style brief marks each trait matched, nearest (and says why) or cannot", () => {
  const dna = dnaFrom(measured())
  const brief = styleBrief(dna, can())
  assert.deepEqual(brief.lines.map((l) => [l.id, l.state]), [["pace", "matched"], ["joins", "nearest"], ["zooms", "matched"], ["captions", "nearest"], ["graphics", "matched"], ["colour", "matched"], ["grain", "matched"], ["corners", "matched"], ["music", "nearest"], ["loudness", "nearest"], ["opening", "matched"], ["format", "matched"]])
  assert.equal(line(brief, "pace").text, "A change of picture about every 2.5 s")
  assert.equal(line(brief, "zooms").text, "Punch-ins at ×1.25")
  assert.equal(line(brief, "joins").text, "Slides on half the joins")
  assert.match(line(brief, "captions").text, /^Word-by-word captions on a plate, lower third$/)
  assert.match(line(brief, "captions").why, /^nearest: karaoke, 4\.6% of the height/)
  assert.deepEqual(line(brief, "captions").set, { captions: "karaoke" })
  assert.match(line(brief, "music").why, /nearest: an upbeat bed of my own at 110 bpm/)
  assert.ok(brief.lines.every((l) => l.state === "matched" || l.why), "a nearest or a cannot always says why")
  assert.ok(brief.lines.every((l) => TRAIT_IDS.includes(l.id)))
  // With motion and effects off on this server, the same reference: those lines can't be done, and say so
  const less = styleBrief(dna, can({ motion: false, craft: false }))
  assert.deepEqual(["joins", "graphics", "grain", "corners"].map((id) => [line(less, id).state, "set" in line(less, id)]), [["cannot", false], ["cannot", false], ["cannot", false], ["cannot", false]])
  assert.match(line(less, "grain").why, /effects, which are off here/)
  // What wasn't read is listed in words, never turned into a line
  const thin = styleBrief(dnaFrom(measured({ sound: null, seconds: 3600, plan: samplingFor(3600, 1080, 1920) })), can())
  assert.deepEqual([line(thin, "joins"), line(thin, "music")], [undefined, undefined])
  assert.deepEqual(thin.unread, ["its transitions", "its sound", "its sections"])
  // Only the reference's numbers and this file's own sentences: nothing else is in a brief
  assert.doesNotMatch(JSON.stringify(brief), /\.mp4|\/Users|http/)
  assert.deepEqual(tickable(brief), ["pace", "joins", "zooms", "captions", "graphics", "colour", "grain", "corners", "music", "format"])
})

test("ET-RF2-06: the gates outrank the reference, and the brief says where: cut hygiene, safe zones, contrast, loudness, reading time", () => {
  // Cuts every 0.6 s; captions low under the buttons, thin and faint; nine graphics a minute; mastered hot; bars on a tall film
  const m = measured()
  const fast = Array.from({ length: 49 }, (_, i) => ({ t: (i + 1) * 0.6, end: (i + 1) * 0.6, kind: "cut" }))
  const dna = dnaFrom({ ...m, motion: { ...m.motion, joins: fast, zooms: [] }, detail: { ...m.detail, captions: { ...m.detail.captions, plate: "none", contrast: 2.4, top: 0.9, bottom: 0.95 }, graphics: { ...m.detail.graphics, perMinute: 9 }, letterbox: 0.2 } })
  const brief = styleBrief(dna, can())
  const pace = line(brief, "pace")
  assert.deepEqual([pace.state, pace.gate, pace.set.paceEvery, pace.target.every], ["nearest", "cut hygiene", FLOOR.hold, FLOOR.hold])
  assert.match(pace.why, /at least 1\.0 s/)
  const captions = line(brief, "captions")
  assert.equal(captions.gate, "safe zones")
  assert.match(captions.why, /Your reference's captions run under the app's buttons\. I kept mine clear of them\./)
  assert.match(captions.why, /read at about 2\.4:1 against the picture\. Mine hold 4\.5:1\./)
  const graphics = line(brief, "graphics")
  assert.deepEqual([graphics.state, graphics.set.graphicsPerMinute, graphics.why], ["nearest", 6, "I can place 6: they need room to be read."])
  const loud = line(brief, "loudness")
  assert.deepEqual([loud.state, loud.gate, loud.locked, "set" in loud], ["nearest", "loudness", true, false], "loudness is said, never offered")
  assert.match(loud.why, /-14 LUFS/)
  assert.deepEqual([line(brief, "bars").state, line(brief, "bars").gate], ["cannot", "safe zones"])
  // On a wide film the same bars can be drawn
  assert.deepEqual(line(styleBrief(dna, can({ tall: false, safe: undefined })), "bars").set, { letterbox: 1.5 })
  // Applied: the floor's numbers, not the reference's, and each override is a note the person reads
  const applied = applyStyleBrief({}, brief, [], { seconds: 30 })
  assert.ok(applied.brief.punches <= FLOOR.punches)
  assert.equal("lufs" in applied.brief || "loudness" in applied.brief, false, "nothing in a brief can change the loudness the gate holds")
  assert.ok(applied.notes.some((n) => /at least 1\.0 s/.test(n)) && applied.notes.some((n) => /I kept mine clear/.test(n)) && applied.notes.some((n) => /-14 LUFS/.test(n)), applied.notes.join(" | "))
  assert.equal(applied.brief.fx.some((e) => e.effect === "letterbox"), false, "no bars on a tall film")
})

test("ET-RF2-05, -06: the person unticks a line and it is gone; what they chose in the brief beats the reference; nothing is added without a brief", () => {
  const brief = styleBrief(dnaFrom(measured()), can())
  const all = applyStyleBrief({}, brief, [], { seconds: 30 })
  assert.deepEqual({ punches: all.brief.punches, zoom: all.brief.zoom, transition: all.brief.transition, captions: all.brief.captions, music: all.brief.music, musicBpm: all.brief.musicBpm, format: all.brief.format }, { punches: 6, zoom: 1.25, transition: "slide", captions: "karaoke", music: "generated:upbeat", musicBpm: 110, format: "9:16" })
  assert.deepEqual(all.brief.fx, [{ effect: "grain", params: { amount: 20 } }, { effect: "vignette", params: { strength: 0.82 } }])
  assert.equal(all.colourMatch, true)
  // Unticked: captions, grain, music, colour
  const some = applyStyleBrief({}, brief, cleanOff(["captions", "grain", "music", "colour", "not-a-trait", "captions"]), { seconds: 30 })
  assert.deepEqual([some.brief.captions, some.brief.music, some.colourMatch, some.brief.fx], [undefined, undefined, false, [{ effect: "vignette", params: { strength: 0.82 } }]])
  assert.deepEqual(some.kept.map((l) => l.id).filter((id) => ["captions", "grain", "music", "colour"].includes(id)), [])
  assert.deepEqual(cleanOff("captions"), [])
  // The person's own choices in this brief win
  const own = applyStyleBrief({ captions: "clean", music: "m1", punches: 2, transition: "fade", grade: "warm", format: "16:9" }, brief, [], { seconds: 30 })
  assert.deepEqual([own.brief.captions, own.brief.music, own.brief.punches, own.brief.transition, own.brief.format, own.colourMatch], ["clean", "m1", 2, "fade", "16:9", false])
  // A plan's graphics are capped at the reference's rate, never raised
  const capped = applyStyleBrief({ graphics: Array.from({ length: 8 }, (_, i) => ({ kind: "title", text: `g${i}` })) }, brief, [], { seconds: 30 })
  assert.equal(capped.brief.graphics.length, 2, "four a minute for half a minute")
})

test("ET-RF2-06: the reference's colour as a measured match: a LUT from two sets of numbers, limited, never a pixel", () => {
  const own = { mean: toOklab([0.45, 0.45, 0.47]), cov: [[0.02, 0, 0], [0, 0.002, 0], [0, 0, 0.002]] }
  const warm = { mean: [own.mean[0] + 0.05, own.mean[1] + 0.02, own.mean[2] + 0.04], cov: own.cov }
  const match = referenceCube(own, warm)
  const cube = parseCube(match.cube)
  assert.equal(cube.size, 33)
  const [r, , b] = sampleCube(cube, [0.45, 0.45, 0.47])
  assert.ok(r > 0.47 && b < 0.47, `grey went warm: ${r.toFixed(3)}, ${b.toFixed(3)}`)
  assert.equal(match.limited, false)
  // A reference far from the footage is followed part of the way, and says so
  const far = referenceCube(own, { mean: [own.mean[0] + 0.4, own.mean[1], own.mean[2] + 0.2], cov: own.cov })
  assert.equal(far.limited, true)
  assert.ok(sampleCube(parseCube(far.cube), [0.45, 0.45, 0.47])[0] < 0.9, "within the match's limits")
  assert.equal(referenceCube(own, own).limited, false)
})

/* ───────────────────────────── QG-16 ───────────────────────────── */

test("ET-RF2-07: QG-16 compares the made cut with the ticked lines within tolerances, says followed X of Y, hints by type, and is a note", () => {
  const reference = dnaFrom(measured())
  const brief = styleBrief(reference, can())
  const kept = applyStyleBrief({}, brief, [], { seconds: 30 }).kept
  // The reference against itself follows everything that has a number to compare
  const same = referenceFit(kept, reference)
  assert.deepEqual([same.followed, same.of, same.missed, same.unread], [10, 10, [], 0])
  assert.equal(sayFit(same), "Followed 10 of 10 things from your reference.")
  // A made cut that is slower, has no grain, smaller captions and no bed
  const m = measured()
  const made = dnaFrom({ ...m, motion: { ...m.motion, joins: m.motion.joins.filter((_, i) => i % 3 === 1), zooms: [] }, detail: { ...m.detail, grain: 0.2, captions: { ...m.detail.captions, height: 0.02 } }, sound: { ...m.sound, bed: -44, pulse: 0.2, beats: [] } })
  const fit = referenceFit(kept, made)
  assert.deepEqual(fit.missed.map((x) => [x.id, x.hint]), [["pace", { rung: "punches", change: "more" }], ["zooms", { rung: "punches", change: "more" }], ["captions", { rung: "caption_size", change: "larger" }], ["grain", { rung: "grain", change: "more" }], ["music", { rung: "music", change: "more" }]])
  assert.deepEqual([fit.followed, fit.of], [5, 10])
  assert.match(sayFit(fit), /^Followed 5 of 10 things from your reference; not: a change of picture about every 2\.5 s; /)
  // Tolerances, at their edges
  const paced = (every) => referenceFit([{ id: "pace", text: "p", target: { every: 2 } }], { rhythm: { read: "yes", cutsPerMinute: 60 / every } })
  const sized = (scale) => referenceFit([{ id: "zooms", text: "z", target: { scale: 1.25 } }], { moves: { read: "yes", zoomsPerMinute: scale ? 6 : 0, scale } }).followed
  assert.deepEqual([sized(1.3), sized(1.4), sized(null)], [1, 0, 0])
  assert.deepEqual([paced(2 * (1 + TOLERANCE.pace) - 0.01).followed, paced(2 * (1 + TOLERANCE.pace) + 0.01).followed, paced(2 * (1 - TOLERANCE.pace) + 0.01).followed, paced(2 * (1 - TOLERANCE.pace) - 0.01).followed], [1, 0, 1, 0])
  const coloured = (dl, da) => referenceFit([{ id: "colour", text: "c", target: { mean: [0.5, 0, 0] } }], { colour: { read: "yes", mean: [0.5 + dl, da, 0] } }).followed
  assert.deepEqual([coloured(0.079, 0), coloured(0.081, 0), coloured(0, 0.039), coloured(0, 0.041)], [1, 0, 1, 0])
  const tempo = (bpm) => referenceFit([{ id: "music", text: "m", target: { bed: -10, bpm: 110 } }], { sound: { read: "yes", bed: -12, bpm } }).followed
  assert.deepEqual([tempo(114), tempo(115), tempo(null)], [1, 0, 1], "a tempo that couldn't be read back isn't held against the cut")
  // Where captions sit is the safe zones' call: a cut that moved them up still follows
  assert.equal(referenceFit(kept.filter((l) => l.id === "captions"), dnaFrom({ ...m, detail: { ...m.detail, captions: { ...m.detail.captions, top: 0.7, bottom: 0.744 } } })).followed, 1)
  // A trait the made cut's measure couldn't read is counted neither way
  const blind = referenceFit(kept, dnaFrom({ ...m, sound: null }))
  assert.deepEqual([blind.unread, blind.of], [1, 9])
  // A note, never a block: a clean cut that missed traits is still delivered (EH-70, rule 8)
  const gate = { id: "QG-16", status: "failed", severity: "note", numbers: {}, message: sayFit(fit) }
  const clean = GATES.map((id) => ({ id, status: "passed", severity: "block", numbers: {}, message: "" }))
  assert.deepEqual([verdictOf([...clean, gate]).verdict, verdictOf([...clean, gate]).blocking, verdictOf(clean).verdict], ["delivered_with_notes", 0, "delivered"])
  assert.equal(GATES.includes("QG-16"), false, "a film with no reference has the 14 gates it had")
  assert.match(readFileSync(join(ROOT, "src/edit/gates/index.js"), "utf8"), /"QG-16": "note"/)
})

/* ───────────────────────────── the job, the switch, the regressions ───────────────────────────── */

function fakeState() {
  const rows = []
  return {
    id: "p1",
    log: { head: "h1" },
    journal: {
      addJob: ({ kind, request }) => rows.push({ id: rows.length + 1, kind, status: "pending", progress: 0, error: null, dispatch: null, request: JSON.stringify(request) }),
      setJob: (id, fields) => Object.assign(rows[id - 1], fields),
      job: (id) => rows[id - 1],
      jobs: () => rows,
    },
  }
}

test("ET-RF2-08: the measure is a job with progress that can be cancelled, and it leaves nothing behind when it is", async () => {
  const events = []
  let kept = null
  const projects = {
    // As the Host's: measures through the signal, keeps the result only when it finishes
    async measureReference(state, asset, { job, signal, onStep }) {
      assert.ok(Number.isInteger(job) && job > 0, "always a job's number")
      for (let done = 1; done <= 100; done++) {
        onStep(done, 100)
        await new Promise((next, fail) => {
          const timer = setTimeout(next, 2)
          signal.addEventListener("abort", () => (clearTimeout(timer), fail(signal.reason)), { once: true })
        })
      }
      kept = { asset }
      return { asset, traits: 10 }
    },
  }
  const jobs = createJobs({ projects, emit: (kind, job) => events.push({ kind, ...job }), log: () => {} })
  const state = fakeState()
  const started = jobs.start(state, { kind: "reference", asset: "ref1" })
  assert.deepEqual([started.kind, started.asset, started.status], ["reference", "ref1", "running"])
  await new Promise((r) => setTimeout(r, 30))
  assert.ok(events.some((e) => e.progress > 0 && e.progress < 100), "progress was reported")
  assert.equal(jobs.cancel(started.id), true)
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual([state.journal.job(1).status, kept, jobs.count()], ["canceled", null, 0])
  // Run to the end: done, with what it measured
  const again = jobs.start(state, { kind: "reference", asset: "ref1" })
  while (state.journal.job(2).status === "running" || state.journal.job(2).status === "pending") await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual([state.journal.job(2).status, JSON.parse(state.journal.job(2).dispatch), kept], ["done", { asset: "ref1", traits: 10 }, { asset: "ref1" }])
  assert.equal(again.kind, "reference")
})

test("ET-RF2-08: nothing on the plan or make path measures a reference; only the job does (EH-73)", () => {
  const read = (file) => readFileSync(join(ROOT, "src/edit", file), "utf8")
  // The one call that measures a reference's DNA 2 is inside measureReference, which refuses anything but a job
  const host = read("host/projects.js")
  assert.equal(host.split("measure = extractDna2").length - 1, 1)
  assert.equal(host.split("extractDna2").length - 1, 2, "imported, and used once as measureReference's default")
  assert.match(host, /if \(!Number\.isInteger\(job\) \|\| job <= 0\) throw new EngineFailure\("input", "refused", "A reference is measured as its own job, never inside a plan or a make\."\)/)
  assert.match(read("host/jobs.js"), /projects\.measureReference\(state, request\.asset, \{ job: number, signal: controller\.signal, onStep \}\)/)
  // The Director, the recipes and the loop never import the measure; QG-16 measures the made cut, not the reference
  for (const file of ["director/plan.js", "director/revise.js", "recipes/reel.js", "recipes/assembly.js", "recipes/reference-look.js", "loop/make.js", "core/style-brief.js", "engine/reference2.js", "host/server.js"]) assert.doesNotMatch(read(file), /dna2\.js/, file)
  assert.match(read("gates/index.js"), /referenceFit\(kept, await extractDna2\(file, \{ run \}\)\)/)
  // No model anywhere in it (EDD-66 stays off): the measuring code and the brief ask nothing
  for (const file of ["engine/dna2.js", "engine/reference2.js", "core/style-brief.js", "gates/reference.js"]) assert.doesNotMatch(read(file), /\bask\(|director\/ask|api\.js|fetch\(/, file)
})

test("ET-RF2-REG-01: a server that says nothing of referenceIntent means off", async () => {
  const { createServer } = await import("node:http")
  for (const [answer, expected] of [[{ visuals: true }, false], [{ referenceIntent: "on" }, false], [{ referenceIntent: true }, true]]) {
    const server = createServer((_, res) => res.end(JSON.stringify(answer)))
    await new Promise((done) => server.listen(0, "127.0.0.1", done))
    try {
      assert.equal((await fetchFeatures({ url: `http://127.0.0.1:${server.address().port}`, token: "t" })).referenceIntent, expected)
    } finally {
      await new Promise((done) => server.close(done))
    }
  }
  assert.equal((await fetchFeatures({ url: "http://127.0.0.1:9", token: "t" })).referenceIntent, false)
})

test("ET-RF2-REG-01, ET-TP-REG-01: off, the Host has no route, no flag and drops the brief's key; on, it keeps the key and starts the measure as a job", async () => {
  const { ensureHost, stopHost } = await import("../src/edit/host/client.js")
  const { hostHeaders, socketPath } = await import("../src/edit/host/paths.js")
  const { startFakeKriya } = await import("./fake-kriya.js")
  for (const referenceIntent of [false, true]) {
    const fake = await startFakeKriya({ features: { visuals: false, playbooks: false, mediaSearch: false, motion: true, customMotion: false, assembly: false, livePreview: false, intent: false, craft: false, typeKit: false, referenceIntent } })
    const home = realpathSync(mkdtempSync(join(tmpdir(), "kh-")))
    try {
      const login = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "login", "--url", fake.url, "--no-browser"], { env: { ...process.env, KRIYA_HOME: home }, stdio: "ignore" })
      assert.equal(await new Promise((done) => login.on("exit", done)), 0)
      const bin = join(home, "bin")
      const folder = join(home, "work", "film")
      mkdirSync(folder, { recursive: true })
      mkdirSync(bin)
      writeFileSync(join(bin, "ffmpeg"), `#!/bin/sh\ncase "$*" in\n*-filters*) echo " .S. noise V->V x";;\n*-encoders*) echo " V....D libx264 x";;\n*-version*) echo "ffmpeg version 9.0.2";;\n*) exit 1;;\nesac\n`)
      writeFileSync(join(bin, "ffprobe"), `#!/bin/sh\necho '{"streams":[{"index":0,"codec_type":"video","width":640,"height":360,"r_frame_rate":"30/1","avg_frame_rate":"30/1","duration_ts":90,"time_base":"1/30","color_primaries":"bt709","color_transfer":"bt709","color_space":"bt709","color_range":"tv"}],"format":{"format_name":"mov","duration":"3.000000"}}'\n`)
      for (const tool of ["ffmpeg", "ffprobe"]) chmodSync(join(bin, tool), 0o755)
      const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: join(home, "work"), KRIYA_EDIT_IDLE_MS: "60000", PATH: `${bin}:${process.env.PATH}` }
      await ensureHost({ env, home })
      const call = (method, path, body) =>
        new Promise((done, fail) => {
          const req = request({ socketPath: socketPath(home), method, path, headers: { ...hostHeaders(home), "content-type": "application/json" } }, (res) => {
            const chunks = []
            res.on("data", (chunk) => chunks.push(chunk))
            res.on("end", () => done({ ...JSON.parse(Buffer.concat(chunks).toString() || "{}"), status: res.statusCode }))
          })
          req.on("error", fail)
          req.end(body === undefined ? undefined : JSON.stringify(body))
        })
      const { id } = await call("POST", "/projects", { name: "Film", folder })
      for (const name of ["take.mov", "ref.mov"]) writeFileSync(join(folder, name), name)
      await call("POST", `/projects/${id}/assets`, { path: join(folder, "take.mov") })
      const ref = await call("POST", `/projects/${id}/upload?name=ref.mov&as=reference`, undefined)
      const refId = ref.id ?? (await call("GET", `/projects/${id}`)).project.assets.find((a) => a.kind === "reference")?.id
      const opened = await call("GET", `/projects/${id}`)
      assert.equal("referenceIntent" in opened, referenceIntent, "the project view says so only with the switch on")
      const reference = opened.project.assets.find((a) => a.kind === "reference")
      const briefed = reference ? await call("GET", `/projects/${id}/references/${reference.id}/brief`) : { status: 404 }
      const measure = reference ? await call("POST", `/projects/${id}/references/${reference.id}/measure`) : { status: 404 }
      if (reference) {
        if (referenceIntent) {
          assert.deepEqual([briefed.status, briefed.brief], [200, undefined], "not measured yet: asking for a brief measures nothing")
          assert.deepEqual([measure.status, measure.kind, measure.asset], [200, "reference", reference.id])
        } else assert.deepEqual([briefed.status, measure.status], [404, 404])
      }
      // The make's brief: the key reaches the job only with the switch on, and only a reference id and known trait ids
      const job = await call("POST", `/projects/${id}/make`, { brief: { styleBrief: { ref: reference?.id ?? "ref1", off: ["captions", "x; rm -rf", "captions"], lines: [{ id: "pace", set: { punches: 99 } }] } } })
      assert.equal(job.status, 200)
      const db = new DatabaseSync(join(home, "edit", id, "journal.sqlite"), { readOnly: true })
      const recorded = JSON.parse(db.prepare("select request from jobs where kind = 'make' order by id desc limit 1").get().request).brief
      db.close()
      assert.deepEqual(recorded.styleBrief, referenceIntent ? { ref: reference?.id ?? "ref1", off: ["captions"] } : undefined)
      void refId
    } finally {
      await stopHost(home)
      await fake.close()
    }
  }
})

test("ET-TP-REG-01, ET-TP-REG-02: a brief with no reference style makes the operations it made before TP6, to the hash, and no new key appears", async () => {
  const recorded = JSON.parse(readFileSync(join(ROOT, "tests", "edit", "pre-tp2-make.golden.json"), "utf8"))
  const extra = recorded.answers.find((a) => a.task === "brief_extra")
  const brief = { ...(extra ? JSON.parse(extra.value) : {}), ...recorded.request.brief }
  assert.equal("lut" in brief || "fx" in brief || "styleBrief" in brief, false)
  const made = await planReel({ project: recorded.before, index: recorded.index, asset: recorded.request.asset, ask: replayAsk(recorded.answers.filter((a) => a.task !== "brief_extra")), brief })
  const { head: _h, history: _y, ...before } = recorded.after
  assert.equal(hashProject(made.project), hashProject(before), "the same project, to the hash, as the make recorded before any TP code")
  assert.equal(made.ops.some((op) => op.op === "apply_lut" || op.op === "add_adjustment"), false)
  // Applying a style brief with every line unticked changes nothing either
  const none = applyStyleBrief(brief, styleBrief(dnaFrom(measured()), can()), [...TRAIT_IDS], { seconds: 30 })
  assert.deepEqual([none.brief, none.kept, none.colourMatch], [brief, [], false])
})
