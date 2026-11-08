// Per-asset work: identity, peaks. Proxies and thumbnails are plain FFmpeg calls in
// the engine's nodes; peaks are read from a decoded stream as it passes.

import { createHash } from "node:crypto"
import { open, stat } from "node:fs/promises"

const SAMPLE = 1 << 20
const RATE = 8000
const LEVELS = [100, 10, 1]

/** Size, modified time and sha256 of sampled blocks: a 40 GB file isn't read in full (EDIT_ENGINE §7). */
export async function fingerprint(file) {
  const { size, mtimeMs } = await stat(file)
  const hash = createHash("sha256").update(`${size}:${mtimeMs}`)
  const handle = await open(file)
  try {
    const block = Buffer.alloc(SAMPLE)
    for (const position of [0, Math.max(0, Math.floor(size / 2) - SAMPLE / 2), Math.max(0, size - SAMPLE)]) {
      const { bytesRead } = await handle.read(block, 0, SAMPLE, position)
      hash.update(block.subarray(0, bytesRead))
    }
  } finally {
    await handle.close()
  }
  return hash.digest("hex")
}

/** Folds a stream of s16le samples into peak levels at each zoom. */
export function peakCollector() {
  const step = RATE / LEVELS[0]
  const fine = []
  let count = 0
  let top = 0
  let carry = null
  return {
    rate: RATE,
    add(chunk) {
      const data = carry ? Buffer.concat([carry, chunk]) : chunk
      const usable = data.length - (data.length % 2)
      carry = usable < data.length ? data.subarray(usable) : null
      for (let at = 0; at < usable; at += 2) {
        top = Math.max(top, Math.abs(data.readInt16LE(at)))
        if (++count === step) {
          fine.push(top / 32768)
          count = 0
          top = 0
        }
      }
    },
    finish() {
      if (count > step / 2) fine.push(top / 32768)
      const fold = (factor) => Array.from({ length: Math.ceil(fine.length / factor) }, (_, i) => Math.max(...fine.slice(i * factor, (i + 1) * factor)))
      const round = (peaks) => peaks.map((peak) => Math.round(peak * 1000) / 1000)
      return { levels: LEVELS.map((perSecond) => ({ perSecond, peaks: round(fold(LEVELS[0] / perSecond)) })) }
    },
  }
}
