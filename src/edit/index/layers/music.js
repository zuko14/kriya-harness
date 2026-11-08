// L12 Music v1 (PERCEPTION_AND_INDEX §2, ED9): beats, downbeats and bar energy from
// a sound file, by Kriya's own code: an onset envelope, the tempo by autocorrelation,
// beats by dynamic programming, downbeats by where the low end hits hardest.
// shortcut: 4/4 assumed and no learned model; beat_this (the Beats pack) replaces it for real music.

export const MUSIC_VERSION = "l12-1"
export const RATE = 11_025
export const HOP = 128
const FLICKS = 705_600_000
const FRAME_FLICKS = (HOP * FLICKS) / RATE // 8 192 000, exactly

export const musicArgs = (source) => ["-hide_banner", "-nostdin", "-loglevel", "error", "-protocol_whitelist", "file,pipe", "-i", source, "-vn", "-sn", "-dn", "-ac", "1", "-ar", String(RATE), "-f", "s16le", "pipe:1"]

/** Collects s16le from stdout into floats. */
export function pcmCollector() {
  const chunks = []
  return {
    add: (chunk) => chunks.push(chunk),
    finish() {
      const data = Buffer.concat(chunks)
      const out = new Float32Array(Math.floor(data.length / 2))
      for (let i = 0; i < out.length; i++) out[i] = data.readInt16LE(i * 2) / 32768
      return out
    },
  }
}

/** Log energy per hop, half-wave differenced: how much louder each frame is than the last. */
function onsets(samples) {
  const frames = Math.floor(samples.length / HOP)
  const energy = new Float64Array(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    for (let i = f * HOP; i < (f + 1) * HOP; i++) sum += samples[i] * samples[i]
    energy[f] = Math.log10(1e-10 + sum / HOP)
  }
  const raw = new Float64Array(frames)
  for (let f = 1; f < frames; f++) raw[f] = Math.max(0, energy[f] - energy[f - 1])
  // A light smoothing, so a hit split across two frames counts once
  const out = raw.map((v, f) => 0.25 * (raw[f - 1] ?? 0) + 0.5 * v + 0.25 * (raw[f + 1] ?? 0))
  // Take off the local mean over about a second, so loud passages don't count as onsets
  const half = Math.round(RATE / HOP / 2)
  const smooth = new Float64Array(frames)
  let acc = 0
  for (let f = 0; f < frames + half; f++) {
    if (f < frames) acc += out[f]
    if (f - 2 * half - 1 >= 0) acc -= out[f - 2 * half - 1]
    const at = f - half
    if (at >= 0 && at < frames) smooth[at] = acc / (Math.min(frames, f + 1) - Math.max(0, f - 2 * half))
  }
  return out.map((v, f) => Math.max(0, v - smooth[f]))
}

/** One-pole low-pass, for the kick's share of the onsets. */
function lowPassed(samples, hz) {
  const a = Math.exp((-2 * Math.PI * hz) / RATE)
  const out = new Float32Array(samples.length)
  let y = 0
  for (let i = 0; i < samples.length; i++) out[i] = y = (1 - a) * samples[i] + a * y
  return out
}

/** The beat period in frames, by autocorrelation weighted toward 120 BPM (Ellis 2007), refined to a fraction. */
export function tempoOf(envelope, { minBpm = 60, maxBpm = 200 } = {}) {
  const fps = RATE / HOP
  const lo = Math.floor((60 * fps) / maxBpm)
  const hi = Math.ceil((60 * fps) / minBpm)
  const r = new Float64Array(2 * hi + 4)
  for (let lag = lo - 1; lag <= 2 * hi + 2; lag++) {
    let sum = 0
    for (let i = lag; i < envelope.length; i++) sum += envelope[i] * envelope[i - lag]
    r[lag] = sum
  }
  let best = lo
  let bestScore = -Infinity
  for (let lag = lo; lag <= hi; lag++) {
    const bpm = (60 * fps) / lag
    const weight = Math.exp(-0.5 * (Math.log2(bpm / 120) / 1) ** 2)
    // A real pulse repeats at twice its period too; half the tempo doesn't add its half
    const pulse = r[lag] + 0.5 * Math.max(r[2 * lag - 1], r[2 * lag], r[2 * lag + 1])
    if (pulse * weight > bestScore) {
      bestScore = pulse * weight
      best = lag
    }
  }
  const [a, b, c] = [r[best - 1], r[best], r[best + 1]]
  const shift = a - 2 * b + c === 0 ? 0 : (0.5 * (a - c)) / (a - 2 * b + c)
  return best + Math.max(-0.5, Math.min(0.5, shift))
}

/** Beats by dynamic programming: onset strength, less a penalty for straying from the period. */
export function trackBeats(envelope, period, tightness = 100) {
  const n = envelope.length
  const score = new Float64Array(n)
  const from = new Int32Array(n).fill(-1)
  for (let i = 0; i < n; i++) {
    let best = 0
    for (let j = Math.max(0, Math.round(i - 2 * period)); j <= i - Math.round(period / 2); j++) {
      const value = score[j] - tightness * Math.log((i - j) / period) ** 2
      if (value > best || from[i] === -1) {
        best = value
        from[i] = j
      }
    }
    score[i] = envelope[i] + Math.max(0, best)
  }
  // Start from the strongest end within the last period
  let at = n - 1
  for (let i = Math.max(0, n - Math.round(period)); i < n; i++) if (score[i] > score[at]) at = i
  const beats = []
  while (at >= 0) {
    beats.push(at)
    at = from[at]
    if (beats.length > n) break
  }
  return beats.reverse()
}

/**
 * @param {Float32Array} samples mono at RATE
 * @returns {{ bpm: number | null, beats: { t: number, downbeat: boolean, strength: number }[], bars: { start: number, end: number, energy: number }[] }} times in flicks
 */
export function analyseMusic(samples) {
  const envelope = onsets(samples)
  if (envelope.length < (RATE / HOP) * 4 || envelope.every((v) => v === 0)) return { bpm: null, beats: [], bars: [] }
  const period = tempoOf(envelope)
  const frames = trackBeats(envelope, period)
  const low = onsets(lowPassed(samples, 150))
  const top = Math.max(...frames.map((f) => envelope[f]), 1e-9)
  // The bar's first beat is the phase where the low end lands hardest
  const near = (f) => Math.max(low[f - 1] ?? 0, low[f], low[f + 1] ?? 0)
  const phase = [0, 1, 2, 3].map((p) => frames.filter((_, i) => i % 4 === p).reduce((sum, f) => sum + near(f), 0) / Math.max(1, frames.filter((_, i) => i % 4 === p).length))
  const first = phase.indexOf(Math.max(...phase))
  // The rise at frame f marks a hit inside frame f: its middle (measured: f − ½ ran 11.6 ms early)
  const beats = frames.map((f, i) => ({ t: Math.round((f + 0.5) * FRAME_FLICKS), downbeat: i % 4 === first, strength: Math.round((envelope[f] / top) * 1000) / 1000 }))
  const downs = beats.filter((b) => b.downbeat).map((b) => b.t)
  const rms = (from, to) => {
    const a = Math.floor((from / FLICKS) * RATE)
    const b = Math.min(samples.length, Math.floor((to / FLICKS) * RATE))
    let sum = 0
    for (let i = a; i < b; i++) sum += samples[i] * samples[i]
    return b > a ? Math.sqrt(sum / (b - a)) : 0
  }
  const bars = downs.slice(0, -1).map((start, i) => ({ start, end: downs[i + 1], energy: Math.round(20 * Math.log10(1e-6 + rms(start, downs[i + 1])) * 10) / 10 }))
  return { bpm: Math.round(((60 * RATE) / (HOP * period)) * 10) / 10, beats, bars }
}
