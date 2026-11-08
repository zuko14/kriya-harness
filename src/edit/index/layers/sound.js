// L1 Sound map: a loudness curve (EBU R128 momentary), a peak envelope and silences,
// at 100 ms, from one FFmpeg pass. Voice activity (silero-vad) is a later layer.

import { decimalFlicks, finite, metadataFrames, ptsFlicks } from "./meta.js"

export const SOUND_VERSION = "l1-1"
const RATE = 48_000
export const STEP = 70_560_000 // 100 ms in flicks
export const SILENCE_DB = -40
const SILENCE_SECONDS = 0.3

export const soundArgs = (source) => [
  "-hide_banner", "-nostdin", "-loglevel", "error", "-protocol_whitelist", "file,pipe", "-i", source, "-vn", "-sn", "-dn",
  "-af", `aresample=${RATE},asetnsamples=n=${RATE / 10}:p=0,asettb=1/${RATE},ebur128=metadata=1,silencedetect=n=${SILENCE_DB}dB:d=${SILENCE_SECONDS},astats=metadata=1:reset=1:measure_overall=Peak_level:measure_perchannel=none,ametadata=mode=print:file=-`,
  "-f", "null", "-",
]

const round1 = (value) => (value === null ? null : Math.round(value * 10) / 10)

/** @returns {{ data: { step: number, loudness: (number|null)[], peaks: (number|null)[], integrated: number|null }, silences: { start: number, end: number }[] }} */
export function readSound(text, duration) {
  const frames = metadataFrames(text)
  const loudness = []
  const peaks = []
  const silences = []
  let integrated = null
  let open = null
  for (const { values } of frames) {
    const m = finite(values["lavfi.r128.M"])
    loudness.push(m === null || m < -70 ? null : round1(m)) // below R128's absolute gate is silence
    peaks.push(round1(finite(values["lavfi.astats.Overall.Peak_level"])))
    integrated = finite(values["lavfi.r128.I"]) ?? integrated
    // silencedetect's times are its own decimal seconds, to the microsecond
    if (values["lavfi.silence_start"] !== undefined) open = Math.max(0, decimalFlicks(values["lavfi.silence_start"]))
    if (values["lavfi.silence_end"] !== undefined && open !== null) {
      silences.push({ start: open, end: decimalFlicks(values["lavfi.silence_end"]) })
      open = null
    }
  }
  if (open !== null) silences.push({ start: open, end: duration ?? (frames.length ? ptsFlicks(frames.at(-1).pts, RATE) + STEP : open) })
  return { data: { step: STEP, loudness, peaks, integrated: integrated !== null && integrated > -70 ? round1(integrated) : null }, silences }
}
