// The audio plan (EDIT_ENGINE §10, ED9): pure decisions the render follows. Which bus
// a sound is on, where the speech is on the output, the music's path through its bars
// to the length, the duck's gain curve, and the loudness each deliverable aims at.

import { scaleFlicks } from "./time.js"

const FLICKS = 705_600_000
const ms = (n) => n * 705_600

/** Buses by track role. The dialogue bus also takes the base clips' own sound. */
export const BUSES = ["dialogue", "music", "sfx", "ambience"]
export const busOf = (role) => (role === "music" ? "music" : role === "sfx" ? "sfx" : role === "ambience" ? "ambience" : "dialogue")

/**
 * Loudness targets per deliverable preset. EBU R128 (−23 LUFS, −1 dBTP) and Apple's
 * podcast spec (−16 LUFS, −1 dBTP) are published; the social and YouTube values are
 * the level those services are commonly measured to normalise to, not a published spec.
 */
export const LOUDNESS_TARGETS = {
  "reel-9x16": { lufs: -14, tp: -1, source: "common target, not a platform spec" },
  "short-9x16": { lufs: -14, tp: -1, source: "common target, not a platform spec" },
  "tiktok-9x16": { lufs: -14, tp: -1, source: "common target, not a platform spec" },
  youtube: { lufs: -14, tp: -1, source: "common target, not a platform spec" },
  podcast: { lufs: -16, tp: -1, source: "Apple Podcasts specification" },
  broadcast: { lufs: -23, tp: -1, source: "EBU R128" },
}

// shortcut: untuned defaults (EDITOR_WORKFLOWS §5, §11); recipes may set their own
export const DUCK_DEFAULTS = { depth: -12, attack: ms(80), release: ms(300) }
export const SFX_UNDER_VOICE = 6 // LU a sound effect sits under the measured voice
export const MUSIC_UNDER_VOICE = 12 // LU the music bed sits under it, before the duck
export const SFX_SPACING = ms(1000) // rule of restraint: no two effects closer than this
export const CROSSFADE = ms(50) // equal-power, at each music edit

/**
 * Where speech is on the output: each dialogue item's words, mapped through its timing.
 * With no words for an item, all of it counts as speech (so music still ducks).
 * @returns {{ at: number, end: number }[]} merged, sorted
 */
export function speechSpans(items, words = [], { join = ms(300) } = {}) {
  const spans = []
  for (const item of items) {
    if (busOf(item.role) !== "dialogue") continue
    const rate = { n: item.speed?.d ?? 1, d: item.speed?.n ?? 1 }
    const own = words.filter((w) => w.asset === item.asset && w.end > item.in && w.start < item.out)
    if (own.length === 0) spans.push({ at: item.at, end: item.end })
    for (const w of own) {
      const at = item.at + scaleFlicks(Math.max(w.start, item.in) - item.in, rate)
      const end = item.at + scaleFlicks(Math.min(w.end, item.out) - item.in, rate)
      if (end > at) spans.push({ at, end: Math.min(end, item.end) })
    }
  }
  spans.sort((a, b) => a.at - b.at)
  const merged = []
  for (const span of spans) {
    const last = merged.at(-1)
    if (last && span.at - last.end <= join) last.end = Math.max(last.end, span.end)
    else merged.push({ ...span })
  }
  return merged
}

/**
 * The duck's gain over time, sampled at `rate`: 1 away from speech, 10^(depth/20) during
 * it, with linear ramps of `attack` before and `release` after.
 * @returns {Float32Array}
 */
export function duckEnvelope(spans, { duration, depth, attack, release, rate = 1000 }) {
  const n = Math.max(1, Math.ceil((duration / FLICKS) * rate))
  const floor = 10 ** (depth / 20)
  const out = new Float32Array(n).fill(1)
  const toSample = (t) => (t / FLICKS) * rate
  for (const { at, end } of spans) {
    const a0 = toSample(at - attack)
    const a1 = toSample(at)
    const r0 = toSample(end)
    const r1 = toSample(end + release)
    for (let i = Math.max(0, Math.floor(a0)); i < Math.min(n, Math.ceil(r1) + 1); i++) {
      const duck = i < a1 ? (i - a0) / Math.max(1e-9, a1 - a0) : i <= r0 ? 1 : 1 - (i - r0) / Math.max(1e-9, r1 - r0)
      const d = Math.min(1, Math.max(0, duck))
      out[i] = Math.min(out[i], 1 - (1 - floor) * d)
    }
  }
  return out
}

/**
 * The music's path to a length (EDITOR_WORKFLOWS §5): whole bars out of the middle, or
 * bars repeated, joined on downbeats, so it starts on its start and ends on its ending.
 * The ending lands on the last frame: any extra comes off the head.
 * @param {{ from: number, to: number, downbeats: number[], bars: { start: number, energy: number }[], target: number, crossfade?: number }} input source flicks
 * @returns {{ segments: { in: number, out: number }[], length: number } | null} null: no bars to cut on
 */
export function fitMusic({ from, to, downbeats, bars = [], target, crossfade = CROSSFADE }) {
  const downs = downbeats.filter((t) => t > from && t < to).sort((a, b) => a - b)
  const length = (segments) => segments.reduce((sum, s) => sum + (s.out - s.in), 0) - crossfade * (segments.length - 1)
  if (downs.length < 4) return null
  const barLength = Math.min(...downs.slice(1).map((t, i) => t - downs[i]))
  const whole = [{ in: from, out: to }]
  if (length(whole) >= target && length(whole) - target < barLength) return headTrim(whole, target, crossfade)
  const energy = (t) => bars.find((b) => b.start === t)?.energy ?? 0
  // Keep the first and last bar whole: the intro and the ending
  const inner = downs.slice(1, -1)
  let best = null
  const consider = (segments, a, b) => {
    const total = length(segments)
    // Within a bar of the length: the rest comes off the head, inside the first piece
    if (total < target || total - target >= barLength) return
    // Shortest that still covers the picture, then the smoothest join
    const cost = total - target + ms(200) * Math.abs(energy(a) - energy(b))
    if (!best || cost < best.cost) best = { cost, segments }
  }
  if (length(whole) > target) {
    for (let i = 0; i < inner.length; i++) for (let k = i + 1; k < inner.length; k++) consider([{ in: from, out: inner[i] }, { in: inner[k], out: to }], inner[i], inner[k])
  } else {
    // Too short: repeat a run of bars, as often as needed
    for (let i = 0; i < inner.length; i++) {
      for (let k = i + 1; k < inner.length; k++) {
        const loop = inner[k] - inner[i] - crossfade
        if (loop <= 0) continue
        const times = Math.max(1, Math.ceil((target - length(whole)) / loop))
        if (times > 64) continue
        const segments = [{ in: from, out: inner[k] }, ...Array.from({ length: times - 1 }, () => ({ in: inner[i], out: inner[k] })), { in: inner[i], out: to }]
        consider(segments, inner[k], inner[i])
      }
    }
  }
  return best ? headTrim(best.segments, target, crossfade) : null
}

function headTrim(segments, target, crossfade) {
  const total = segments.reduce((sum, s) => sum + (s.out - s.in), 0) - crossfade * (segments.length - 1)
  const extra = total - target
  const out = segments.map((s) => ({ ...s }))
  if (extra > 0 && out[0].out - out[0].in > extra + crossfade) out[0].in += extra
  return { segments: out, length: Math.min(total, target) }
}

/** Rule of restraint (EDITOR_WORKFLOWS §11): effects closer than the spacing are reported. */
export function crowdedEffects(items, spacing = SFX_SPACING) {
  const peaks = items.filter((item) => busOf(item.role) === "sfx").map((item) => ({ clip: item.clip, t: item.at + (item.peak ?? 0) })).sort((a, b) => a.t - b.t)
  const issues = []
  for (let i = 1; i < peaks.length; i++) if (peaks[i].t - peaks[i - 1].t < spacing) issues.push({ code: "sfx_crowded", clip: peaks[i].clip, message: "two sound effects land too close together; the second one crowds the first" })
  return issues
}

/** The voice-clean chain (EDIT_ENGINE §10) with FFmpeg's own filters; strength 0 to 1. */
export function voiceClean(strength = 0.5) {
  const s = Math.min(1, Math.max(0, strength))
  return [
    "highpass=f=80",
    `afftdn=nr=${(6 + 18 * s).toFixed(1)}:nf=-50:tn=1`,
    "equalizer=f=250:t=q:w=1:g=-2",
    "equalizer=f=3500:t=q:w=1.2:g=2",
    "deesser=i=0.3:m=0.5:f=0.5",
    "acompressor=threshold=0.1:ratio=3:attack=10:release=150:makeup=1.5",
  ]
}
