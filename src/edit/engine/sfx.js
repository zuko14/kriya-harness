// Sound effects made by code (2026-11-09): a whoosh or a pop for cuts, a riser into the
// intro, a hit for a cold open's end. Written sample by sample, so no one else's sound is
// in them, and each knows where its peak is: add_sfx lands that peak on the cut.

import { writeWav } from "./music-bed.js"

const RATE = 48_000
const FLICKS = 705_600_000

/** Each effect: its length and where its loudest moment falls, in seconds. */
export const SFX = {
  whoosh: { seconds: 0.7, peak: 0.42 },
  pop: { seconds: 0.14, peak: 0.01 },
  riser: { seconds: 1.6, peak: 1.55 },
  hit: { seconds: 0.9, peak: 0.02 },
}

/**
 * Writes one effect as a stereo WAV.
 * @returns {{ file: string, peak: number }} peak in flicks from the file's start
 */
export function writeSfx(file, kind) {
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
