// L7 Picture quality per shot: blur, exposure, shake, motion, measured in code on
// small grey frames FFmpeg decodes at 4 a second. One pass, no OpenCV needed yet.

export const QUALITY_VERSION = "l7-1"
export const W = 160
export const H = 90
export const RATE = 4
const STEP = 705_600_000 / RATE
const SEARCH = 4 // pixels of shift tried each way, on a half-size copy

export const qualityArgs = (source) => ["-hide_banner", "-nostdin", "-loglevel", "error", "-protocol_whitelist", "file,pipe", "-i", source, "-an", "-sn", "-dn", "-vf", `fps=${RATE},scale=${W}:${H},format=gray`, "-f", "rawvideo", "pipe:1"]

// Variance of the Laplacian: low when nothing has edges
function sharpness(f) {
  let sum = 0
  let squares = 0
  let n = 0
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x
      const v = 4 * f[i] - f[i - 1] - f[i + 1] - f[i - W] - f[i + W]
      sum += v
      squares += v * v
      n++
    }
  }
  return squares / n - (sum / n) ** 2
}

function half(f) {
  const w = W / 2
  const h = H / 2
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = (f[2 * y * W + 2 * x] + f[2 * y * W + 2 * x + 1] + f[(2 * y + 1) * W + 2 * x] + f[(2 * y + 1) * W + 2 * x + 1]) / 4
  return out
}

const CAMERA = 0.7 // shortcut: judged on synthetic charts; tune on real handheld footage

function shiftCost(a, b, w, h, dx, dy) {
  let cost = 0
  let n = 0
  for (let y = SEARCH; y < h - SEARCH; y++) {
    for (let x = SEARCH; x < w - SEARCH; x++) {
      cost += Math.abs(a[y * w + x] - b[(y + dy) * w + x + dx])
      n++
    }
  }
  return cost / n
}

/** The whole-frame shift between two frames that matches best, by mean absolute difference. */
export function globalShift(a, b, w = W / 2, h = H / 2) {
  const tried = []
  for (let dy = -SEARCH; dy <= SEARCH; dy++) for (let dx = -SEARCH; dx <= SEARCH; dx++) tried.push({ dx, dy, cost: shiftCost(a, b, w, h, dx, dy) })
  const lowest = Math.min(...tried.map((t) => t.cost))
  // Near-ties go to the smallest shift: a chart with no vertical detail can't say how it moved vertically
  const best = tried.filter((t) => t.cost <= lowest * 1.05 + 0.05).sort((p, q) => Math.hypot(p.dx, p.dy) - Math.hypot(q.dx, q.dy))[0]
  // Objects moving in a still frame barely help any shift; a moving camera helps a lot
  const still = shiftCost(a, b, w, h, 0, 0)
  return best.cost < still * CAMERA ? best : { dx: 0, dy: 0, cost: still }
}

/** Collects frames from FFmpeg's stdout. @returns {{ add: (chunk: Buffer) => void, finish: () => object[] }} */
export function qualityCollector() {
  const size = W * H
  const samples = []
  let carry = Buffer.alloc(0)
  let previous = null
  const take = (frame) => {
    const small = half(frame)
    let mean = 0
    let clipped = 0
    for (const v of frame) {
      mean += v
      if (v <= 16 || v >= 235) clipped++
    }
    const shift = previous ? globalShift(previous, small) : { dx: 0, dy: 0 }
    samples.push({ t: samples.length * STEP, sharpness: sharpness(frame), luma: mean / size / 255, clipped: clipped / size, dx: shift.dx, dy: shift.dy })
    previous = small
  }
  return {
    add(chunk) {
      carry = Buffer.concat([carry, chunk])
      while (carry.length >= size) {
        take(carry.subarray(0, size))
        carry = carry.subarray(size)
      }
    },
    finish: () => samples,
  }
}

const mean = (values) => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null)
const round = (value) => (value === null ? null : Math.round(value * 1000) / 1000)

/**
 * Per-shot scores, each 0 to 1. shortcut: blur and shake scales are uncalibrated
 * (synthetic charts only); tune on real footage before a gate depends on them.
 */
export function scoreShots(samples, shots) {
  return shots.map((shot) => {
    const own = samples.filter((s) => s.t >= shot.start && s.t < shot.end)
    if (!own.length) return { blur: null, exposure: null, shake: null, motion: null }
    // The first sample after a cut compares across it: not motion
    const moves = own.slice(1).map((s) => Math.hypot(s.dx, s.dy))
    // Shake is the jitter left after the steady part of the motion
    const jitter = own.slice(2).map((s, i) => Math.hypot(s.dx - own[i + 1].dx, s.dy - own[i + 1].dy))
    const sharp = mean(own.map((s) => s.sharpness))
    const luma = mean(own.map((s) => s.luma))
    const clipped = mean(own.map((s) => s.clipped))
    return {
      blur: round(1 / (1 + sharp / 100)),
      // 0 is well exposed; 1 is black, white or clipped throughout
      exposure: round(Math.min(1, Math.abs(luma - 0.45) / 0.45 + clipped)),
      shake: moves.length > 1 ? round(Math.min(1, mean(jitter) / SEARCH)) : 0,
      motion: moves.length ? round(Math.min(1, mean(moves) / SEARCH)) : 0,
    }
  })
}
