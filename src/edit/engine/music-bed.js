// A music bed made by code (2026-11-09): chords, bass and a light beat, written sample by
// sample to a WAV. Nobody else's recording is in it, so it carries no licence question,
// and the same mood and length always give the same file. It goes through the ED9 path
// like any song: its beats are indexed, it's fitted on downbeats and ducked under speech.

import { writeFileSync } from "node:fs"

const RATE = 48_000

/** Moods: tempo, chords (MIDI notes), and how much beat. Data only. */
export const MOODS = {
  calm: { bpm: 80, chords: [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]], kick: 0, hat: 0, pulse: 0.15 },
  upbeat: { bpm: 112, chords: [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]], kick: 0.55, hat: 0.12, pulse: 0.35 },
  warm: { bpm: 92, chords: [[48, 52, 55, 59], [45, 48, 52, 55], [53, 57, 60, 64], [55, 59, 62, 65]], kick: 0.3, hat: 0.06, pulse: 0.25 },
}

// TP10 (CRAFT_UPGRADE §8, EDD-69): seven more moods, still data, still written by code. Their own table,
// offered only with editing.craft on, so the plan's schema and the Studio's choices are what they were without it
export const MORE_MOODS = {
  bright: { bpm: 120, chords: [[60, 64, 67], [55, 59, 62], [57, 60, 64], [53, 57, 60]], kick: 0.5, hat: 0.14, pulse: 0.3 },
  tense: { bpm: 96, chords: [[57, 60, 63], [57, 60, 64], [53, 56, 60], [52, 55, 59]], kick: 0.4, hat: 0.05, pulse: 0.5 },
  dreamy: { bpm: 70, chords: [[52, 55, 59, 62], [48, 52, 55, 59], [53, 57, 60, 64], [50, 53, 57, 60]], kick: 0, hat: 0.03, pulse: 0.1 },
  driving: { bpm: 128, chords: [[50, 53, 57], [46, 50, 53], [48, 52, 55], [45, 48, 52]], kick: 0.65, hat: 0.1, pulse: 0.45 },
  playful: { bpm: 108, chords: [[60, 64, 67], [62, 65, 69], [64, 67, 71], [65, 69, 72]], kick: 0.35, hat: 0.1, pulse: 0.3 },
  epic: { bpm: 84, chords: [[45, 52, 57], [41, 48, 53], [48, 55, 60], [43, 50, 55]], kick: 0.6, hat: 0, pulse: 0.2 },
  lofi: { bpm: 76, chords: [[50, 53, 57, 60], [55, 59, 62, 65], [48, 52, 55, 59], [45, 48, 52, 55]], kick: 0.45, hat: 0.08, pulse: 0.2 },
}
export const ALL_MOODS = { ...MOODS, ...MORE_MOODS }

const hz = (note) => 440 * 2 ** ((note - 69) / 12)

/**
 * Writes a stereo 16-bit WAV of `seconds` (plus a short tail) for `mood`.
 * @returns {{ file: string, seconds: number, bpm: number }}
 */
export function writeMusicBed(file, { mood = "calm", seconds = 60, bpm } = {}) {
  // A music reference's tempo can set the bed's (classified by analyseReference)
  const spec = { ...(ALL_MOODS[mood] ?? MOODS.calm), ...(bpm >= 60 && bpm <= 180 ? { bpm: Math.round(bpm) } : {}) }
  const total = Math.ceil((Math.max(5, seconds) + 2) * RATE)
  const beat = (60 / spec.bpm) * RATE // samples a beat
  const bar = beat * 4
  const chordLength = bar * 2 // each chord holds two bars
  const left = new Float32Array(total)
  const right = new Float32Array(total)
  let seed = 0x9e3779b9
  const noise = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1
  let lastNoise = 0
  for (let i = 0; i < total; i++) {
    const t = i / RATE
    const c = Math.floor(i / chordLength) % spec.chords.length
    const inChord = (i % chordLength) / chordLength
    // A soft swell into each chord and out of it, so changes never click
    const swell = Math.min(1, inChord * 12) * Math.min(1, (1 - inChord) * 12)
    let l = 0
    let r = 0
    for (const note of spec.chords[c]) {
      const f = hz(note)
      // Two slightly detuned voices per note: one leans left, one right
      const a = Math.sin(2 * Math.PI * f * 0.998 * t) + 0.3 * Math.sin(2 * Math.PI * f * 2 * t)
      const b = Math.sin(2 * Math.PI * f * 1.002 * t) + 0.25 * Math.sin(2 * Math.PI * f * 3 * t)
      l += a
      r += b
    }
    const pad = (0.1 * swell) / spec.chords[c].length
    l *= pad
    r *= pad
    // Bass: the chord's root an octave down, pulsing on the beat
    const inBeat = (i % beat) / beat
    const bass = Math.sin(2 * Math.PI * hz(spec.chords[c][0] - 12) * t) * (1 - spec.pulse * inBeat) * 0.12 * swell
    l += bass
    r += bass
    // Kick on every beat: a falling sine with a fast decay
    if (spec.kick) {
      const k = (i % beat) / RATE
      const kick = Math.sin(2 * Math.PI * (50 + 70 * Math.exp(-k * 30)) * k) * Math.exp(-k * 18) * spec.kick
      l += kick
      r += kick
    }
    // A closed hat on the off-beat: high-passed noise, very short
    if (spec.hat) {
      const off = ((i + beat / 2) % beat) / RATE
      const white = noise()
      const bright = white - lastNoise
      lastNoise = white
      const hat = bright * Math.exp(-off * 90) * spec.hat
      l += hat * 0.9
      r += hat
    }
    // Fade in over 1.5 s, out over the last 2 s
    const fade = Math.min(1, t / 1.5) * Math.min(1, (total - i) / (2 * RATE))
    left[i] = l * fade
    right[i] = r * fade
  }
  writeWav(file, left, right)
  return { file, seconds: total / RATE, bpm: spec.bpm }
}

/**
 * An accent in a mood's own key (TP10): the bed's first chord struck once over a soft low thump, for a
 * make to land on the cut's joins. Its peak is measured from its samples, as the sounds' are, and silence
 * is put before it so the peak falls on a whole frame of `fps`: the timeline places a sound on frames, so
 * a peak between frames would land up to a frame early (found by TP10's exit test: 37 ms on one mood).
 * @returns {{ file: string, peak: number }} peak in seconds from the file's start
 */
export function writeAccent(file, mood = "calm", { fps = { n: 30, d: 1 } } = {}) {
  const spec = ALL_MOODS[mood] ?? MOODS.calm
  const total = Math.round(1.2 * RATE)
  const left = new Float32Array(total)
  const right = new Float32Array(total)
  for (let i = 0; i < total; i++) {
    const t = i / RATE
    const attack = Math.min(1, t * 100) // 10 ms: struck, but no click at the cut it lands on (QG-05)
    let v = 0
    for (const note of spec.chords[0]) v += Math.sin(2 * Math.PI * hz(note) * t) + 0.3 * Math.sin(2 * Math.PI * hz(note) * 2 * t)
    // The chord rings under a struck thump: the thump is the clear loudest moment, so the hit means one instant
    v = (v / spec.chords[0].length) * attack * Math.exp(-t * 4) * 0.45
    v += Math.sin(2 * Math.PI * (70 + 60 * Math.exp(-t * 30)) * t) * attack * Math.exp(-t * 18)
    const tail = Math.min(1, (total - i) / (RATE * 0.01))
    left[i] = right[i] = v * tail
  }
  // The loudest 5 ms, as the sounds measure theirs: what a listener hears as the hit; moved onto a frame
  const heard = measuredPeak(left, right)
  const frame = fps.d / fps.n
  const pad = Math.round((Math.ceil(heard / frame - 1e-9) * frame - heard) * RATE)
  const padded = (channel) => Float32Array.from([...new Float32Array(pad), ...channel])
  writeWav(file, padded(left), padded(right))
  return { file, peak: heard + pad / RATE }
}

/** The loudest 5 ms of a pair of channels, as the time of that window's middle in seconds. */
export function measuredPeak(left, right) {
  const window = Math.round(RATE / 200)
  let best = 0
  let at = 0
  for (let start = 0; start + window <= left.length; start += window) {
    let sum = 0
    for (let i = start; i < start + window; i++) sum += left[i] * left[i] + right[i] * right[i]
    if (sum > best) [best, at] = [sum, start + window / 2]
  }
  return at / RATE
}

/** A stereo 16-bit WAV at 48 kHz, peaking at about -6 dBFS (the mix sets the level). */
export function writeWav(file, left, right) {
  const total = left.length
  let peak = 0
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]))
  const scale = peak ? 0.5 / peak : 0
  const data = Buffer.alloc(total * 4)
  for (let i = 0; i < total; i++) {
    data.writeInt16LE(Math.round(left[i] * scale * 32767), i * 4)
    data.writeInt16LE(Math.round(right[i] * scale * 32767), i * 4 + 2)
  }
  const head = Buffer.alloc(44)
  head.write("RIFF", 0)
  head.writeUInt32LE(36 + data.length, 4)
  head.write("WAVEfmt ", 8)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(2, 22)
  head.writeUInt32LE(RATE, 24)
  head.writeUInt32LE(RATE * 4, 28)
  head.writeUInt16LE(4, 32)
  head.writeUInt16LE(16, 34)
  head.write("data", 36)
  head.writeUInt32LE(data.length, 40)
  writeFileSync(file, Buffer.concat([head, data]))
}
