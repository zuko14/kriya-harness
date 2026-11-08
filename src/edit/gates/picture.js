// QG-03 Sync, QG-07 Picture health and QG-11 Motion (QUALITY_GATES §2, ED10), read
// from the rendered file and its tiles by FFmpeg. Each returns its numbers and every
// failure with its time; the runner turns them into a verdict.

import { metadataFrames } from "../index/layers/meta.js"

const FLICKS = 705_600_000
const toFlicks = (seconds) => Math.round(Number(seconds) * FLICKS)
const round = (n, places = 3) => Math.round(n * 10 ** places) / 10 ** places

/* ─────────────────────────────── QG-03 ─────────────────────────────── */

/**
 * Where each stream starts and ends, from the container's own timestamps.
 * shortcut: streams only; speech onsets against lip activity need a mouth track (L8 landmarks), not built
 */
export async function streamTimes(file, run) {
  const data = JSON.parse(await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_entries", "stream=codec_type,codec_name,start_time,duration,initial_padding,sample_rate", file], { timeoutMs: 120_000 }))
  const of = (type) => {
    const s = data.streams.find((stream) => stream.codec_type === type)
    if (!s) return null
    // AAC that lost its padding note plays its priming samples first, so the sound proper starts later
    // (found by EG-4's seeds). shortcut: FFmpeg's AAC delay, 1024 samples; other encoders' delays differ
    const primed = type === "audio" && s.codec_name === "aac" && Number(s.initial_padding ?? 0) === 0 && Number(s.sample_rate) > 0 ? 1024 / Number(s.sample_rate) : 0
    const start = Number(s.start_time ?? 0) + primed
    return { start, end: Number(s.start_time ?? 0) + Number(s.duration ?? 0), ...(primed ? { primed: Math.round(primed * 10000) / 10 } : {}) }
  }
  return { video: of("video"), audio: of("audio") }
}

export function judgeSync({ video, audio }, { maxDriftMs }) {
  if (!video || !audio) return { failures: [], numbers: { streams: [video ? "video" : null, audio ? "audio" : null].filter(Boolean) }, applicable: false }
  const startMs = Math.abs(video.start - audio.start) * 1000
  const endMs = Math.abs(video.end - audio.end) * 1000
  const failures = []
  if (startMs > maxDriftMs) failures.push({ kind: "offset", ms: round(startMs, 1), t: 0 })
  // AAC ends on its own frame (21 ms at 48 kHz), so the end allows one more
  if (endMs > maxDriftMs + 21.4) failures.push({ kind: "drift", ms: round(endMs, 1), t: toFlicks(Math.min(video.end, audio.end)) })
  return { failures, numbers: { startMs: round(startMs, 1), endMs: round(endMs, 1), allowedMs: maxDriftMs, ...(audio.primed ? { primingMs: audio.primed } : {}), lipSync: "not built" } }
}

/* ─────────────────────────────── QG-07 ─────────────────────────────── */

export const healthArgs = (file) => ["-hide_banner", "-nostdin", "-loglevel", "error", "-i", file, "-an", "-vf", "scale=320:-2,blackdetect=d=0.1:pix_th=0.1,freezedetect=n=-55dB:d=1,signalstats,metadata=mode=print:file=-", "-f", "null", "-"]

/** Black and frozen spans and the picture's mean brightness per frame, from one pass. */
export function readHealth(text) {
  const frames = metadataFrames(text)
  const black = []
  const frozen = []
  const luma = []
  let open = null
  for (const { pts, values } of frames) {
    luma.push(Number(values["lavfi.signalstats.YAVG"]))
    if (values["lavfi.black_start"] !== undefined) open = { start: toFlicks(values["lavfi.black_start"]) }
    if (values["lavfi.black_end"] !== undefined && open) {
      black.push({ ...open, end: toFlicks(values["lavfi.black_end"]) })
      open = null
    }
    if (values["lavfi.freezedetect.freeze_start"] !== undefined) frozen.push({ start: toFlicks(values["lavfi.freezedetect.freeze_start"]), end: null })
    if (values["lavfi.freezedetect.freeze_end"] !== undefined && frozen.at(-1)?.end === null) frozen.at(-1).end = toFlicks(values["lavfi.freezedetect.freeze_end"])
    void pts
  }
  if (open) black.push({ ...open, end: null })
  return { black, frozen, luma }
}

/**
 * @param {{ black: object[], frozen: object[], luma: number[] }} health
 * @param {{ duration: number, fps: { n: number, d: number }, holds: { at: number, end: number }[], cuts: { t: number, same: boolean }[] }} plan holds: freezes the plan asks for; cuts: where pieces of one source meet
 */
export function judgeHealth({ black, frozen, luma }, { duration, fps, holds, cuts }, { exposureJump }) {
  const failures = []
  const close = (span) => ({ ...span, end: span.end ?? duration })
  const planned = (span) => holds.some((h) => h.at <= span.start + FLICKS / 10 && span.end - FLICKS / 10 <= h.end)
  for (const span of black.map(close)) failures.push({ kind: "black", severity: "block", t: span.start, seconds: round((span.end - span.start) / FLICKS, 2) })
  for (const span of frozen.map(close)) if (!planned(span)) failures.push({ kind: "frozen", severity: "block", t: span.start, seconds: round((span.end - span.start) / FLICKS, 2) })
  const frameAt = (t) => Math.min(luma.length - 1, Math.max(0, Math.floor((t * fps.n) / (FLICKS * fps.d))))
  let worst = 0
  for (const cut of cuts) {
    if (!cut.same) continue
    const before = luma[frameAt(cut.t) - 1]
    const after = luma[frameAt(cut.t)]
    if (!Number.isFinite(before) || !Number.isFinite(after)) continue
    const jump = Math.abs(after - before)
    worst = Math.max(worst, jump)
    if (jump > exposureJump) failures.push({ kind: "exposure_jump", severity: "note", t: cut.t, jump: round(jump, 1), allowed: exposureJump })
  }
  return { failures, numbers: { black: black.length, frozen: frozen.length, worstJump: round(worst, 1), banding: "not built" } }
}

/* ─────────────────────────────── QG-11 ─────────────────────────────── */

const SMALL = { w: 96, h: 96 }

/** A tile's frames, small, as alpha: is there motion at all, and how many frames are there. */
export async function tileFrames(file, run) {
  const chunks = []
  await run("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-i", file, "-vf", `alphaextract,scale=${SMALL.w}:${SMALL.h},format=gray`, "-f", "rawvideo", "pipe:1"], { timeoutMs: 120_000, onStdout: (chunk) => chunks.push(chunk) })
  const data = Buffer.concat(chunks)
  const size = SMALL.w * SMALL.h
  const frames = []
  for (let i = 0; (i + 1) * size <= data.length; i++) frames.push(data.subarray(i * size, (i + 1) * size))
  return frames
}

const meanDiff = (a, b) => {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i])
  return sum / a.length
}

/**
 * @param {{ tile: object, frames: Buffer[], expected: number }[]} tiles expected: frames the window holds
 */
export function judgeMotion(tiles, { minMotion }) {
  const failures = []
  let still = 0
  for (const { tile, frames, expected } of tiles) {
    if (frames.length < expected) failures.push({ kind: "clipped_overlay", t: tile.at, frames: frames.length, expected })
    // The entrance: how far the first second moves from the first frame
    let moved = 0
    for (let i = 1; i < Math.min(frames.length, 30); i++) moved = Math.max(moved, meanDiff(frames[0], frames[i]))
    if (moved < minMotion) {
      still++
      failures.push({ kind: "no_motion", t: tile.at, change: round(moved, 2), needed: minMotion })
    }
  }
  return { failures, numbers: { tiles: tiles.length, still } }
}
