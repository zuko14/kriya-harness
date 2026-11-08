// Colour (EDITOR_WORKFLOWS §6, ED13): `.cube` 3D LUTs read and checked before FFmpeg
// sees them, and colour matching by statistics. A shot's colour is measured in OKLab
// (mean and covariance over sampled frames); the closed-form Gaussian transport map
// T = Σs^(−1/2) (Σs^(1/2) Σt Σs^(1/2))^(1/2) Σs^(−1/2) carries one shot's statistics
// onto another's, within small limits, and is baked into a 33³ `.cube` for `lut3d`.
// No pixel is kept: only the numbers.

import { runTool } from "./tool.js"

export const CUBE = { minSize: 2, maxSize: 65, maxBytes: 16 * 1024 * 1024, size: 33 }
// "Within small limits" (§6 step 2): a match corrects a shot, it doesn't restyle it
export const MATCH_LIMITS = { scale: [0.5, 2], lightness: 0.25, chroma: 0.08 }
// A shot is off against its neighbour past these (OKLab units; L is 0–1)
export const OFF = { lightness: 0.04, chroma: 0.015 }

/* ─────────────────────────────── .cube files ─────────────────────────────── */

const bad = (why) => {
  throw new RangeError(`This LUT can't be used: ${why}.`)
}

/**
 * Reads an Adobe/Resolve `.cube` 3D LUT, refusing anything malformed.
 * @returns {{ title: string | null, size: number, min: number[], max: number[], table: Float32Array }} table: r fastest, then g, then b; 3 values each
 */
export function parseCube(text) {
  if (typeof text !== "string") bad("it isn't text")
  if (text.length > CUBE.maxBytes) bad("it is larger than 16 MB")
  let [title, size, min, max] = [null, null, [0, 0, 0], [1, 1, 1]]
  const values = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const [word, ...rest] = line.split(/\s+/)
    if (word === "TITLE") title = line.slice(5).trim().replace(/^"|"$/g, "")
    else if (word === "LUT_3D_SIZE") size = Number(rest[0])
    else if (word === "LUT_1D_SIZE") bad("it is a 1D LUT; only 3D LUTs are read")
    else if (word === "DOMAIN_MIN" || word === "DOMAIN_MAX" || word === "LUT_3D_INPUT_RANGE") {
      const nums = rest.map(Number)
      const triple = word === "LUT_3D_INPUT_RANGE" ? null : nums
      if (word === "LUT_3D_INPUT_RANGE") [min, max] = [[nums[0], nums[0], nums[0]], [nums[1], nums[1], nums[1]]]
      else if (triple.length !== 3 || !triple.every(Number.isFinite)) bad(`${word} needs three numbers`)
      else if (word === "DOMAIN_MIN") min = triple
      else max = triple
    } else if (/^[-+.\d]/.test(word)) {
      const triple = [word, ...rest].map(Number)
      if (triple.length !== 3 || !triple.every((v) => Number.isFinite(v) && Math.abs(v) <= 16)) bad(`a row isn't three numbers: "${line.slice(0, 40)}"`)
      values.push(...triple)
    } else bad(`it has a line this reader doesn't know: "${word.slice(0, 20)}"`)
  }
  if (!Number.isInteger(size) || size < CUBE.minSize || size > CUBE.maxSize) bad(`its size must be ${CUBE.minSize} to ${CUBE.maxSize}`)
  if (values.length !== size ** 3 * 3) bad(`it has ${values.length / 3} rows, not ${size ** 3}`)
  if (min.some((v, i) => !(v < max[i]))) bad("its domain is empty")
  return { title, size, min, max, table: Float32Array.from(values) }
}

/** A `.cube` file's text, with the identity domain. */
export function cubeText({ size, table, title = null }) {
  const lines = [...(title ? [`TITLE "${String(title).replace(/["\r\n]/g, "")}"`] : []), `LUT_3D_SIZE ${size}`]
  for (let i = 0; i < table.length; i += 3) lines.push(`${table[i].toFixed(6)} ${table[i + 1].toFixed(6)} ${table[i + 2].toFixed(6)}`)
  return `${lines.join("\n")}\n`
}

/** One colour through a LUT, trilinear, as lut3d does by default. */
export function sampleCube({ size, table, min, max }, rgb) {
  const at = rgb.map((v, c) => Math.min(size - 1, Math.max(0, ((v - min[c]) / (max[c] - min[c])) * (size - 1))))
  const lo = at.map(Math.floor)
  const hi = lo.map((v) => Math.min(size - 1, v + 1))
  const f = at.map((v, c) => v - lo[c])
  const value = (r, g, b, c) => table[((b * size + g) * size + r) * 3 + c]
  return [0, 1, 2].map((c) => {
    let sum = 0
    for (const [r, wr] of [[lo[0], 1 - f[0]], [hi[0], f[0]]])
      for (const [g, wg] of [[lo[1], 1 - f[1]], [hi[1], f[1]]])
        for (const [b, wb] of [[lo[2], 1 - f[2]], [hi[2], f[2]]]) sum += wr * wg * wb * value(r, g, b, c)
    return sum
  })
}

/* ──────────────────────────────── OKLab ──────────────────────────────── */

const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const toGamma = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)

/** sRGB-encoded 0–1 → OKLab (Björn Ottosson's matrices). */
export function toOklab([r, g, b]) {
  const [lr, lg, lb] = [r, g, b].map(toLinear)
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}

/** OKLab → sRGB-encoded 0–1, clamped. */
export function fromOklab([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const linear = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
  return linear.map((v) => Math.min(1, Math.max(0, toGamma(Math.min(1, Math.max(0, v))))))
}

/* ───────────────────────────── statistics ───────────────────────────── */

/**
 * Colour statistics of RGB24 pixels: OKLab mean and covariance, a 16-bin lightness
 * histogram, contrast (lightness spread) and saturation (mean chroma). Numbers only.
 * @param {Uint8Array} rgb
 */
export function statsOf(rgb, step = 1) {
  const mean = [0, 0, 0]
  const moment = [0, 0, 0, 0, 0, 0] // LL La Lb aa ab bb
  const luma = new Array(16).fill(0)
  let [n, chroma] = [0, 0]
  for (let i = 0; i + 2 < rgb.length; i += 3 * step) {
    const [L, a, b] = toOklab([rgb[i] / 255, rgb[i + 1] / 255, rgb[i + 2] / 255])
    mean[0] += L
    mean[1] += a
    mean[2] += b
    moment[0] += L * L
    moment[1] += L * a
    moment[2] += L * b
    moment[3] += a * a
    moment[4] += a * b
    moment[5] += b * b
    luma[Math.min(15, Math.floor(L * 16))]++
    chroma += Math.hypot(a, b)
    n++
  }
  if (!n) throw new RangeError("there are no pixels to measure")
  const m = mean.map((v) => v / n)
  const e = moment.map((v) => v / n)
  const cov = [
    [e[0] - m[0] * m[0], e[1] - m[0] * m[1], e[2] - m[0] * m[2]],
    [e[1] - m[0] * m[1], e[3] - m[1] * m[1], e[4] - m[1] * m[2]],
    [e[2] - m[0] * m[2], e[4] - m[1] * m[2], e[5] - m[2] * m[2]],
  ]
  return { mean: m, cov, luma: luma.map((v) => v / n), contrast: Math.sqrt(Math.max(0, cov[0][0])), saturation: chroma / n, n }
}

/** Samples `frames` frames of [from, to) seconds of a file, as small RGB24, through FFmpeg. */
export async function readFrames(file, { from = 0, to, frames = 12, width = 64, height = 36, run = runTool, signal }) {
  const span = Math.max(0.04, to - from)
  const chunks = []
  await run("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-ss", from.toFixed(3), "-t", span.toFixed(3), "-protocol_whitelist", "file,pipe", "-i", file, "-an", "-sn", "-dn", "-vf", `fps=${(frames / span).toFixed(4)},scale=${width}:${height}:flags=area,format=rgb24`, "-frames:v", String(frames), "-f", "rawvideo", "-"], { onStdout: (chunk) => chunks.push(chunk), signal, stallMs: 60_000 })
  return new Uint8Array(Buffer.concat(chunks))
}

/** A range of a file measured: statistics of its sampled frames (seconds). */
export async function measureColour(file, options) {
  return statsOf(await readFrames(file, options))
}

/** True when one shot is visibly off against another: exposure or white balance. */
export function offAgainst(shot, neighbour, limits = OFF) {
  return Math.abs(shot.mean[0] - neighbour.mean[0]) > limits.lightness || Math.hypot(shot.mean[1] - neighbour.mean[1], shot.mean[2] - neighbour.mean[2]) > limits.chroma
}

/* ───────────────────────────── the match ───────────────────────────── */

// Eigen-decomposition of a symmetric 3×3 matrix (Jacobi rotations)
function eigen(matrix) {
  const a = matrix.map((row) => [...row])
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] ** 2
    if (off < 1e-30) break
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-30) continue
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        for (let k = 0; k < 3; k++) {
          const [akp, akq] = [a[k][p], a[k][q]]
          a[k][p] = c * akp - s * akq
          a[k][q] = s * akp + c * akq
        }
        for (let k = 0; k < 3; k++) {
          const [apk, aqk] = [a[p][k], a[q][k]]
          a[p][k] = c * apk - s * aqk
          a[q][k] = s * apk + c * aqk
        }
        for (let k = 0; k < 3; k++) {
          const [vkp, vkq] = [v[k][p], v[k][q]]
          v[k][p] = c * vkp - s * vkq
          v[k][q] = s * vkp + c * vkq
        }
      }
    }
  }
  return { values: [a[0][0], a[1][1], a[2][2]], vectors: v }
}

const mul = (x, y) => x.map((row) => y[0].map((_, j) => row.reduce((sum, value, k) => sum + value * y[k][j], 0)))

// A function of a symmetric matrix through its eigenvalues; the floor only keeps rounding from going negative (squared spreads reach 1e-8)
function apply(matrix, fn, floor = 1e-14) {
  const { values, vectors } = eigen(matrix)
  const d = values.map((value) => fn(Math.max(value, floor)))
  return vectors.map((row, i) => [0, 1, 2].map((j) => [0, 1, 2].reduce((sum, k) => sum + vectors[i][k] * d[k] * vectors[j][k], 0)))
}

/**
 * The transport from one shot's colour to another's: x' = μt + T(x − μs), with T
 * limited so a match corrects rather than restyles.
 * @returns {{ matrix: number[][], from: number[], to: number[] }}
 */
export function transport(source, target, limits = MATCH_LIMITS) {
  // A ridge (a spread of 0.01 in OKLab) on both, so a grey shot's near-zero chroma spread stays invertible and equal shots map to themselves
  const ridge = (cov) => cov.map((row, i) => row.map((v, j) => v + (i === j ? 1e-4 : 0)))
  const [sc, tc] = [ridge(source.cov), ridge(target.cov)]
  const half = apply(sc, Math.sqrt)
  const inverseHalf = apply(sc, (v) => 1 / Math.sqrt(v))
  const middle = apply(mul(mul(half, tc), half), Math.sqrt)
  // Clamp the map's own scales, so a near-flat shot isn't stretched without end
  const matrix = apply(mul(mul(inverseHalf, middle), inverseHalf), (v) => Math.min(limits.scale[1], Math.max(limits.scale[0], v)))
  const shift = [target.mean[0] - source.mean[0], target.mean[1] - source.mean[1], target.mean[2] - source.mean[2]]
  const chroma = Math.hypot(shift[1], shift[2])
  const keep = chroma > limits.chroma ? limits.chroma / chroma : 1
  const to = [source.mean[0] + Math.max(-limits.lightness, Math.min(limits.lightness, shift[0])), source.mean[1] + shift[1] * keep, source.mean[2] + shift[2] * keep]
  return { matrix, from: source.mean, to }
}

/**
 * The match baked into a `.cube` (33³ by default), at `strength` 0–1.
 * @returns {{ size: number, table: Float32Array, min: number[], max: number[] }}
 */
export function matchCube(source, target, { size = CUBE.size, strength = 1, limits = MATCH_LIMITS } = {}) {
  const { matrix, from, to } = transport(source, target, limits)
  const table = new Float32Array(size ** 3 * 3)
  let i = 0
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const rgb = [r, g, b].map((v) => v / (size - 1))
        const lab = toOklab(rgb)
        const d = lab.map((v, c) => v - from[c])
        const moved = [0, 1, 2].map((c) => to[c] + matrix[c][0] * d[0] + matrix[c][1] * d[1] + matrix[c][2] * d[2])
        const out = fromOklab(moved)
        for (let c = 0; c < 3; c++) table[i++] = rgb[c] + (out[c] - rgb[c]) * strength
      }
    }
  }
  return { size, table, min: [0, 0, 0], max: [1, 1, 1] }
}

/**
 * Per-shot balance (§6 step 2) as operations: each base clip that is off against the
 * one before it is matched to the first clip it isn't off against, walking back.
 * @param {{ clip: string, stats: object }[]} clips in timeline order
 * @returns {{ op: "match_color", clip: string, reference: string }[]}
 */
export function balanceOps(clips, limits = OFF) {
  const ops = []
  const settled = []
  for (const { clip, stats } of clips) {
    const before = settled.at(-1)
    if (before && offAgainst(stats, before.stats, limits)) ops.push({ op: "match_color", clip, reference: before.clip })
    else settled.push({ clip, stats })
  }
  return ops
}
