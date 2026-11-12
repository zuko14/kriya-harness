// Graphic clips (MOTION_GRAPHICS.md): an approved plan's motion graphics as operations on the
// cut as solved. Each is anchored to its word, so it moves with the speech; code checks again
// what the plan checked, since a re-cut can drop a line or put a scene where a graphic was.

import { solve } from "../core/solver.js"
import { ALL_GRAPHIC_KINDS, cleanGraphic, GRAPHIC_BLOCK, GRAPHIC_VERSION, graphicLength } from "../engine/graphics.js"
import { graphicLine } from "../director/graphics.js"

const FLICKS = 705_600_000
const MIN_LENGTH = 1.2 * FLICKS
const GAP = 0.5 * FLICKS

/** A graphic an approved plan put there, which a remake replaces (one added in chat stays). */
export const isPlanGraphic = (effect) => effect?.type === "block" && effect.blockId === GRAPHIC_BLOCK && effect.variables?.plan === true

/**
 * @param {{ graphics: object[], project: object, index: object, asset: string, kept: { id: string }[] }} input
 *   project: with the cut and its scenes applied; kept: the words the cut keeps, in order
 * @returns {{ ops: object[], notes: string[] }}
 */
export function graphicOps({ graphics, project, index, asset, kept }) {
  const ops = []
  const notes = []
  const timeline = solve(project, index)
  const story = timeline.picture.filter((p) => !p.echo && !p.hold)
  const outputOf = (word) => {
    const piece = story.find((p) => p.asset === asset && word.start >= p.in && word.start <= p.out)
    return piece ? piece.at + (word.start - piece.in) : null
  }
  // Whatever already takes over the frame: scenes, definitions, pictures laid over the story
  const taken = timeline.overlays.map((o) => ({ at: o.at, end: o.end }))
  const words = kept.map((w) => ({ ...w, out: outputOf(w) })).filter((w) => w.out !== null).sort((a, b) => a.out - b.out)
  if (!words.length) return { ops, notes }
  for (const raw of graphics) {
    // The make route is the switch's gate (EH-92): it lets motion kit 2 through only with editing.typeKit on, and a
    // callout round a drawn box only with editing.customMotion on. What reaches here was approved, so it is placed
    const graphic = cleanGraphic(raw, ALL_GRAPHIC_KINDS)
    if (!graphic) continue
    const length = graphicLength(graphic)
    const leave = (reason) => notes.push(`Left out the ${graphicLine(graphic)}: ${reason}.`)
    // The end card starts on the last word that leaves it its full length; the opening title on the first
    const word = graphic.kind === "intro" ? words[0] : graphic.kind === "end" ? (words.findLast((w) => w.out <= timeline.duration - length) ?? words[0]) : words.find((w) => w.id === graphic.at)
    if (!word) {
      leave("its line isn't in this cut")
      continue
    }
    const at = word.out
    const duration = Math.min(length, timeline.duration - at)
    const end = at + duration
    if (duration < MIN_LENGTH) leave("there isn't time for it before the cut ends")
    else if (taken.some((t) => at < t.end + GAP && t.at < end + GAP)) leave("something else is on screen there")
    else {
      taken.push({ at, end })
      const { at: _word, ...variables } = graphic
      ops.push({ op: "add_motion", block: GRAPHIC_BLOCK, version: GRAPHIC_VERSION, variables: { ...variables, plan: true }, at: { word: word.id, edge: "start" }, duration })
    }
  }
  return { ops, notes }
}
