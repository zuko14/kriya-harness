// Reframe solver (EDIT_ENGINE §5.2): a crop path that moves like a camera operator.
// L1 trend filtering, min ½‖x−y‖² + hold‖D₁x‖₁ + smooth‖D₂x‖₁, gives long holds and
// decisive moves. One small ADMM serves both penalties, so no separate taut-string
// pass is needed. Pixels here are floats; they are rounded before they leave.

const soft = (value, limit) => Math.sign(value) * Math.max(Math.abs(value) - limit, 0)

// LDLᵀ of the symmetric pentadiagonal I + ρ(D₁ᵀD₁ + D₂ᵀD₂), factored once per shot
function factor(n, rho) {
  const d = new Float64Array(n).fill(1)
  const e = new Float64Array(n)
  const f = new Float64Array(n)
  const add = (row) => {
    row.forEach(([i, a]) => {
      row.forEach(([j, b]) => {
        if (i === j) d[i] += rho * a * b
        else if (j === i + 1) e[i] += rho * a * b
        else if (j === i + 2) f[i] += rho * a * b
      })
    })
  }
  for (let i = 0; i + 1 < n; i++) add([[i, -1], [i + 1, 1]])
  for (let i = 0; i + 2 < n; i++) add([[i, 1], [i + 1, -2], [i + 2, 1]])
  const l1 = new Float64Array(n)
  const l2 = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    if (i > 0) d[i] -= l1[i - 1] ** 2 * d[i - 1]
    if (i > 1) d[i] -= l2[i - 2] ** 2 * d[i - 2]
    if (i + 1 < n) l1[i] = (e[i] - (i > 0 ? l1[i - 1] * l2[i - 1] * d[i - 1] : 0)) / d[i]
    if (i + 2 < n) l2[i] = f[i] / d[i]
  }
  return { d, l1, l2 }
}

function solveFactored({ d, l1, l2 }, rhs) {
  const n = rhs.length
  const x = Float64Array.from(rhs)
  for (let i = 1; i < n; i++) x[i] -= l1[i - 1] * x[i - 1] + (i > 1 ? l2[i - 2] * x[i - 2] : 0)
  for (let i = 0; i < n; i++) x[i] /= d[i]
  for (let i = n - 2; i >= 0; i--) x[i] -= l1[i] * x[i + 1] + (i + 2 < n ? l2[i] * x[i + 2] : 0)
  return x
}

function trendFilter(y, hold, smooth, iterations) {
  const n = y.length
  if (n < 3) return y
  const rho = Math.max((hold + smooth) / 8, 1)
  const factored = factor(n, rho)
  const z1 = new Float64Array(n - 1)
  const u1 = new Float64Array(n - 1)
  const z2 = new Float64Array(n - 2)
  const u2 = new Float64Array(n - 2)
  let x = Float64Array.from(y)
  for (let k = 0; k < iterations; k++) {
    const rhs = Float64Array.from(y)
    for (let i = 0; i + 1 < n; i++) {
      const v = rho * (z1[i] - u1[i])
      rhs[i] -= v
      rhs[i + 1] += v
    }
    for (let i = 0; i + 2 < n; i++) {
      const v = rho * (z2[i] - u2[i])
      rhs[i] += v
      rhs[i + 1] -= 2 * v
      rhs[i + 2] += v
    }
    x = solveFactored(factored, rhs)
    for (let i = 0; i + 1 < n; i++) {
      const dx = x[i + 1] - x[i]
      z1[i] = soft(dx + u1[i], hold / rho)
      u1[i] += dx - z1[i]
    }
    for (let i = 0; i + 2 < n; i++) {
      const dx = x[i] - 2 * x[i + 1] + x[i + 2]
      z2[i] = soft(dx + u2[i], smooth / rho)
      u2[i] += dx - z2[i]
    }
  }
  return Array.from(x)
}

const FLICKS = 705_600_000

// ET-SOL-03: no whip. One pass each way caps every move at maxSpeed px a second; their
// mean is just as capped and centres the ramp on the subject's move
function limitSpeed(path, samples, maxSpeed) {
  const reach = (i, j) => (maxSpeed * Math.abs(samples[j].t - samples[i].t)) / FLICKS
  const ahead = [...path]
  for (let i = 1; i < ahead.length; i++) ahead[i] = Math.min(Math.max(ahead[i], ahead[i - 1] - reach(i, i - 1)), ahead[i - 1] + reach(i, i - 1))
  const behind = [...path]
  for (let i = behind.length - 2; i >= 0; i--) behind[i] = Math.min(Math.max(behind[i], behind[i + 1] - reach(i, i + 1)), behind[i + 1] + reach(i, i + 1))
  return path.map((_, i) => (ahead[i] + behind[i]) / 2)
}

function solveShot(samples, { sourceWidth, cropWidth, deadzone = 0, hold = 40, smooth = 20, margin = 0, maxSpeed, iterations = 400 }) {
  if (samples.length === 0) return []
  const target = []
  for (const { x } of samples) {
    const held = target.at(-1)
    target.push(held !== undefined && Math.abs(x - held) <= deadzone ? held : x)
  }
  const half = cropWidth / 2
  const filtered = trendFilter(target, hold, smooth, iterations)
  const path = (maxSpeed ? limitSpeed(filtered, samples, maxSpeed) : filtered).map((center, i) => {
    // The subject's whole box stays in (w from L8), not just its centre; a box wider than the crop keeps its centre
    const { x: subject, w = 0 } = samples[i]
    const inset = Math.min(half, margin + w / 2)
    const inFrame = Math.min(Math.max(center, subject - half + inset), subject + half - inset)
    return Math.round(Math.min(Math.max(inFrame, half), sourceWidth - half) - half)
  })
  // Rounding leaves one-pixel ripple on a hold: a camera doesn't move a pixel
  for (let i = 1; i < path.length; i++) if (Math.abs(path[i] - path[i - 1]) <= 1) path[i] = path[i - 1]
  return path.map((x, i) => ({ t: samples[i].t, x }))
}

/**
 * Solves each shot alone, because a shot change resets the path.
 * @param {{ id: string, samples: { t: number, x: number, w?: number }[] }[]} shots w: the subject's box width
 * @param {{ sourceWidth: number, cropWidth: number, deadzone?: number, hold?: number, smooth?: number, margin?: number, maxSpeed?: number, iterations?: number }} options
 *   maxSpeed: px a second the crop may move (ET-SOL-03: no whips); keeping the subject in frame comes first
 * @returns {{ shot: string, path: { t: number, x: number }[] }[]} x is the crop's left edge
 */
export function solveReframe(shots, options) {
  return shots.map((shot) => ({ shot: shot.id, path: solveShot(shot.samples, options) }))
}
