// HDR to BT.709 as a .cube LUT, computed here so it needs only FFmpeg's `lut3d`:
// Homebrew's plain ffmpeg has no `zscale` (EF-37). Input is non-linear BT.2020 RGB,
// output non-linear BT.709 RGB. Pixels are floats; no time passes through here.

const PEAK_SDR = 203 // ITU-R BT.2408: the reference white of HDR graphics, in nits

const pqToNits = (v) => {
  const [m1, m2, c1, c2, c3] = [0.1593017578125, 78.84375, 0.8359375, 18.8515625, 18.6875]
  const p = v ** (1 / m2)
  return 10_000 * (Math.max(p - c1, 0) / (c2 - c3 * p)) ** (1 / m1)
}

// HLG's inverse OETF, then its system gamma for a 1000-nit display
const hlgToNits = (v) => {
  const [a, b, c] = [0.17883277, 0.28466892, 0.55991073]
  const scene = v <= 0.5 ? (v * v) / 3 : (Math.exp((v - c) / a) + b) / 12
  return 1000 * scene ** 1.2
}

const toLinear = { smpte2084: pqToNits, "arib-std-b67": hlgToNits }

// ITU-R BT.2087: BT.2020 primaries to BT.709, in linear light
const GAMUT = [
  [1.660491, -0.587641, -0.07285],
  [-0.124551, 1.1329, -0.008349],
  [-0.018151, -0.100579, 1.11873],
]

// Extended Reinhard, with HDR's 10,000-nit ceiling landing exactly on SDR white.
// shortcut: GAIN puts reference white near 84% code by eye, EDITOR_WORKFLOWS §6's grade tunes it on real footage
const GAIN = 2
const CEILING = (GAIN * 10_000) / PEAK_SDR
const shoulder = (level) => (level * (1 + level / CEILING ** 2)) / (1 + level)

const bt709 = (v) => (v < 0.018 ? 4.5 * v : 1.099 * v ** 0.45 - 0.099)

function mapRgb(rgb, linear) {
  const nits = rgb.map(linear)
  const light = GAMUT.map((row) => row[0] * nits[0] + row[1] * nits[1] + row[2] * nits[2])
  const clipped = light.map((v) => Math.max(v, 0) / PEAK_SDR)
  // On brightness, not per channel, so a bright colour keeps its hue
  const level = Math.max(...clipped)
  if (level === 0) return [0, 0, 0]
  const scale = shoulder(level * GAIN) / level
  return clipped.map((v) => bt709(Math.min(v * scale, 1)))
}

/** @param {"smpte2084" | "arib-std-b67"} transfer @param {number} [size] @returns {string} */
export function toneMapCube(transfer, size = 33) {
  const linear = toLinear[transfer]
  if (!linear) throw new RangeError(`${transfer} isn't an HDR transfer this can map`)
  const lines = [`LUT_3D_SIZE ${size}`]
  const step = (i) => i / (size - 1)
  // .cube order: red changes fastest
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) lines.push(mapRgb([step(r), step(g), step(b)], linear).map((v) => v.toFixed(6)).join(" "))
  return `${lines.join("\n")}\n`
}
