// Edit DNA (EDITOR_WORKFLOWS §4, EDD-23): "make it like this" by measuring a reference
// the person supplies, as numbers only. Pace (shot lengths and how they change across
// the video), structure (first cut, last shot), colour (OKLab mean and covariance, a
// lightness histogram, contrast, saturation), where captions sit, and sound (loudness,
// range, peak). Frames and samples are read through a pipe, measured and dropped: no
// pixel, word or sound of the reference is kept, so none can reach an output.
// Not measured yet: caption wording or fonts (never kept), motion feel (needs tracked
// boxes), music level against speech (needs stems).

import { readShots, shotArgs } from "../index/layers/shots.js"
import { readFrames, statsOf } from "./color.js"
import { loudnessArgs, readLoudness } from "./loudness.js"
import { probe } from "./probe.js"
import { runTool } from "./tool.js"

const FLICKS = 705_600_000
export const DNA_VERSION = "dna-1"
const FRAMES = 24
const [W, H] = [160, 90]
const round = (value, places = 3) => (value === null || value === undefined ? null : Math.round(value * 10 ** places) / 10 ** places)

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]

/** Pace from shot lengths in seconds: the spread, and the median length in each tenth of the running time. */
export function paceOf(shots, seconds) {
  const lengths = shots.map((s) => s.length)
  const sorted = [...lengths].sort((a, b) => a - b)
  const curve = Array.from({ length: 10 }, (_, tenth) => {
    const [from, to] = [(tenth * seconds) / 10, ((tenth + 1) * seconds) / 10]
    const inside = shots.filter((s) => s.start + s.length / 2 >= from && s.start + s.length / 2 < to).map((s) => s.length).sort((a, b) => a - b)
    return round(inside.length ? quantile(inside, 0.5) : null)
  })
  return { shots: lengths.length, cutsPerMinute: round(((lengths.length - 1) / Math.max(seconds, 1)) * 60), median: round(quantile(sorted, 0.5)), p10: round(quantile(sorted, 0.1)), p90: round(quantile(sorted, 0.9)), curve }
}

/**
 * Where burned-in captions sit, as a share of the frame height: rows where bright,
 * sharp-edged pixels (white text on a picture) recur across the sampled frames. Only
 * the band's position is kept, never what it says.
 * @param {Uint8Array} rgb frames of W × H RGB24
 */
export function captionBand(rgb, width = W, height = H) {
  const frames = Math.floor(rgb.length / (width * height * 3))
  const hits = new Array(height).fill(0)
  for (let f = 0; f < frames; f++) {
    for (let y = 0; y < height; y++) {
      let edges = 0
      for (let x = 1; x < width; x++) {
        const i = ((f * height + y) * width + x) * 3
        const bright = rgb[i] > 200 && rgb[i + 1] > 200 && rgb[i + 2] > 200
        const step = Math.abs(rgb[i] - rgb[i - 3]) + Math.abs(rgb[i + 1] - rgb[i - 2]) + Math.abs(rgb[i + 2] - rgb[i - 1])
        if (bright && step > 240) edges++
      }
      if (edges >= width / 40) hits[y]++
    }
  }
  const rows = hits.map((n, y) => (n >= Math.max(1, frames * 0.3) ? y : -1)).filter((y) => y >= 0)
  if (!rows.length) return { present: false, top: null, bottom: null, frames: 0 }
  // The densest run of rows is the band
  const runs = []
  for (const y of rows) runs.at(-1) && y - runs.at(-1).at(-1) <= 2 ? runs.at(-1).push(y) : runs.push([y])
  const band = runs.sort((a, b) => b.length - a.length)[0]
  return { present: true, top: round(band[0] / height), bottom: round((band.at(-1) + 1) / height), frames: round(Math.max(...band.map((y) => hits[y])) / frames) }
}

/**
 * Measures a reference video. Every value in the result is a number, a boolean or
 * null: checkDna proves it before anything keeps it.
 * @returns {Promise<object>} an EditDNA
 */
export async function extractDna(file, { run = runTool, signal } = {}) {
  const { facts } = await probe(file, { run })
  const seconds = (facts.duration ?? 0) / FLICKS
  if (!(seconds > 0)) throw new RangeError("This reference has no length to measure.")
  const shots = readShots(await run("ffmpeg", shotArgs(file), { signal, timeoutMs: 600_000 }), facts.duration).map((s) => ({ start: s.start / FLICKS, length: (s.end - s.start) / FLICKS }))
  const frames = facts.width ? await readFrames(file, { from: 0, to: seconds, frames: FRAMES, width: W, height: H, run, signal }) : null
  const colour = frames ? statsOf(frames, 4) : null
  const sound = facts.hasAudio === false ? null : await run("ffmpeg", loudnessArgs(file), { signal, timeoutMs: 600_000 })
  const range = sound ? [...sound.matchAll(/lavfi\.r128\.LRA=(-?[\d.]+)/g)].at(-1)?.[1] : null
  const loud = sound ? readLoudness(sound) : null
  const dna = {
    kind: "edit-dna",
    version: DNA_VERSION,
    seconds: round(seconds),
    pace: paceOf(shots, seconds),
    structure: { firstCut: round(shots.length > 1 ? shots[1].start : null), lastShot: round(shots.at(-1)?.length ?? null) },
    colour: colour && { mean: colour.mean.map((v) => round(v, 4)), cov: colour.cov.map((row) => row.map((v) => round(v, 5))), luma: colour.luma.map((v) => round(v, 4)), contrast: round(colour.contrast, 4), saturation: round(colour.saturation, 4) },
    captions: frames ? captionBand(frames) : null,
    sound: loud && { lufs: round(loud.integrated, 1), range: round(range === undefined || range === null ? null : Number(range), 1), truePeak: round(loud.truePeak, 1) },
  }
  return checkDna(dna)
}

// The shape an EditDNA may have: numbers only (EDD-23). Anything else is refused, so
// no text, path or pixel from a reference can ride along
const NUM = "num"
const SHAPE = {
  kind: "edit-dna",
  version: DNA_VERSION,
  seconds: NUM,
  pace: { shots: NUM, cutsPerMinute: NUM, median: NUM, p10: NUM, p90: NUM, curve: [NUM, 10] },
  structure: { firstCut: NUM, lastShot: NUM },
  colour: { mean: [NUM, 3], cov: [[NUM, 3], 3], luma: [NUM, 16], contrast: NUM, saturation: NUM },
  captions: { present: "bool", top: NUM, bottom: NUM, frames: NUM },
  sound: { lufs: NUM, range: NUM, truePeak: NUM },
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
  } else {
    if (typeof value !== "object" || Array.isArray(value)) throw new RangeError(`${path} must be an object`)
    const extra = Object.keys(value).find((key) => !(key in shape))
    if (extra) throw new RangeError(`${path}.${extra} isn't part of an EditDNA`)
    for (const key of Object.keys(shape)) conforms(value[key], shape[key], `${path}.${key}`)
  }
}

/** Throws unless `dna` is numbers only, in the EditDNA shape; returns it. */
export function checkDna(dna) {
  conforms(dna, SHAPE, "dna")
  return dna
}

/**
 * The reference's pacing as a recipe's pace: the longest a picture holds is the
 * reference's median shot, and the opening and closing tenths keep their speed
 * against it. Clamped to what a talk can carry (2 to 30 s).
 * @returns {{ every: number, intro: number, close: number }} every in flicks
 */
export function paceFromDna(dna) {
  const { median, curve } = checkDna(dna).pace
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
  const known = curve.filter((v) => v !== null)
  if (median === null || !known.length) throw new RangeError("This reference has too few shots to take its pace from.")
  const at = (tenth) => curve[tenth] ?? median
  return { every: Math.round(clamp(median, 2, 30) * FLICKS), intro: round(clamp(at(0) / median, 0.3, 1.5)), close: round(clamp(at(9) / median, 0.3, 1.5)) }
}
