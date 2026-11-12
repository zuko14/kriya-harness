// "Give me three openings" (TP8, CRAFT_UPGRADE §6.5, editing.directorLoop): three short drafts of the
// first eight seconds, each opening on a different line, for the person to pick one on the Variations
// wall. The lines are chosen by code from the index's own scores, so it costs no model call; the
// pick goes back as the next make's hook, which the make route already takes.

import { candidateLines, planReel, recipeFor } from "./reel.js"

const FLICKS = 705_600_000
export const OPENING = 8 * FLICKS
export const OPENINGS = 3

// Every slot takes its code default: an opening is a sketch, not a story the model chose
const byCode = async (slot) => ({ value: slot.fallback(), source: "default", calls: 0 })

/** The three hooks: the best-scored distinct lines, at most one from any eight seconds of the take, in score order. */
export function hooksFor(index, asset) {
  const lines = candidateLines(index, asset).filter((l) => l.words.length >= 3)
  const picked = []
  for (const line of [...lines].sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.start - b.start)) {
    if (picked.some((p) => Math.abs(p.start - line.start) < OPENING)) continue
    picked.push(line)
    if (picked.length === OPENINGS) break
  }
  return picked.map((l) => ({ id: l.id, words: l.words.filter((w) => !w.flags?.includes("filler")).slice(0, 8).map((w) => w.text).join(" ") }))
}

/** Each opening as a planned project: the hook first, fitted to eight seconds, the brief's look kept. */
export async function planOpenings({ project, index, asset, brief = {}, signal }) {
  const out = []
  for (const hook of hooksFor(index, asset)) {
    signal?.throwIfAborted()
    const made = await planReel({ project, index, asset, ask: byCode, brief: { ...brief, targetDuration: OPENING, hook: hook.id, mustKeep: [hook.id], effort: "fast" }, variant: { tighter: OPENING / recipeFor(brief).target.max }, signal })
    out.push({ hook, project: made.project })
  }
  return out
}
