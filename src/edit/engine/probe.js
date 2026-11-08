// L0 Probe: what a file really is. Times arrive as FFprobe's own integers and
// rationals and stay exact; no float seconds cross this boundary.

import { EngineFailure, runTool } from "./tool.js"

const FLICKS = 705_600_000n
const HDR = new Set(["smpte2084", "arib-std-b67"])
// A container's timebase can jitter CFR timestamps by a tick: more than this is real
const VFR_SLACK = 1_411_200

const ceilDiv = (a, b) => (a + b - 1n) / b

/** pts × "1/90000" as flicks, exactly. */
function ticks(value, timeBase) {
  const [n, d] = timeBase.split("/").map(BigInt)
  return Number(ceilDiv(BigInt(value) * n * FLICKS, d))
}

/** "12.345678" as flicks, from the digits. */
function decimal(text) {
  const [whole, fraction = ""] = text.split(".")
  const digits = fraction.padEnd(9, "0").slice(0, 9)
  return Number(ceilDiv((BigInt(whole) * 1_000_000_000n + BigInt(digits)) * FLICKS, 1_000_000_000n))
}

function rate(text) {
  const [n, d] = (text ?? "").split("/").map(Number)
  return n > 0 && d > 0 ? { n, d } : null
}

// ES-03, ES-07: files only (no playlist reaching the network), a time limit, and only
// container formats Kriya edits. HLS, concat lists, tee and the rest are refused after probing.
const LOCAL = ["-protocol_whitelist", "file,pipe"]
const FORMATS = new Set(["mov", "matroska", "avi", "mpegts", "mxf", "wav", "w64", "aiff", "caf", "mp3", "aac", "flac", "ogg", "image2", "png_pipe", "jpeg_pipe", "webp_pipe"])

const known = (value) => (value && value !== "unknown" ? value : null)

function rotationOf(stream) {
  const matrix = stream.side_data_list?.find((data) => data.rotation !== undefined)
  return matrix ? (((Math.round(matrix.rotation) % 360) + 360) % 360) : 0
}

function colourOf(stream) {
  const primaries = known(stream.color_primaries)
  const transfer = known(stream.color_transfer)
  return { primaries: primaries ?? "unknown", transfer: transfer ?? "unknown", range: known(stream.color_range) ?? "unknown", tagged: !!primaries && !!transfer, hdr: HDR.has(transfer) }
}

async function frameTimes(file, stream, run) {
  const text = await run("ffprobe", ["-v", "error", ...LOCAL, "-select_streams", String(stream.index), "-show_entries", "packet=pts", "-of", "csv=p=0", file], { timeoutMs: 900_000, stallMs: 120_000 })
  return text
    .split("\n")
    .map((line) => line.trim().replace(/,+$/, ""))
    .filter((line) => /^-?\d+$/.test(line))
    .map((pts) => ticks(pts, stream.time_base))
    .sort((a, b) => a - b)
}

/**
 * @param {string} file
 * @param {{ run?: typeof runTool }} [options]
 * @returns {Promise<{ facts: object, timestamps?: number[] }>} timestamps only for a VFR file
 */
export async function probe(file, { run = runTool } = {}) {
  let data
  try {
    data = JSON.parse(await run("ffprobe", ["-v", "error", ...LOCAL, "-print_format", "json", "-show_streams", "-show_format", file], { timeoutMs: 120_000 }))
  } catch (error) {
    if (error instanceof SyntaxError) throw new EngineFailure("input", "unreadable", "This file can't be read.")
    throw error
  }
  if (!FORMATS.has(String(data.format?.format_name ?? "").split(",")[0])) throw new EngineFailure("input", "refused", "Kriya doesn't open this kind of file.")
  const video = data.streams?.find((stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1)
  const audio = data.streams?.find((stream) => stream.codec_type === "audio")
  if (!video && !audio) throw new EngineFailure("input", "unreadable", "This file has no picture or sound.")

  const facts = { hasAudio: !!audio }
  if (audio) Object.assign(facts, { sampleRate: Number(audio.sample_rate), channels: audio.channels })
  const lead = video ?? audio
  if (lead.duration_ts && lead.time_base) facts.duration = ticks(lead.duration_ts, lead.time_base)
  else if (data.format?.duration) facts.duration = decimal(data.format.duration)
  if (!video) return { facts: { ...facts, vfr: false } }

  const rotation = rotationOf(video)
  const sideways = rotation % 180 !== 0
  Object.assign(facts, { width: sideways ? video.height : video.width, height: sideways ? video.width : video.height, rotation, color: colourOf(video) })

  const times = await frameTimes(file, video, run)
  // A loop, not Math.max(...gaps): a 2-hour take has 216,000 gaps, past the call stack (found in ED17's soak)
  let low = Infinity
  let high = -Infinity
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1]
    if (gap < low) low = gap
    if (gap > high) high = gap
  }
  const vfr = times.length > 2 && high - low > VFR_SLACK
  facts.vfr = vfr
  facts.fps = vfr ? null : (rate(video.avg_frame_rate) ?? rate(video.r_frame_rate))
  return vfr ? { facts, timestamps: times } : { facts }
}
