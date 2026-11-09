// A music-led montage (DP5): the person's song leads, and their clips cut on its beats. Each cut lands
// on a beat of the song's own grid, each clip moves through new parts of its source, and the clips'
// own sound goes, so what's heard is the song.

import { apply } from "../core/ops.js"
import { solve } from "../core/solver.js"
import { recipeFor } from "./reel.js"

const FLICKS = 705_600_000
const MIN_SHOT = 0.8 * FLICKS
const MAX_SHOT = 5 * FLICKS

/** Shot lengths from the song's beats: every beat that's at least MIN_SHOT on from the last cut, up to `total`. */
export function beatCuts(beats, total) {
  const times = [...new Set(beats.map((b) => b.t))].filter((t) => t > 0 && t <= total).sort((a, b) => a - b)
  const cuts = []
  let last = 0
  for (const t of times) {
    if (t - last < MIN_SHOT) continue
    // A long gap in the beat grid still gets a picture change
    while (t - last > MAX_SHOT) {
      last += MAX_SHOT
      cuts.push(last)
    }
    cuts.push(t)
    last = t
  }
  return cuts
}

/** @param {{ project: object, index: object, brief: object }} input brief.music: the song's asset id */
export function planMontage({ project, index, brief = {} }) {
  const recipe = recipeFor(brief)
  const song = project.assets.find((a) => a.id === brief.music && a.kind === "audio")
  const clips = project.assets.filter((a) => a.kind === "video" && (a.facts.duration ?? 0) >= MIN_SHOT)
  if (!song) throw new Error("A montage needs a song in the project.")
  if (!clips.length) throw new Error("A montage needs at least one video in the project.")
  const footage = clips.reduce((sum, a) => sum + a.facts.duration, 0)
  const total = Math.min(brief.targetDuration ?? song.facts.duration, song.facts.duration, footage)
  const beats = (index.beats ?? []).filter((b) => b.asset === song.id)
  const notes = []
  if (!beats.length) notes.push("This song has no beat grid, so the cuts follow an even rhythm instead of its beats.")
  const cuts = beats.length ? beatCuts(beats, total) : Array.from({ length: Math.floor(total / (2 * FLICKS)) }, (_, i) => (i + 1) * 2 * FLICKS)
  const edges = [0, ...cuts.filter((c) => c < total - MIN_SHOT), total]
  const sequence = project.sequences.find((q) => q.id === project.active)
  const rebuilt = new Set(sequence.tracks.filter((t) => ["base", "caption", "music"].includes(t.role)).map((t) => t.id))
  const ops = [
    ...sequence.clips.filter((c) => rebuilt.has(c.track) || c.effects?.some((e) => e.blockId === "scene")).map((c) => ({ op: "ripple_delete", clip: c.id })),
    { op: "set_brief", format: recipe.id, targetDuration: total, mustKeep: [], mustCut: [], effort: brief.effort ?? "best" },
    { op: "set_format", width: recipe.canvas.width, height: recipe.canvas.height, fps: recipe.deliverable.fps },
    ...(project.deliverables.some((d) => d.preset === recipe.deliverable.preset) ? [] : [{ op: "add_deliverable", ...recipe.deliverable }]),
  ]
  // Round the clips, each from where it last stopped, wrapping when one runs out
  const played = new Map(clips.map((a) => [a.id, 0]))
  for (let i = 0; i + 1 < edges.length; i++) {
    const length = edges[i + 1] - edges[i]
    const clip = clips[i % clips.length]
    let from = played.get(clip.id)
    if (from + length > clip.facts.duration) from = 0
    const to = Math.min(from + length, clip.facts.duration)
    played.set(clip.id, to)
    ops.push({ op: "keep_range", asset: clip.id, from, to, exact: true })
  }
  const cut = apply(project, ops, { index, author: "agent" })
  if (!cut.applied) throw new Error(`The montage was refused: ${cut.diagnostics[0].message}`)
  const after = cut.project.sequences.find((q) => q.id === cut.project.active)
  const base = new Set(after.tracks.filter((t) => t.role === "base").map((t) => t.id))
  const placed = after.clips.filter((c) => base.has(c.track))
  const all = [...ops, ...placed.map((c) => ({ op: "set_level", clip: c.id, db: -60 })), { op: "set_music", asset: song.id }, { op: "music_shape", fit: true, fadeIn: Math.round(FLICKS * 0.1) }]
  const step = apply(project, all, { index, author: "agent" })
  if (!step.applied) throw new Error(`The montage was refused: ${step.diagnostics[0].message}`)
  notes.push(`Cut ${placed.length} shots to the song's beats over ${(solve(step.project, index).duration / FLICKS).toFixed(1)} s.`)
  return { ops: all, project: step.project, notes, calls: 0, slots: {} }
}
