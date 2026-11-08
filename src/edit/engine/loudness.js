// Loudness by EBU R128 / ITU-R BS.1770, measured by FFmpeg's ebur128 on a file:
// integrated loudness and true peak. The master step and QG-06 use the same reading.

import { runTool } from "./tool.js"

const value = (text, key) => {
  let last = null
  let top = null
  for (const line of text.split("\n")) {
    if (line.startsWith(`${key}=`)) {
      const n = Number(line.slice(key.length + 1))
      if (Number.isFinite(n)) {
        last = n
        top = top === null ? n : Math.max(top, n)
      }
    }
  }
  return { last, top }
}

export const loudnessArgs = (file) => ["-hide_banner", "-nostdin", "-loglevel", "error", "-protocol_whitelist", "file,pipe", "-i", file, "-vn", "-af", "ebur128=metadata=1:peak=true,ametadata=mode=print:file=-", "-f", "null", "-"]

/** @returns {{ integrated: number | null, truePeak: number | null }} LUFS and dBTP; null when silent */
export function readLoudness(text) {
  const integrated = value(text, "lavfi.r128.I").last
  const peak = value(text, "lavfi.r128.true_peak").top
  return { integrated: integrated !== null && integrated > -70 ? integrated : null, truePeak: peak !== null && peak > 0 ? 20 * Math.log10(peak) : null }
}

export async function measureLoudness(file, { run = runTool, signal } = {}) {
  return readLoudness(await run("ffmpeg", loudnessArgs(file), { signal, timeoutMs: 600_000 }))
}

/**
 * The master step's filter: a gain, and a limiter a margin under the true-peak ceiling,
 * since the limiter sees samples and AAC adds a little. The Engine measures and corrects
 * the gain, because limiting lowers loudness.
 */
export function masterFilter({ gain, ceiling, margin = 1.5 }) {
  gain = Math.max(-40, Math.min(40, gain))
  const limit = Math.min(1, Math.max(0.0625, 10 ** ((ceiling - margin) / 20)))
  return `volume=${gain.toFixed(2)}dB,alimiter=limit=${limit.toFixed(4)}:level=false:attack=5:release=50`
}
