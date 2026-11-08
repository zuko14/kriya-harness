// `podcast-multicam` (EDITOR_WORKFLOWS §3.2, §9): N cameras of one conversation become
// one programme. Code does all of it, with no model call:
// 1. Sync (ET-IDX-07): each camera's sound against the master's, coarse by cross-
//    correlating 10 ms loudness envelopes, then fine by GCC-PHAT on the samples in a
//    few windows; a straight line through the windows gives the offset and clock drift.
//    Each pairing has a confidence; below the floor the person is asked.
// 2. Who speaks: each speaker's own source (a dedicated mic, or the camera nearest
//    them) against its own noise floor; a voice that is only the other's bleed is not.
// 3. Switch: a path search over the angles with a minimum shot length (2.5 s), a cost
//    per switch, the speaker's camera for one voice, the wide for cross-talk and
//    laughter; then a cutaway to the listener inside long monologues.
// The master's sound is the programme's: angles are picture only, so no cut is heard.

import { apply } from "../core/ops.js"
import { runTool } from "../engine/tool.js"

const FLICKS = 705_600_000

/** The recipe is data (ET-RCP-01): no command, path, URL, model or price. */
export const PODCAST_MULTICAM = {
  id: "podcast-multicam",
  canvas: { width: 1920, height: 1080 },
  deliverable: { preset: "podcast-16x9", size: { width: 1920, height: 1080 }, fps: { n: 30, d: 1 }, codec: "h264", audio: "aac", loudness: { lufs: -14, tp: -1 }, burnCaptions: false, gates: ["QG-01", "QG-02", "QG-03", "QG-04", "QG-05", "QG-06", "QG-07", "QG-11", "QG-12", "QG-13", "QG-14"] },
  thresholds: { lengthTolerance: 0.05 },
  step: FLICKS / 10, // the switcher decides every 100 ms
  minShot: 2.5 * FLICKS,
  switchCost: 4,
  voiceAbove: 12, // dB over the source's own floor
  dominance: 6, // dB: a quieter voice this far under the loudest is bleed
  hangover: 5, // steps a voice stays on after its last loud step
  reaction: { after: 12 * FLICKS, length: 3 * FLICKS },
  syncFloor: 0.3,
  notes: "Recipe: a multi-camera conversation. The speaker's camera while one person talks, the wide shot when they talk over each other, a look at the listener in a long answer.",
}

export const SYNC_RATE = 8000
const ENVELOPE = 80 // samples: 10 ms at 8 kHz

// ---- Signals ----

/** A file's sound, mono at `rate`, as 16-bit samples. Long files: two hours is 115 MB at 8 kHz. */
export async function decodePcm(file, { rate = SYNC_RATE, run = runTool, signal } = {}) {
  const chunks = []
  await run("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-protocol_whitelist", "file,pipe", "-i", file, "-vn", "-sn", "-dn", "-ac", "1", "-ar", String(rate), "-f", "s16le", "-"], { onStdout: (chunk) => chunks.push(chunk), signal, stallMs: 60_000 })
  const bytes = Buffer.concat(chunks)
  return new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + (bytes.length & ~1)))
}

const nextPow2 = (n) => 2 ** Math.ceil(Math.log2(Math.max(2, n)))

/** In-place radix-2 FFT; `inverse` scales by 1/n. */
export function fft(re, im, inverse = false) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / len
    const [wr, wi] = [Math.cos(angle), Math.sin(angle)]
    for (let i = 0; i < n; i += len) {
      let [cr, ci] = [1, 0]
      for (let k = 0; k < len / 2; k++) {
        const [a, b] = [i + k, i + k + len / 2]
        const tr = re[b] * cr - im[b] * ci
        const ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
        ;[cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr]
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) (re[i] /= n), (im[i] /= n)
}

/**
 * c[k] = Σ a[n]·b[n+k], for k from -(a.length-1) to b.length-1, by FFT. With `phat`,
 * each frequency is weighted to unit size (GCC-PHAT), which sharpens the peak.
 * @returns {(k: number) => number}
 */
function correlate(a, b, { phat = false } = {}) {
  const size = nextPow2(a.length + b.length)
  const [ar, ai, br, bi] = [new Float64Array(size), new Float64Array(size), new Float64Array(size), new Float64Array(size)]
  ar.set(a)
  br.set(b)
  fft(ar, ai)
  fft(br, bi)
  for (let i = 0; i < size; i++) {
    // conj(A)·B
    const re = ar[i] * br[i] + ai[i] * bi[i]
    const im = ar[i] * bi[i] - ai[i] * br[i]
    const norm = phat ? Math.hypot(re, im) || 1 : 1
    ar[i] = re / norm
    ai[i] = im / norm
  }
  fft(ar, ai, true)
  return (k) => ar[((k % size) + size) % size]
}

/** Loudness in dB per `step` samples (10 ms at 8 kHz). */
export function levels(pcm, step = ENVELOPE) {
  const out = new Float32Array(Math.floor(pcm.length / step))
  for (let i = 0; i < out.length; i++) {
    let sum = 0
    for (let j = i * step; j < (i + 1) * step; j++) sum += (pcm[j] / 32768) ** 2
    out[i] = 10 * Math.log10(sum / step + 1e-10)
  }
  return out
}

// ---- Sync ----

const peakOf = (c, from, to) => {
  let best = from
  for (let k = from + 1; k <= to; k++) if (c(k) > c(best)) best = k
  return best
}

/** The fine offset in one window, in samples, by GCC-PHAT within ±margin of `coarse`. */
function fineOffset(ref, other, at, length, coarse, margin) {
  const start = at + coarse - margin
  if (at < 0 || at + length > ref.length || start < 0 || start + length + 2 * margin > other.length) return null
  const a = Float64Array.from(ref.subarray(at, at + length), (x) => x / 32768)
  const b = Float64Array.from(other.subarray(start, start + length + 2 * margin), (x) => x / 32768)
  const c = correlate(a, b, { phat: true })
  const k = peakOf(c, 0, 2 * margin)
  // Sharpness: the peak against the best value more than 1.5 ms away (drift smears a peak over a few samples)
  const apart = Math.ceil(margin / 20) // 1.5 ms at the default 30 ms margin
  let second = -Infinity
  for (let j = 0; j <= 2 * margin; j++) if (Math.abs(j - k) > apart) second = Math.max(second, c(j))
  const confidence = c(k) > 0 ? Math.max(0, 1 - Math.max(0, second) / c(k)) : 0
  // Parabolic interpolation between samples
  const [y0, y1, y2] = [c(k - 1), c(k), c(k + 1)]
  const denominator = y0 - 2 * y1 + y2
  const sub = k > 0 && k < 2 * margin && denominator !== 0 ? (0.5 * (y0 - y2)) / denominator : 0
  return { offset: k + sub + coarse - margin, confidence }
}

// The envelope lag near step `at`, within ±2 s of `lag`, over 20 s either side
function localLag(ea, eb, at, lag, span = 2000, reach = 200) {
  const from = Math.max(0, at - span)
  const to = Math.min(ea.length, at + span)
  if (to - from < span || from + lag - reach < 0 || to + lag + reach > eb.length) return lag
  const c = correlate(ea.subarray(from, to), eb.subarray(from + lag - reach, to + lag + reach))
  return lag - reach + peakOf(c, 0, 2 * reach)
}

/**
 * Where `other` sits against `ref`: an event at ref time t is at other time
 * t + offset + drift·t. Both are mono 16-bit at `rate`.
 * @returns {{ offset: number, drift: number, confidence: number, windows: number }} offset in flicks; drift as a ratio (1e-4 is 100 ppm)
 */
export function syncPair(ref, other, { rate = SYNC_RATE, maxLag = 60 * rate, windows = 6, window = 4 * rate, margin = Math.round(0.03 * rate) } = {}) {
  // Coarse: envelopes in dB, floored and centred, so loudness differences don't matter
  const envelope = (pcm) => {
    const db = levels(pcm).map((x) => Math.max(x, -60))
    const mean = db.reduce((s, x) => s + x, 0) / Math.max(1, db.length)
    return db.map((x) => x - mean)
  }
  const [ea, eb] = [envelope(ref), envelope(other)]
  const c = correlate(ea, eb)
  const reach = Math.min(Math.round(maxLag / ENVELOPE), Math.max(ea.length, eb.length) - 1)
  // Normalised by overlap, so a lag that overlaps little doesn't win by size; under half the shorter recording, a sliver could match by chance
  const least = Math.min(ea.length, eb.length) / 2
  const score = (k) => {
    const overlap = Math.min(ea.length, eb.length - k) - Math.max(0, -k)
    return overlap >= least ? c(k) / overlap : -Infinity
  }
  let lag = -reach
  for (let k = -reach + 1; k <= reach; k++) if (score(k) > score(lag)) lag = k
  const coarse = lag * ENVELOPE

  // Fine: windows spread over the overlap, each placed where the reference is loudest
  const first = Math.max(0, -coarse) + margin
  const last = Math.min(ref.length, other.length - coarse) - window - margin
  const found = []
  if (last > first) {
    const part = (last - first) / windows
    for (let w = 0; w < windows; w++) {
      let [best, energy] = [null, -1]
      for (let at = Math.round(first + w * part); at <= first + (w + 1) * part - window / 2 && at <= last; at += rate / 4) {
        let e = 0
        for (let j = at; j < at + window; j += 8) e += ref[j] * ref[j]
        if (e > energy) [best, energy] = [at, e]
      }
      // Drift moves the offset along the file, so each window re-finds its lag on the envelopes nearby
      const fine = best === null ? null : fineOffset(ref, other, best, window, localLag(ea, eb, Math.round((best + window / 2) / ENVELOPE), lag) * ENVELOPE, margin)
      if (fine) found.push({ t: best + window / 2, ...fine })
    }
  }
  const good = found.filter((f) => f.confidence >= 0.1)
  if (!good.length) return { offset: Math.round((coarse / rate) * FLICKS), drift: 0, confidence: 0, windows: 0 }
  // A robust line first (Theil–Sen), so a window that locked onto an echo, more than 2 ms off it, is left out
  const middle = (list) => [...list].sort((x, y) => x - y)[Math.floor(list.length / 2)]
  const slopes = good.flatMap((f, i) => good.slice(i + 1).filter((g) => g.t !== f.t).map((g) => (g.offset - f.offset) / (g.t - f.t)))
  const slope = slopes.length ? middle(slopes) : 0
  const intercept = middle(good.map((f) => f.offset - slope * f.t))
  const kept = good.filter((f) => Math.abs(f.offset - (intercept + slope * f.t)) <= 0.002 * rate)
  let [offset, drift] = [intercept, slope]
  if (kept.length >= 2) {
    const n = kept.length
    const mt = kept.reduce((s, f) => s + f.t, 0) / n
    const mo = kept.reduce((s, f) => s + f.offset, 0) / n
    const stt = kept.reduce((s, f) => s + (f.t - mt) ** 2, 0)
    drift = stt > 0 ? kept.reduce((s, f) => s + (f.t - mt) * (f.offset - mo), 0) / stt : 0
    offset = mo - drift * mt
  }
  const confidence = kept.length ? kept.map((f) => f.confidence).sort((a, b) => a - b)[Math.floor(kept.length / 2)] * (kept.length / found.length) : 0
  return { offset: Math.round((offset / rate) * FLICKS), drift, confidence, windows: kept.length }
}

// ---- Who speaks ----

/**
 * Each speaker's loudness on the master's clock, one value per decision step (the
 * loudest 10 ms inside it); NaN where that source wasn't recording. `sources[i]` is
 * speaker i's sound and its sync.
 * @param {{ pcm: Int16Array, sync: { offset: number, drift: number } }[]} sources
 */
export function speakerLevels(sources, steps, { rate = SYNC_RATE, step = PODCAST_MULTICAM.step } = {}) {
  return sources.map(({ pcm, sync }) => {
    const db = levels(pcm)
    const out = new Float32Array(steps).fill(NaN)
    const span = step / (FLICKS / (rate / ENVELOPE))
    for (let i = 0; i < steps; i++) {
      const t = i * step
      const from = Math.floor(((t + sync.offset + sync.drift * t) / FLICKS) * (rate / ENVELOPE))
      if (from < 0 || from + span > db.length) continue
      out[i] = -100
      for (let j = from; j < from + span; j++) out[i] = Math.max(out[i], db[j])
    }
    return out
  })
}

/**
 * Who is talking at each step, as a list of speaker numbers: a voice above its own
 * floor, held through short gaps, and not more than `dominance` dB under the loudest
 * over that same stretch (so bleed between one person's words isn't the other person).
 * null where a speaker's source wasn't recording: who speaks isn't known there.
 */
export function activity(speakers, rules = PODCAST_MULTICAM) {
  const recent = speakers.map((db) => Array.from(db, (_, i) => Math.max(...db.slice(Math.max(0, i - rules.hangover), i + 1).filter((x) => !Number.isNaN(x)), -100)))
  const loud = speakers.map((db) => {
    // The floor: the quietest 5 % (pauses between words), so a voice that bleeds all the time isn't the floor
    const heard = [...db].filter((x) => x > -100).sort((a, b) => a - b)
    const floor = heard[Math.floor(heard.length / 20)] ?? -100
    return Array.from(db, (x) => x > floor + rules.voiceAbove)
  })
  const on = loud.map((list) => list.map((_, i) => list.slice(Math.max(0, i - rules.hangover), i + 1).some(Boolean)))
  return Array.from({ length: speakers[0]?.length ?? 0 }, (_, i) => {
    if (speakers.some((db) => Number.isNaN(db[i]))) return null
    const active = speakers.map((_, s) => s).filter((s) => on[s][i])
    const top = Math.max(...active.map((s) => recent[s][i]))
    const kept = active.filter((s) => recent[s][i] >= top - rules.dominance)
    // A voice held only by the hangover (or only loud with the other's bleed) gives way to one heard now, so a change of turn isn't read as cross-talk
    const peak = Math.max(...kept.map((s) => speakers[s][i]))
    const now = kept.filter((s) => loud[s][i] && speakers[s][i] >= peak - rules.dominance)
    return now.length ? now : kept
  })
}

// ---- Switching ----

// Cost of showing `angle` while `active` speak: the speaker's own camera for one voice,
// the wide for several; silence costs nothing, so the picture holds. The listener's camera
// costs a little more than the wide, so a one-second reply holds the shot, not cuts away
function costOf(angle, active) {
  if (active === null) return angle.speaker === null ? 0 : 1 // not known: the wide is safe
  if (!active.length) return 0
  if (active.length === 1) return angle.speaker === active[0] ? 0 : angle.speaker === null ? 1 : 1.5
  return angle.speaker === null ? 0 : active.includes(angle.speaker) ? 2 : 3
}

/**
 * The path search: states are (angle, steps on it, capped at the minimum shot), so a
 * switch is only allowed off a shot at least `minShot` long. Angle 0 is the wide.
 * @param {number[][]} labels who speaks at each step
 * @param {{ speaker: number | null, available?: (step: number) => boolean }[]} angles
 * @returns {{ angle: number, from: number, to: number }[]} shots in steps, end-exclusive
 */
export function switchShots(labels, angles, rules = PODCAST_MULTICAM) {
  const T = labels.length
  if (!T) return []
  const R = Math.max(1, Math.round(rules.minShot / rules.step))
  const A = angles.length
  const S = A * R
  const emit = (a, i) => (angles[a].available && !angles[a].available(i) ? Infinity : costOf(angles[a], labels[i]))
  let cost = new Float64Array(S).fill(Infinity)
  for (let a = 0; a < A; a++) cost[a * R] = emit(a, 0)
  const back = new Int32Array(T * S).fill(-1)
  for (let i = 1; i < T; i++) {
    const next = new Float64Array(S).fill(Infinity)
    for (let a = 0; a < A; a++) {
      const e = emit(a, i)
      if (e === Infinity) continue
      // Stay: (a, r) → (a, min(r + 1, R))
      for (let r = 0; r < R; r++) {
        const from = a * R + r
        const to = a * R + Math.min(r + 1, R - 1)
        if (cost[from] + e < next[to]) [next[to], back[i * S + to]] = [cost[from] + e, from]
      }
      // Switch: (b, R) → (a, 1)
      for (let b = 0; b < A; b++) {
        const from = b * R + R - 1
        if (b === a || cost[from] === Infinity) continue
        const value = cost[from] + rules.switchCost + e
        if (value < next[a * R]) [next[a * R], back[i * S + a * R]] = [value, from]
      }
    }
    cost = next
  }
  // The last shot must be long enough too, when the whole is
  const cheapest = (allowed) => {
    let best = -1
    for (let s = 0; s < S; s++) if (allowed(s) && cost[s] < Infinity && (best < 0 || cost[s] < cost[best])) best = s
    return best
  }
  let end = cheapest((s) => T < R || s % R === R - 1)
  if (end < 0) end = cheapest(() => true)
  const path = new Int32Array(T)
  for (let i = T - 1, s = end; i >= 0; i--) {
    path[i] = Math.floor(s / R)
    s = back[i * S + s]
  }
  const shots = []
  for (let i = 0; i < T; i++) {
    if (shots.length && shots.at(-1).angle === path[i]) shots.at(-1).to = i + 1
    else shots.push({ angle: path[i], from: i, to: i + 1 })
  }
  return shots
}

/**
 * Cutaways to the listener inside long single-speaker shots: one every `after`, at the
 * listener's loudest moment near it (a laugh, an "mm"), never leaving a shot under
 * `minShot` either side.
 */
export function reactionCuts(shots, angles, labels, speakers, rules = PODCAST_MULTICAM) {
  const [after, length, min, half] = [rules.reaction.after, rules.reaction.length, rules.minShot, FLICKS / 2].map((t) => Math.round(t / rules.step))
  const out = []
  for (const shot of shots) {
    const speaker = angles[shot.angle].speaker
    if (speaker === null || shot.to - shot.from < after + length + min) {
      out.push(shot)
      continue
    }
    // The listener: the last other voice heard before this shot, else anyone else with a camera
    const heard = labels.slice(0, shot.from).findLast((l) => l?.some((s) => s !== speaker))?.find((s) => s !== speaker)
    const others = angles.map((_, i) => i).filter((i) => angles[i].speaker !== null && angles[i].speaker !== speaker)
    const listener = others.find((i) => angles[i].speaker === heard) ?? others[0]
    if (listener === undefined) {
      out.push(shot)
      continue
    }
    let cursor = shot.from
    for (let target = shot.from + after; target + length + min <= shot.to; target += after) {
      const [lo, hi] = [Math.max(cursor + min, target - Math.floor(after / 3)), Math.min(shot.to - length - min, target + Math.floor(after / 3))]
      if (lo > hi) continue
      const db = speakers[angles[listener].speaker]
      // A reaction is heard over the speaker (a laugh, an "mm"); the listener alone for half a second is a reply, and isn't cut to
      const replies = (i) => labels.slice(i, i + length).some((l) => l === null) || labels.slice(i, i + length).filter((l) => l.length && !l.includes(speaker)).length >= half
      const fits = (i) => labels[i]?.includes(speaker) && !replies(i) && (!angles[listener].available || angles[listener].available(i))
      // The listener's loudest moment; with none louder than another, the target itself
      let at = Math.min(hi, Math.max(lo, target))
      if (!fits(at)) at = -1
      for (let i = lo; i <= hi; i++) if (fits(i) && (at < 0 || db[i] > db[at] + 1)) at = i
      if (at < 0) continue
      out.push({ ...shot, from: cursor, to: at }, { angle: listener, from: at, to: at + length, reaction: true })
      cursor = at + length
    }
    out.push({ ...shot, from: cursor })
  }
  return out
}

// ---- The recipe ----

/**
 * Reads, syncs and labels the sources. `master` is the wide camera, whose sound is the
 * programme's; each angle is a camera on one speaker, its voice from its own `mic` file
 * when there is one, else from the camera's sound.
 * @param {{ master: { asset: string, file: string, duration: number }, angles: { asset: string, file: string, speaker: number, mic?: string }[] }} input
 */
export async function analyseMulticam({ master, angles }, { run = runTool, signal, rules = PODCAST_MULTICAM } = {}) {
  if (angles.map((a) => a.speaker).sort((a, b) => a - b).some((s, i) => s !== i)) throw new Error("Give each camera its own speaker, numbered from 0.")
  const ref = await decodePcm(master.file, { run, signal })
  const sync = {}
  const voices = []
  for (const angle of angles) {
    const pcm = await decodePcm(angle.file, { run, signal })
    sync[angle.asset] = syncPair(ref, pcm)
    const mic = angle.mic ? await decodePcm(angle.mic, { run, signal }) : null
    voices[angle.speaker] = mic ? { pcm: mic, sync: syncPair(ref, mic) } : { pcm, sync: sync[angle.asset] }
  }
  const steps = Math.floor(master.duration / rules.step)
  const speakers = speakerLevels(voices, steps, { step: rules.step })
  return { sync, speakers, labels: activity(speakers, rules) }
}

const WHY = (shot, angles, labels) => {
  if (shot.reaction) return "the listener's reaction"
  if (angles[shot.angle].speaker === null) return labels.slice(shot.from, shot.to).some((l) => l?.length > 1) ? "both talking" : "the room"
  return `speaker ${angles[shot.angle].speaker + 1}`
}

/**
 * Plans the programme as operations: the master whole on the base track, each angle's
 * shot as picture over it, in sync, with the master's sound throughout.
 * @param {{ project: object, index: object, master: string, angles: { asset: string, speaker: number }[], analysis: { sync: Record<string, { offset: number, drift: number, confidence: number }>, speakers: Float32Array[], labels: number[][] }, brief?: object }} input
 */
export function planMulticam({ project, index, master, angles, analysis, brief = {}, rules = PODCAST_MULTICAM }) {
  const notes = []
  const facts = (id) => project.assets.find((a) => a.id === id).facts
  const low = angles.filter((a) => analysis.sync[a.asset].confidence < rules.syncFloor)
  if (low.length) throw Object.assign(new Error(`The sound of ${low.map((a) => a.asset).join(", ")} doesn't match the master's well enough to sync (confidence under ${rules.syncFloor}). Check it's the same conversation, or line it up by hand.`), { needsYou: true })

  const duration = facts(master).duration
  // A camera is usable while its own recording covers the moment
  const sourceTime = (asset, t) => Math.round(t + analysis.sync[asset].offset + analysis.sync[asset].drift * t)
  const view = [{ speaker: null }, ...angles.map((a) => ({ speaker: a.speaker, asset: a.asset, available: (i) => sourceTime(a.asset, i * rules.step) >= 0 && sourceTime(a.asset, (i + 1) * rules.step) <= facts(a.asset).duration }))]
  const shots = reactionCuts(switchShots(analysis.labels, view, rules), view, analysis.labels, analysis.speakers, rules)

  const sequence = project.sequences.find((q) => q.id === project.active)
  const base = new Set(sequence.tracks.filter((t) => t.role === "base").map((t) => t.id))
  const ops = [
    ...sequence.clips.filter((c) => base.has(c.track)).map((c) => ({ op: "ripple_delete", clip: c.id })),
    { op: "set_brief", format: rules.id, targetDuration: duration, mustKeep: [], mustCut: [], effort: brief.effort ?? "best" },
    { op: "set_format", width: rules.canvas.width, height: rules.canvas.height, fps: rules.deliverable.fps },
    ...(project.deliverables.some((d) => d.preset === rules.deliverable.preset) ? [] : [{ op: "add_deliverable", ...rules.deliverable }]),
    { op: "keep_range", asset: master, from: 0, to: duration },
  ]
  const cut = apply(project, ops, { index, author: "agent" })
  if (!cut.applied) throw new Error(`The programme was refused: ${cut.diagnostics[0].message}`)
  const after = cut.project.sequences.find((q) => q.id === cut.project.active)
  const baseTracks = new Set(after.tracks.filter((t) => t.role === "base").map((t) => t.id))
  const programme = after.clips.findLast((c) => baseTracks.has(c.track)).id

  for (const shot of shots) {
    if (view[shot.angle].speaker === null) continue
    const [from, to] = [shot.from * rules.step, Math.min(duration, shot.to * rules.step)]
    const asset = view[shot.angle].asset
    const start = sourceTime(asset, from)
    ops.push({ op: "place_broll", asset, at: { clip: programme, edge: "start", offset: from }, in: start, out: start + (to - from) })
  }
  const done = apply(project, ops, { index, author: "agent" })
  if (!done.applied) throw new Error(`The switch was refused: ${done.diagnostics[0].message}`)

  const plan = shots.map((s) => ({ asset: view[s.angle].asset ?? master, at: s.from * rules.step, end: Math.min(duration, s.to * rules.step), why: WHY(s, view, analysis.labels) }))
  const reactions = shots.filter((s) => s.reaction).length
  notes.push(`Synced ${angles.length} camera${angles.length === 1 ? "" : "s"} to the master: ${angles.map((a) => `${a.asset} ${(analysis.sync[a.asset].offset / FLICKS).toFixed(3)} s, drift ${Math.round(analysis.sync[a.asset].drift * 1e6)} ppm, confidence ${analysis.sync[a.asset].confidence.toFixed(2)}`).join("; ")}.`)
  notes.push(`${shots.length} shots, none under ${rules.minShot / FLICKS} s; the wide for talking over each other${reactions ? `, and ${reactions} look${reactions === 1 ? "" : "s"} at the listener` : ""}. The sound is the master's throughout.`)
  return { ops, project: done.project, notes, calls: 0, shots: plan }
}
