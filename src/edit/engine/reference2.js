// A reference's colour, matched by measurement (TP6, CRAFT_UPGRADE §4.1, EDD-65), behind
// editing.referenceIntent: the person's own footage is measured in OKLab and carried toward the
// reference's measured statistics by the same transport a shot match uses (color.js), within its
// limits, and baked into a `.cube` Kriya writes. This replaces reference.js's 8-bit-average
// shortcut when the switch is on. Only numbers come from the reference: the LUT is a function of
// two sets of statistics and holds no pixel of anyone's video.

import { cubeText, matchCube, MATCH_LIMITS, measureColour } from "./color.js"
import { runTool } from "./tool.js"

/**
 * @param {string} file the person's own take
 * @param {number} seconds its length
 * @param {{ mean: number[], cov: number[][] }} colour an Edit DNA 2's colour
 * @returns {Promise<{ cube: string, limited: boolean, apart: { lightness: number, chroma: number } }>} limited: the footage was further from the reference than a match may move it
 */
export async function referenceMatch(file, seconds, colour, { run = runTool, signal, limits = MATCH_LIMITS } = {}) {
  const own = await measureColour(file, { from: 0, to: Math.min(seconds, 120), frames: 24, run, signal })
  return { ...referenceCube(own, colour, limits), own: { mean: own.mean } }
}

/** The LUT and how far apart the two were. Pure. */
export function referenceCube(own, colour, limits = MATCH_LIMITS) {
  const apart = { lightness: Math.abs(colour.mean[0] - own.mean[0]), chroma: Math.hypot(colour.mean[1] - own.mean[1], colour.mean[2] - own.mean[2]) }
  return { cube: cubeText({ ...matchCube(own, { mean: colour.mean, cov: colour.cov }, { limits }), title: "Kriya reference match" }), limited: apart.lightness > limits.lightness || apart.chroma > limits.chroma, apart }
}
