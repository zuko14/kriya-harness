// The independent grader (EVALUATION_PLAN §7): measures any arm's finished file with plain
// ffprobe and ffmpeg, so Kriya isn't judged by its own definition of good. It shares no code
// with src/edit (tests/edit-bench.test.js holds it to that). What it can't measure, it says
// it can't: `notMeasured`, never a pass.

import { execFile } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)
const LIMITS = { maxBuffer: 64 * 1024 * 1024 }

const logOf = async (args) => (await run("ffmpeg", ["-hide_banner", "-nostats", ...args, "-f", "null", "-"], LIMITS)).stderr

/** Each `pattern` match in a filter's log, as seconds. */
const matches = (log, pattern) => [...log.matchAll(pattern)].map((m) => m.slice(1).map(Number))

export async function facts(file) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], LIMITS)
  const data = JSON.parse(stdout)
  const video = data.streams.find((s) => s.codec_type === "video")
  const audio = data.streams.find((s) => s.codec_type === "audio")
  const [n, d] = (video?.avg_frame_rate ?? "0/1").split("/").map(Number)
  return { duration: Number(data.format?.duration ?? 0), width: video?.width ?? 0, height: video?.height ?? 0, fps: d ? n / d : 0, video: video?.codec_name ?? null, audio: audio?.codec_name ?? null }
}

/**
 * Objective defects in a finished file.
 * @param {string} file
 * @param {{ blackSeconds?: number, freezeSeconds?: number, silenceSeconds?: number, targetLufs?: number, lufsTolerance?: number, ceiling?: number }} [limits]
 */
export async function defects(file, { blackSeconds = 0.3, freezeSeconds = 1.5, silenceSeconds = 2, targetLufs = -14, lufsTolerance = 2, ceiling = -0.5 } = {}) {
  const found = []
  const about = await facts(file)
  if (about.video) {
    const log = await logOf(["-i", file, "-an", "-vf", `blackdetect=d=${blackSeconds}:pix_th=0.05,freezedetect=n=0.001:d=${freezeSeconds}`])
    for (const [at, end] of matches(log, /black_start:([\d.]+) black_end:([\d.]+)/g)) found.push({ kind: "black", at, end })
    const starts = matches(log, /freeze_start: ([\d.]+)/g).map(([t]) => t)
    const ends = matches(log, /freeze_end: ([\d.]+)/g).map(([t]) => t)
    starts.forEach((at, i) => found.push({ kind: "frozen", at, end: ends[i] ?? about.duration }))
  }
  if (about.audio) {
    const log = await logOf(["-i", file, "-vn", "-af", `silencedetect=n=-50dB:d=${silenceSeconds},ebur128=peak=true`])
    const starts = matches(log, /silence_start: ([\d.]+)/g).map(([t]) => t)
    const ends = matches(log, /silence_end: ([\d.]+)/g).map(([t]) => t)
    starts.forEach((at, i) => found.push({ kind: "silent", at, end: ends[i] ?? about.duration }))
    const summary = log.slice(log.lastIndexOf("Summary:"))
    const lufs = Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1])
    const peak = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(summary)?.[1])
    if (Number.isFinite(lufs) && Math.abs(lufs - targetLufs) > lufsTolerance) found.push({ kind: "loudness", value: lufs })
    if (Number.isFinite(peak) && peak > ceiling) found.push({ kind: "clipping", value: peak })
  }
  return { facts: about, defects: found }
}

const plain = (text) => text.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim()

/**
 * A task's audited pass list (§3). `transcript` comes from an ASR run that shares nothing with
 * the arm; with none, the speech lines are `notMeasured`, and the task can't pass on them.
 * @param {{ facts: object, defects: object[] }} graded
 * @param {{ width?: number, height?: number, seconds?: number, tolerance?: number, mustKeep?: string[], mustCut?: string[] }} list
 * @param {string | null} [transcript]
 */
export function checkTask(graded, list, transcript = null) {
  const misses = []
  const { facts: about } = graded
  if (about.duration <= 0 || !about.video) misses.push("no picture")
  if (list.width && (about.width !== list.width || about.height !== list.height)) misses.push(`format ${about.width}x${about.height}`)
  if (list.seconds && Math.abs(about.duration - list.seconds) > list.seconds * (list.tolerance ?? 0.15)) misses.push(`length ${about.duration.toFixed(1)} s`)
  const speech = [...(list.mustKeep ?? []), ...(list.mustCut ?? [])]
  const notMeasured = speech.length && transcript === null ? ["speech"] : []
  if (transcript !== null) {
    const heard = plain(transcript)
    for (const line of list.mustKeep ?? []) if (!heard.includes(plain(line))) misses.push(`must keep: ${line}`)
    for (const line of list.mustCut ?? []) if (heard.includes(plain(line))) misses.push(`must cut: ${line}`)
  }
  return { pass: misses.length === 0 && notMeasured.length === 0, misses, notMeasured }
}

/** Q2: objective defects per finished minute. */
export const defectsPerMinute = ({ facts: about, defects: found }) => (about.duration > 0 ? found.length / (about.duration / 60) : null)
