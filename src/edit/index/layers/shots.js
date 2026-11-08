// L6 Shots: hard cuts from FFmpeg's scene detector (`scdet`), on a small copy of
// the picture. Gradual transitions (fades, dissolves) need TransNetV2; until then a
// shot list has hard cuts only, and says so.

import { metadataFrames, ptsFlicks } from "./meta.js"

export const SHOTS_VERSION = "l6-1"
export const CUT_SCORE = 10 // scdet's own scale, 0–100; its documented default
const MICROS = 1_000_000

export const shotArgs = (source) => ["-hide_banner", "-nostdin", "-loglevel", "error", "-protocol_whitelist", "file,pipe", "-i", source, "-an", "-sn", "-dn", "-vf", `scale=320:-2,settb=AVTB,scdet=threshold=${CUT_SCORE}:sc_pass=1,metadata=mode=print:file=-`, "-f", "null", "-"]

/** Cut times → shots covering the whole asset. @returns {{ start: number, end: number, kind: string, score: number | null }[]} */
export function readShots(text, duration) {
  const cuts = metadataFrames(text)
    .map(({ pts, values }) => ({ t: ptsFlicks(pts, MICROS), score: Number(values["lavfi.scd.score"]) }))
    .filter(({ t }) => t > 0 && t < duration)
  const shots = []
  let start = 0
  let score = null
  for (const cut of cuts) {
    if (cut.t <= start) continue
    shots.push({ start, end: cut.t, kind: "cut", score })
    start = cut.t
    score = cut.score
  }
  if (duration > start) shots.push({ start, end: duration, kind: "cut", score })
  return shots
}
