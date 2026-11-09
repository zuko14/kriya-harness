// References, classified (2026-11-09): a video gives its editing pace and captions (Edit
// DNA) and its colour; an image gives its colour grade; a piece of music gives its tempo and
// energy. Every value is a number or a fixed word, never a pixel, sound or word of the
// reference (EDD-23), and each turns into something the cut can really do.

import { extractDna } from "./dna.js"
import { measureLoudness } from "./loudness.js"
import { runTool } from "./tool.js"
import { analyseMusic, musicArgs, pcmCollector } from "../index/layers/music.js"

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const round = (v, places = 2) => Math.round(v * 10 ** places) / 10 ** places

/** Averages of FFmpeg's signalstats over sampled frames (a frame every 2 s, the first 90 s). */
export async function colourStats(file, { image = false, run = runTool, signal } = {}) {
  const vf = `${image ? "" : "fps=1/2,"}scale=160:-2,signalstats,metadata=print:file=-`
  const text = await run("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-protocol_whitelist", "file,pipe", ...(image ? [] : ["-t", "90"]), "-i", file, "-vf", vf, "-an", "-f", "null", "-"], { signal, timeoutMs: 180_000 })
  const sums = {}
  const counts = {}
  for (const m of text.matchAll(/lavfi\.signalstats\.(YAVG|UAVG|VAVG|SATAVG|YLOW|YHIGH)=([\d.]+)/g)) {
    sums[m[1]] = (sums[m[1]] ?? 0) + Number(m[2])
    counts[m[1]] = (counts[m[1]] ?? 0) + 1
  }
  if (!counts.YAVG) return null
  return Object.fromEntries(Object.keys(sums).map((key) => [key, sums[key] / counts[key]]))
}

/**
 * The grade that moves a picture toward a reference's colour, and the words for it.
 * shortcut: a fixed mapping from 8-bit averages, approximate by design; a measured match
 * against the person's own footage (colour.js) is the precise path, for a later phase
 */
export function gradeFromStats(stats) {
  const warmth = stats.VAVG - stats.UAVG // above 0 leans red and orange, below leans blue
  const grade = {
    // Kept within a tasteful range: a reference leans the cut, it doesn't overpower it
    temperature: Math.round(clamp(6500 - warmth * 60, 4200, 9000) / 100) * 100,
    saturation: round(clamp(stats.SATAVG / 32, 0.75, 1.3)),
    gain: round(clamp((stats.YHIGH - stats.YLOW) / 190, 0.9, 1.2)),
    lift: round(clamp((stats.YAVG - 115) / 700, -0.05, 0.05), 3),
  }
  const words = [warmth > 4 ? "warm" : warmth < -4 ? "cool" : "neutral", grade.saturation > 1.15 ? "saturated" : grade.saturation < 0.85 ? "muted" : "natural colour", grade.gain > 1.08 ? "contrasty" : grade.gain < 0.93 ? "soft contrast" : "even contrast", stats.YAVG > 140 ? "bright" : stats.YAVG < 85 ? "dark" : "mid brightness"]
  return { grade, words }
}

/** Tempo and energy of music: the bed's mood and tempo follow it. */
export async function musicOf(file, { run = runTool, signal } = {}) {
  const pcm = pcmCollector()
  // The first minute is enough to hear a tempo
  await run("ffmpeg", [...musicArgs(file).slice(0, -1), "-t", "60", "pipe:1"], { onStdout: pcm.add, signal, timeoutMs: 180_000 })
  const { bpm } = analyseMusic(pcm.finish())
  const { integrated } = await measureLoudness(file, { run, signal })
  const mood = bpm === null ? (integrated !== null && integrated > -14 ? "upbeat" : "calm") : bpm >= 104 ? "upbeat" : bpm <= 86 ? "calm" : "warm"
  return { bpm: bpm === null ? null : Math.round(bpm), lufs: integrated === null ? null : round(integrated, 1), mood }
}

/**
 * @param {string} file
 * @param {{ width?: number, duration?: number, hasAudio?: boolean }} facts from probe
 * @returns {Promise<{ kind: "video" | "image" | "audio", colour?: object, pace?: object, captions?: boolean, music?: object, lines: string[] }>}
 */
export async function analyseReference(file, facts, { run = runTool, signal } = {}) {
  const kind = facts.width ? (facts.duration ? "video" : "image") : "audio"
  // `parts`: each line under the aspect it informs, so a reference taken for one aspect gives only that
  const out = { kind, lines: [], parts: {} }
  const line = (aspect, text) => (out.lines.push(text), (out.parts[aspect] = text))
  if (kind !== "audio") {
    const stats = await colourStats(file, { image: kind === "image", run, signal })
    if (stats) {
      out.colour = gradeFromStats(stats)
      line("colour", `Colour: ${out.colour.words.join(", ")}`)
    }
  }
  if (kind === "video") {
    const dna = await extractDna(file, { run, signal }).catch(() => null)
    if (dna?.pace?.median) {
      out.pace = { every: dna.pace.median, shots: dna.pace.shots }
      line("editing", `Pace: the picture changes every ${dna.pace.median.toFixed(1)} s (${dna.pace.shots} shots)`)
    }
    if (dna) {
      out.captions = !!dna.captions?.present
      line("graphics", out.captions ? "Captions: yes, on screen" : "Captions: none")
    }
  }
  // A video's soundtrack is measured too: it's what a reference taken for its sound gives
  if (kind === "audio" || (kind === "video" && facts.hasAudio)) {
    out.music = await musicOf(file, { run, signal }).catch(() => null)
    if (out.music) line("sound", `Music: ${out.music.bpm ? `${out.music.bpm} bpm, ` : ""}${out.music.mood}${out.music.lufs !== null ? `, ${out.music.lufs} LUFS` : ""}`)
  }
  return out
}

/** What a reference can be taken for: the person picks one per reference, or all of it. */
export const ASPECTS = {
  all: "Everything it shows",
  editing: "Editing: cuts and pace",
  sound: "Sound: music and feel",
  colour: "Colour grade",
  graphics: "Graphics: captions and text",
}

/** References as the person sent them: ids, or { id, aspect }; anything else dropped. At most six. */
export function cleanRefs(list) {
  if (!Array.isArray(list)) return []
  const safe = (v) => typeof v === "string" && /^[A-Za-z0-9:_-]{1,64}$/.test(v)
  const out = []
  for (const item of list) {
    const ref = safe(item) ? { id: item, aspect: "all" } : item && safe(item.id) ? { id: item.id, aspect: Object.hasOwn(ASPECTS, item.aspect) ? item.aspect : "all" } : null
    if (ref && !out.some((r) => r.id === ref.id)) out.push(ref)
  }
  return out.slice(0, 6)
}

/**
 * Only what the reference was taken for. "all" keeps the earlier rule for a video's sound: used
 * only when it has no cuts to read, since a cut video's soundtrack is usually speech.
 */
export function takeFrom(found, aspect = "all") {
  const wants = (a) => aspect === "all" || aspect === a
  const parts = found.parts ?? {}
  const out = { kind: found.kind, lines: [] }
  const keep = (a, key) => {
    if (!wants(a) || found[key] === undefined || found[key] === null) return
    out[key] = found[key]
    if (parts[a]) out.lines.push(parts[a])
  }
  keep("colour", "colour")
  keep("editing", "pace")
  keep("graphics", "captions")
  if (aspect === "sound" || (aspect === "all" && !(found.kind === "video" && found.pace))) keep("sound", "music")
  // An analysis kept from before `parts` existed: its lines, for everything
  if (!found.parts && aspect === "all") out.lines = [...(found.lines ?? [])]
  return out
}
