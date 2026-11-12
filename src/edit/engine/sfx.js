// Sound effects made by code (2026-11-09): a whoosh or a pop for cuts, a riser into the
// intro, a hit for a cold open's end. Written sample by sample, so no one else's sound is
// in them, and each knows where its peak is: add_sfx lands that peak on the cut.

import { measuredPeak, writeWav } from "./music-bed.js"

export { measuredPeak }

const RATE = 48_000
const FLICKS = 705_600_000

/** Each effect: its length and where its loudest moment falls, in seconds. */
export const SFX = {
  whoosh: { seconds: 0.7, peak: 0.42 },
  pop: { seconds: 0.14, peak: 0.01 },
  riser: { seconds: 1.6, peak: 1.55 },
  hit: { seconds: 0.9, peak: 0.02 },
}

// TP10 (CRAFT_UPGRADE §8, EDD-69): sixteen more, still written by code. Each is a tone or a noise under
// an envelope; its peak is measured from its own samples when it is written, so add_sfx lands the loudest
// moment where it is asked. The four above stay byte for byte what they were
const bell = (f, t) => Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(2 * Math.PI * f * 2.76 * t) + 0.25 * Math.sin(2 * Math.PI * f * 5.4 * t)
const gauss = (t, at, width) => Math.exp(-(((t - at) / width) ** 2))
const phaseOf = (from, to, t, seconds) => (2 * Math.PI * from * seconds * ((to / from) ** (t / seconds) - 1)) / Math.log(to / from)
export const MORE_SFX = {
  click: { seconds: 0.05, group: "cut", make: (t, x, noise) => noise() * Math.exp(-t * 900) },
  tick: { seconds: 0.08, group: "cut", make: (t) => Math.sin(2 * Math.PI * 2000 * t) * Math.exp(-t * 120) },
  snap: { seconds: 0.12, group: "cut", make: (t, x, noise) => (noise() * 0.6 + Math.sin(2 * Math.PI * 1500 * t)) * Math.exp(-t * 70) },
  blip: { seconds: 0.09, group: "cut", make: (t) => Math.sin(2 * Math.PI * 1200 * t) * Math.min(1, t * 400) * Math.exp(-t * 40) },
  swish: { seconds: 0.4, group: "cut", make: (t, x, noise, low) => low(noise(), 0.05 + 0.4 * gauss(t, 0.2, 0.08)) * gauss(t, 0.2, 0.07) },
  zap: { seconds: 0.25, group: "cut", make: (t) => Math.sin(phaseOf(2000, 200, t, 0.25)) * Math.min(1, t * 300) * Math.exp(-t * 14) },
  ding: { seconds: 1, group: "accent", make: (t) => bell(1760, t) * Math.min(1, t * 500) * Math.exp(-t * 4) },
  chime: { seconds: 1.4, group: "accent", make: (t) => (bell(1046.5, t) + bell(1318.5, t) * 0.7) * Math.min(1, t * 500) * Math.exp(-t * 3) },
  shimmer: { seconds: 0.8, group: "accent", make: (t, x, noise, low) => (noise() - low(noise(), 0.2)) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 18 * t)) * gauss(t, 0.4, 0.15) },
  thud: { seconds: 0.5, group: "intro", make: (t) => Math.sin(2 * Math.PI * (55 + 40 * Math.exp(-t * 30)) * t) * Math.min(1, t * 400) * Math.exp(-t * 9) },
  boom: { seconds: 1.4, group: "intro", make: (t, x, noise) => (Math.sin(2 * Math.PI * (40 + 70 * Math.exp(-t * 12)) * t) + noise() * Math.exp(-t * 40) * 0.3) * Math.min(1, t * 300) * Math.exp(-t * 3.5) },
  drop: { seconds: 0.7, group: "intro", make: (t) => Math.sin(phaseOf(800, 80, t, 0.7)) * Math.min(1, t * 200) * Math.exp(-t * 4) },
  swell: { seconds: 1.2, group: "intro", make: (t, x, noise, low) => (low(noise(), 0.05 + 0.3 * x) * 0.7 + 0.3 * Math.sin(2 * Math.PI * 220 * t)) * x ** 2 * (t < 1.15 ? 1 : Math.max(0, 1 - (t - 1.15) / 0.05)) },
  sweepUp: { seconds: 0.6, group: "intro", make: (t) => Math.sin(phaseOf(300, 2000, t, 0.6)) * gauss(t, 0.45, 0.12) },
  sweepDown: { seconds: 0.6, group: "cut", make: (t) => Math.sin(phaseOf(2000, 300, t, 0.6)) * gauss(t, 0.15, 0.1) },
  rumble: { seconds: 1.2, group: "intro", make: (t, x, noise, low) => low(noise(), 0.01) * 6 * gauss(t, 0.6, 0.3) },
}
/** Every sound Kriya can write, by kind: the first four, then TP10's. */
export const SOUNDS = [...Object.keys(SFX), ...Object.keys(MORE_SFX)]
/** Kinds for the cut, for an intro and as accents, as the make and the plan offer them (TP10, with editing.craft). */
export const CUT_SOUNDS = ["whoosh", "pop", ...Object.entries(MORE_SFX).filter(([, s]) => s.group === "cut").map(([k]) => k)]
export const INTRO_SOUNDS = ["riser", "hit", ...Object.entries(MORE_SFX).filter(([, s]) => s.group === "intro").map(([k]) => k)]


/**
 * Writes one effect as a stereo WAV.
 * @returns {{ file: string, peak: number }} peak in flicks from the file's start
 */
export function writeSfx(file, kind) {
  if (Object.hasOwn(MORE_SFX, kind)) return writeMore(file, kind)
  const spec = SFX[kind]
  if (!spec) throw new RangeError(`There is no "${kind}" sound.`)
  const total = Math.round(spec.seconds * RATE)
  const left = new Float32Array(total)
  const right = new Float32Array(total)
  let seed = 0x2545f491
  const noise = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1
  let lowL = 0
  let lowR = 0
  for (let i = 0; i < total; i++) {
    const t = i / RATE
    const x = t / spec.seconds // 0 to 1 through the effect
    let l = 0
    let r = 0
    if (kind === "whoosh" || kind === "riser") {
      // Noise through a one-pole low-pass that opens and closes: the sweep you hear
      const open = kind === "whoosh" ? Math.sin(Math.PI * Math.min(1, t / spec.peak / 2 + (t > spec.peak ? 0.5 * ((t - spec.peak) / (spec.seconds - spec.peak)) : 0))) : x * x
      const k = 0.02 + 0.5 * open
      lowL += k * (noise() - lowL)
      lowR += k * (noise() - lowR)
      const env = kind === "whoosh" ? Math.exp(-(((t - spec.peak) / 0.16) ** 2)) : x ** 2.2 * (t < spec.peak ? 1 : Math.max(0, 1 - (t - spec.peak) / 0.05))
      // A riser also climbs in pitch
      const tone = kind === "riser" ? 0.35 * Math.sin(2 * Math.PI * (200 + 900 * x * x) * t) : 0
      // The whoosh moves from left to right as it passes
      const pan = kind === "whoosh" ? x : 0.5
      l = (lowL + tone) * env * (1 - pan * 0.6)
      r = (lowR + tone) * env * (0.4 + pan * 0.6)
    } else if (kind === "pop") {
      const env = Math.exp(-t * 60)
      l = r = Math.sin(2 * Math.PI * (900 - 600 * x) * t) * env
    } else {
      // Hit: a deep falling thump with a short noisy attack
      const env = Math.exp(-t * 6)
      l = r = Math.sin(2 * Math.PI * (40 + 90 * Math.exp(-t * 25)) * t) * env + noise() * Math.exp(-t * 80) * 0.4
    }
    left[i] = l
    right[i] = r
  }
  writeWav(file, left, right)
  return { file, peak: Math.round(spec.peak * FLICKS) }
}

function writeMore(file, kind) {
  const spec = MORE_SFX[kind]
  const total = Math.round(spec.seconds * RATE)
  const left = new Float32Array(total)
  const right = new Float32Array(total)
  let seed = 0x6d2b79f5
  const noise = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1
  let state = 0
  const low = (input, k) => (state += k * (input - state))
  for (let i = 0; i < total; i++) {
    const t = i / RATE
    const v = spec.make(t, t / spec.seconds, noise, low)
    // A short fade at the very end, so no sound stops on a click
    const tail = Math.min(1, (total - i) / (RATE * 0.004))
    left[i] = v * tail
    right[i] = v * tail
  }
  writeWav(file, left, right)
  return { file, peak: Math.round(measuredPeak(left, right) * FLICKS) }
}
