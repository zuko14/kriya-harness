// FFmpeg's `metadata=mode=print:file=-` output, read as frames. A frame's time comes
// from its integer pts in a timebase we set, so no float seconds cross this boundary.

const FLICKS = 705_600_000n

/** pts in 1/`base` seconds → flicks, rounded down to the flick. */
export const ptsFlicks = (pts, base) => Number((BigInt(pts) * FLICKS) / BigInt(base))

/** "1.999979" → flicks, from its digits. */
export function decimalFlicks(text) {
  const negative = text.startsWith("-")
  const [whole, fraction = ""] = text.replace(/^-/, "").split(".")
  const value = Number(((BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0").slice(0, 9))) * FLICKS) / 1_000_000_000n)
  return negative ? -value : value
}

/** @returns {{ pts: number, values: Record<string, string> }[]} */
export function metadataFrames(text) {
  const frames = []
  for (const line of text.split("\n")) {
    const head = /^frame:\d+\s+pts:(-?\d+)/.exec(line)
    if (head) frames.push({ pts: Number(head[1]), values: {} })
    else if (frames.length) {
      const at = line.indexOf("=")
      if (at > 0) frames.at(-1).values[line.slice(0, at)] = line.slice(at + 1).trim()
    }
  }
  return frames
}

/** A number, or null for FFmpeg's nan, inf and missing values. */
export const finite = (text) => {
  const value = Number(text)
  return text !== undefined && Number.isFinite(value) ? value : null
}
