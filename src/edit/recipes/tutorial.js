// `tutorial` (EDITOR_WORKFLOWS §3.2, §12 "zoom-to-click"): a screen recording becomes
// a tight 16:9 lesson. From the L9 screen track, code finds the actions (typing, a
// click that opens something), zooms smoothly into each, and shortens stretches where
// nothing moves and nobody speaks. "Thinking" stays when something happens on screen.
// No model call: every choice here is measured.

import { apply } from "../core/ops.js"

const FLICKS = 705_600_000

/** The recipe is data (ET-RCP-01): no command, path, URL, model or price. */
export const TUTORIAL = {
  id: "tutorial",
  canvas: { width: 1920, height: 1080 },
  deliverable: { preset: "youtube-16x9", size: { width: 1920, height: 1080 }, fps: { n: 30, d: 1 }, codec: "h264", audio: "aac", loudness: { lufs: -14, tp: -1 }, burnCaptions: false, gates: ["QG-01", "QG-02", "QG-03", "QG-04", "QG-05", "QG-06", "QG-07", "QG-11", "QG-12", "QG-13", "QG-14"] },
  thresholds: { lengthTolerance: 0.5 },
  still: { longest: Math.round(1.5 * FLICKS), keep: Math.round(0.5 * FLICKS) }, // a still stretch over 1.5 s keeps 0.5 s
  wordPad: Math.round(0.24 * FLICKS), // silence this close to a word is speech
  zoom: { min: 1.25, max: 2, room: 1.8, lead: Math.round(0.4 * FLICKS), tail: Math.round(0.8 * FLICKS), merge: FLICKS, shortest: Math.round(1.2 * FLICKS), widest: 0.5, ease: "smooth" },
  notes: "Recipe: a screen tutorial. Zoom where the action is; cut waiting, keep thinking while the screen moves.",
}

const union = (a, b) => {
  const [x0, y0] = [Math.min(a.x, b.x), Math.min(a.y, b.y)]
  return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 }
}

/**
 * Actions: runs of samples where a region changed, joined across short gaps while the
 * region stays compact. A change wider than half the screen (a page load, a scroll)
 * isn't an action to zoom into.
 * @returns {{ start: number, end: number, box: object }[]} source flicks and pixels
 */
export function findActions(track, { width, height }, recipe = TUTORIAL) {
  const actions = []
  const step = track.length > 1 ? track[1].t - track[0].t : FLICKS / 5
  for (const sample of track) {
    if (!sample.change) continue
    const last = actions.at(-1)
    const joined = last && sample.t - last.end <= recipe.zoom.merge ? union(last.box, sample.change) : null
    if (joined && joined.w <= width * recipe.zoom.widest && joined.h <= height * recipe.zoom.widest) Object.assign(last, { end: sample.t, box: joined })
    else actions.push({ start: sample.t - step, end: sample.t, box: sample.change })
  }
  return actions.filter((a) => a.box.w <= width * recipe.zoom.widest && a.box.h <= height * recipe.zoom.widest)
}

/**
 * The ranges to keep: everything but the middle of still stretches. A sample is still
 * when nothing changed and the cursor didn't move; a word (with its pad) is never still.
 * @returns {{ from: number, to: number }[]} source flicks, in order
 */
export function keptRanges(track, words, duration, recipe = TUTORIAL) {
  const speaking = (from, to) => words.some((w) => w.start - recipe.wordPad < to && from < w.end + recipe.wordPad)
  const step = track.length > 1 ? track[1].t - track[0].t : FLICKS / 5
  const stills = []
  let run = null
  for (const sample of track) {
    const still = !sample.change && !sample.cursor && !speaking(sample.t - step, sample.t)
    if (still && run) run.to = sample.t
    else if (still) run = { from: sample.t - step, to: sample.t }
    else if (run) {
      stills.push(run)
      run = null
    }
  }
  if (run) stills.push(run)
  const ranges = []
  let from = 0
  for (const s of stills) {
    if (s.to - s.from <= recipe.still.longest) continue
    // keep half the allowance at each side, so the cut lands in the middle of the stillness
    const [cutFrom, cutTo] = [s.from + recipe.still.keep / 2, s.to - recipe.still.keep / 2]
    if (cutFrom > from) ranges.push({ from, to: cutFrom })
    from = cutTo
  }
  if (duration > from) ranges.push({ from, to: duration })
  return ranges
}

/** A zoom into `box`: scale so the box fills the frame with room, centre in thousandths. */
export function zoomFor(box, { width, height }, recipe = TUTORIAL) {
  const scale = Math.min(recipe.zoom.max, width / (box.w * recipe.zoom.room), height / (box.h * recipe.zoom.room))
  if (scale < recipe.zoom.min) return null
  const at = (v, size) => Math.max(0, Math.min(1000, Math.round((v / size) * 1000)))
  return { scale: Math.round(scale * 100) / 100, x: at(box.x + box.w / 2, width), y: at(box.y + box.h / 2, height) }
}

/**
 * Plans the tutorial as operations on `project`.
 * @param {{ project: object, index: object, asset: string, track: object[], brief?: object }} input
 *   track: L9 samples (index/layers/screen.js) for the asset
 * @returns {{ ops: object[], project: object, notes: string[], calls: number, slots: Record<string, string>, zooms: object[] }}
 */
export function planTutorial({ project, index, asset, track, brief = {} }) {
  const recipe = TUTORIAL
  const notes = []
  const facts = project.assets.find((a) => a.id === asset).facts
  const words = (index.words ?? []).filter((w) => w.asset === asset)
  const ranges = keptRanges(track, words, facts.duration, recipe)
  const saved = facts.duration - ranges.reduce((sum, r) => sum + r.to - r.from, 0)
  if (saved > 0) notes.push(`Shortened ${track.length ? "still stretches" : "nothing"}: ${(saved / FLICKS).toFixed(1)} s of waiting cut, ${(recipe.still.keep / FLICKS).toFixed(1)} s kept at each.`)

  const sequence = project.sequences.find((q) => q.id === project.active)
  const base = new Set(sequence.tracks.filter((t) => t.role === "base").map((t) => t.id))
  const ops = [
    ...sequence.clips.filter((c) => base.has(c.track)).map((c) => ({ op: "ripple_delete", clip: c.id })),
    { op: "set_brief", format: recipe.id, targetDuration: brief.targetDuration ?? ranges.reduce((sum, r) => sum + r.to - r.from, 0), mustKeep: brief.mustKeep ?? [], mustCut: brief.mustCut ?? [], effort: brief.effort ?? "best", ...(brief.language ? { language: brief.language } : {}) },
    { op: "set_format", width: recipe.canvas.width, height: recipe.canvas.height, fps: recipe.deliverable.fps },
    ...(project.deliverables.some((d) => d.preset === recipe.deliverable.preset) ? [] : [{ op: "add_deliverable", ...recipe.deliverable }]),
    ...ranges.map((r) => ({ op: "keep_range", asset, from: r.from, to: r.to })),
  ]
  const cut = apply(project, ops, { index, author: "agent" })
  if (!cut.applied) throw new Error(`The tutorial's cut was refused: ${cut.diagnostics[0].message}`)

  // Zooms: anchored to the clip that plays the action, so they follow later edits
  const clips = cut.project.sequences.find((q) => q.id === cut.project.active).clips.filter((c) => base.has(c.track) && c.source?.asset === asset)
  const zooms = []
  const frame = { width: facts.width, height: facts.height }
  for (const action of findActions(track, frame, recipe)) {
    const zoom = zoomFor(action.box, frame, recipe)
    const clip = clips.find((c) => c.source.in <= action.start + recipe.zoom.lead && action.start < c.source.out)
    if (!zoom || !clip) continue
    const from = Math.max(clip.source.in, action.start - recipe.zoom.lead)
    const to = Math.min(clip.source.out, Math.max(action.end + recipe.zoom.tail, from + recipe.zoom.shortest))
    if (to - from < recipe.zoom.shortest / 2) continue
    const last = zooms.at(-1)
    if (last && last.clip === clip.id && from <= last.to) continue // one zoom at a time
    zooms.push({ clip: clip.id, from, to, ...zoom, box: action.box })
  }
  const punches = zooms.map((z) => ({ op: "punch_in", at: { clip: z.clip, edge: "start", offset: z.from - clips.find((c) => c.id === z.clip).source.in }, duration: z.to - z.from, scale: z.scale, x: z.x, y: z.y, ease: recipe.zoom.ease }))
  if (zooms.length) notes.push(`Zoomed in on ${zooms.length} action${zooms.length === 1 ? "" : "s"} on screen.`)
  else notes.push("Found no compact action on screen to zoom into.")
  const all = [...ops, ...punches]
  const done = apply(project, all, { index, author: "agent" })
  if (!done.applied) throw new Error(`The tutorial was refused: ${done.diagnostics[0].message}`)
  return { ops: all, project: done.project, notes, calls: 0, slots: {}, zooms }
}
