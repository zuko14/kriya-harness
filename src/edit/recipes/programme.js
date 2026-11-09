// A podcast from a plan (DP2): `planMulticam` makes the switching, this dresses it with what the
// brief asked for. Captions read the master's words, so they follow the talk through every switch.

import { apply } from "../core/ops.js"
import { LOOKS, pages, readablePages } from "../engine/captions.js"
import { planMulticam, PODCAST_MULTICAM } from "./multicam.js"

export const programmeRecipe = { ...PODCAST_MULTICAM }

/** @param {{ project: object, index: object, brief: object, multicam: { master: string, angles: object[], analysis: object } }} input */
export function planProgramme({ project, index, brief = {}, multicam }) {
  const made = planMulticam({ project, index, ...multicam, brief })
  const words = (index.words ?? []).filter((w) => w.asset === multicam.master && !w.flags?.includes("trimmed"))
  const captions = LOOKS[brief.captions] ? (index.sentences ?? []).filter((s) => s.asset === multicam.master).flatMap((s) => {
    const run = words.filter((w) => w.start >= s.start && w.end <= s.end)
    return readablePages(pages(run), run)
  }).map((ids) => ({ op: "caption_style", look: brief.captions, words: ids })) : []
  const captionLook = { ...(brief.captionStyle ?? {}), ...(brief.holdCaptions ? { hold: true } : {}) }
  const style = Object.keys(captionLook).length ? [{ op: "set_look", caption: captionLook }] : []
  const ops = [...made.ops, ...style, ...captions]
  const step = apply(project, ops, { index, author: "agent" })
  if (!step.applied) throw new Error(`The programme was refused: ${step.diagnostics[0].message}`)
  return { ops, project: step.project, notes: made.notes, calls: 0, slots: {} }
}
