// Edit Core time (EDIT_ENGINE §2): every time is an integer count of flicks,
// 1/705,600,000 s, and frame rates are rationals { n, d }. Seconds exist only as
// the strings the edge functions at the bottom print.

export const FLICKS = 705_600_000

const BIG = BigInt(FLICKS)

export const isFlicks = (value) => Number.isSafeInteger(value)
export const isRate = (rate) => rate !== null && typeof rate === "object" && Number.isSafeInteger(rate.n) && Number.isSafeInteger(rate.d) && rate.n > 0 && rate.d > 0

const whole = (value, name) => {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${name} must be a whole number, got ${value}`)
  return BigInt(value)
}
const rateOf = (rate) => {
  if (!isRate(rate)) throw new RangeError("a rate must be a rational { n, d } of positive whole numbers")
  return { n: BigInt(rate.n), d: BigInt(rate.d) }
}
const hertz = (hz) => {
  if (!Number.isSafeInteger(hz) || hz <= 0) throw new RangeError("a sample rate must be a positive whole number")
  return BigInt(hz)
}
const floorDiv = (a, b) => (a >= 0n ? a / b : -((-a + b - 1n) / b))
const ceilDiv = (a, b) => -floorDiv(-a, b)
const safe = (value) => {
  const result = Number(value)
  if (!Number.isSafeInteger(result)) throw new RangeError("time is past what flicks can hold exactly")
  return result
}

/** Flicks in one frame, or null when the rate doesn't divide a flick evenly. */
export function frameFlicks(rate) {
  const { n, d } = rateOf(rate)
  return (BIG * d) % n === 0n ? Number((BIG * d) / n) : null
}

// Ceiling, so at a rate that doesn't divide a flick a frame's start still belongs to it
export function framesToFlicks(frame, rate) {
  const { n, d } = rateOf(rate)
  return safe(ceilDiv(whole(frame, "a frame") * BIG * d, n))
}

/** The frame showing at time t. */
export function flicksToFrames(t, rate) {
  const { n, d } = rateOf(rate)
  return safe(floorDiv(whole(t, "a time") * n, BIG * d))
}

export const samplesToFlicks = (sample, hz) => safe(ceilDiv(whole(sample, "a sample") * BIG, hertz(hz)))
export const flicksToSamples = (t, hz) => safe(floorDiv(whole(t, "a time") * hertz(hz), BIG))

/** @param {"floor" | "ceil" | "nearest"} mode */
export function snapToFrame(t, rate, mode = "nearest") {
  const below = framesToFlicks(flicksToFrames(t, rate), rate)
  if (below === t || mode === "floor") return below
  const above = framesToFlicks(flicksToFrames(t, rate) + 1, rate)
  if (mode === "ceil") return above
  return t - below < above - t ? below : above
}

/** t × n/d, rounded up so a scaled clip never loses its tail. */
export function scaleFlicks(t, { n, d }) {
  return safe(ceilDiv(whole(t, "a time") * BigInt(n), BigInt(d)))
}

/** The index of the frame showing at t, from a VFR file's sorted timestamps. */
export function frameAtTimestamp(table, t) {
  let low = 0
  let high = table.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (table[middle] <= t) low = middle
    else high = middle - 1
  }
  return low
}

// Edge only: an exact decimal string for an FFmpeg argument
export function secondsArg(t) {
  // Integer division prints -1/6 s as "0.-166666666", which FFmpeg misreads (found in ED11)
  if (t < 0) throw new RangeError(`a time for FFmpeg can't be negative, got ${t}`)
  const nano = (whole(t, "a time") * 2_000_000_000n + BIG) / (2n * BIG)
  return `${nano / 1_000_000_000n}.${String(nano % 1_000_000_000n).padStart(9, "0")}`
}

const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b))

// Edge only: FCPXML's rational seconds, such as 1001/24000s
export function fractionSeconds(t) {
  const divisor = gcd(t, FLICKS)
  if (t === 0) return "0s"
  return divisor === FLICKS ? `${t / FLICKS}s` : `${t / divisor}/${FLICKS / divisor}s`
}

const two = (value) => String(value).padStart(2, "0")

/** Non-drop timecode: frames counted at the nominal rate, as CMX 3600 expects. */
export function timecode(frame, rate) {
  const base = Math.ceil(rate.n / rate.d)
  const seconds = Math.floor(frame / base)
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60, frame % base].map(two).join(":")
}

// Edge only: HH:MM:SS,mmm for SRT and VTT
export function clockTime(t, separator) {
  const total = Math.round(t / 705_600)
  const seconds = Math.floor(total / 1000)
  return `${two(Math.floor(seconds / 3600))}:${two(Math.floor(seconds / 60) % 60)}:${two(seconds % 60)}${separator}${String(total % 1000).padStart(3, "0")}`
}
