// A reference's look on a cut (TP6, CRAFT_UPGRADE §4.2), only when the make's own brief carries it:
// grain, darker corners and bars as adjustments over the whole film, each a row of the effects
// registry (TP5). Each hangs on the cut's first clip, so the next make finds it and takes it out
// with that clip (audit §6 rule 6). One that doesn't fit (restraint, a missing filter, the effects
// switch off) is left out with a note and never fails the make (rule 7).

import { EFFECTS } from "../core/effects.js"
import { apply } from "../core/ops.js"
import { solve } from "../core/solver.js"

/**
 * @param {{ project: object, all: object[], step: { project: object }, fx: { effect: string, params?: object }[], index: object, notes: string[] }} input `all` gains the operations that were taken
 * @returns {{ project: object, applied: true }} the step to go on from
 */
export function referenceLook({ project, all, step, fx, index, notes }) {
  const timeline = solve(step.project, index)
  const first = timeline.picture.find((p) => !p.hold)
  if (!first) return step
  for (const { effect, params } of fx) {
    if (!Object.hasOwn(EFFECTS, effect)) continue
    const op = { op: "add_adjustment", at: { clip: first.clip, edge: "start" }, duration: timeline.duration, effect, ...(params ? { params } : {}) }
    const tried = apply(project, [...all, op], { index, author: "agent" })
    if (tried.applied) {
      all.push(op)
      step = tried
    } else notes.push(`The reference's ${EFFECTS[effect].label.toLowerCase()} was left out: ${tried.diagnostics[0]?.message ?? "it doesn't fit this cut"}.`)
  }
  return step
}
