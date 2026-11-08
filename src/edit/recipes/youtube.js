// `youtube-longform` (EDITOR_WORKFLOWS §3.2, §10): an A-roll talk of 8 to 20+ minutes
// becomes a paced, chaptered YouTube cut. Code does all of it, with no model call:
// the story tree (PERCEPTION_AND_INDEX §8) gives scenes; each scene keeps its best
// takes with fillers and long pauses out; retention pacing changes the picture at the
// recipe's rate (faster in the intro), with punch-ins and B-roll; chapters come from
// the scenes; captions go out as a sidecar (SRT), not burned. Other tracks (music,
// effects) are left as they are, so the audio layout stays on its buses.

import { apply } from "../core/ops.js"
import { solve } from "../core/solver.js"
import { LOOKS, pages } from "../engine/captions.js"
import { chapterList, chapters, storyTree } from "../index/story.js"
import { candidateLines, fitLines, runsOf } from "./reel.js"

const FLICKS = 705_600_000
const MINUTE = 60 * FLICKS

/** The recipe is data (ET-RCP-01): no command, path, URL, model or price. */
export const YOUTUBE_LONGFORM = {
  id: "youtube-longform",
  target: { min: 8 * MINUTE, max: 40 * MINUTE, default: 15 * MINUTE },
  canvas: { width: 1920, height: 1080 },
  deliverable: { preset: "youtube-16x9", size: { width: 1920, height: 1080 }, fps: { n: 30, d: 1 }, codec: "h264", audio: "aac", loudness: { lufs: -14, tp: -1 }, burnCaptions: false, gates: ["QG-01", "QG-02", "QG-03", "QG-04", "QG-05", "QG-06", "QG-07", "QG-11", "QG-12", "QG-13", "QG-14"] },
  thresholds: { lengthTolerance: 0.1 },
  pace: { every: 12 * FLICKS, intro: 0.5, close: 0.8 }, // the longest a picture holds; the intro twice as fast, the close a little faster
  punch: { scale: 1.12 },
  broll: { length: 4 * FLICKS },
  endScreen: 20 * FLICKS,
  joinGap: Math.round(0.7 * FLICKS),
  captions: "clean",
  notes: "Recipe: a long YouTube video from a talk. Every scene keeps its point; the picture changes often enough to hold attention; chapters follow the story.",
}

/** Where each kept word plays on the timeline (pieces at their own speed). */
function wordTimes(timeline, index, asset) {
  const words = index.words.filter((w) => w.asset === asset)
  const times = new Map()
  for (const piece of timeline.picture) {
    if (piece.asset !== asset || piece.hold) continue
    const rate = piece.speed.d / piece.speed.n
    for (const w of words) if (w.start >= piece.in && w.start < piece.out && !times.has(w.id)) times.set(w.id, Math.round(piece.at + (w.start - piece.in) * rate))
  }
  return times
}

/** Times on the timeline where the picture changes: cuts, punch-ins, B-roll. */
export function pictureChanges(timeline) {
  return [...new Set([0, ...timeline.picture.map((p) => p.at), ...timeline.zooms.flatMap((z) => [z.at, z.end]), ...timeline.overlays.flatMap((o) => [o.at, o.end]), timeline.duration])].sort((a, b) => a - b)
}

// Words in groups no longer than `every`, for a punch-in on every other group
function chunks(words, every) {
  const out = [[]]
  for (const w of words) {
    if (out.at(-1).length && w.end - out.at(-1)[0].start > every) out.push([])
    out.at(-1).push(w)
  }
  return out
}

/**
 * Plans the long cut as operations on `project` (its assets and other tracks stay; the
 * base cut is replaced).
 * @param {{ project: object, index: object, asset: string, broll?: string[], brief?: object, cache?: Map<string, any> }} input
 * @returns {{ ops: object[], project: object, notes: string[], calls: number, tree: object, chapters: object[], chapterList: string, endScreen: { at: number, end: number } | null, pace: { every: number, longest: number, flat: { at: number, end: number }[] } }}
 */
export function planLongform({ project, index, asset, broll = [], brief = {}, cache, recipe = YOUTUBE_LONGFORM }) {
  const notes = []
  const tree = storyTree(index, asset, { cache })
  if (!tree.scenes.length) throw new Error("This recording has no transcript to cut from.")
  const sceneOf = new Map(tree.scenes.flatMap((scene, n) => scene.children.flatMap((id) => tree.beats.find((b) => b.id === id).sentences.map((s) => [s, n]))))

  // Every scene keeps its best takes; over the limit, the lines worth least go, never a scene's opener
  const all = candidateLines(index, asset).filter((l) => sceneOf.has(l.id))
  const lengthOf = (list) => list.reduce((sum, l) => sum + runsOf(l, recipe.joinGap).reduce((s, run) => s + run.at(-1).end - run[0].start, 0), 0)
  const limit = brief.targetDuration ?? recipe.target.max
  // Each scene's share of the length stays as it was, so no scene is cut to nothing
  const total = lengthOf(all)
  const lines = total <= limit ? all : tree.scenes.flatMap((_, n) => {
    const own = all.filter((l) => sceneOf.get(l.id) === n)
    return own.length ? fitLines(own, Math.floor((limit * lengthOf(own)) / total), new Set([own[0].id])) : []
  })
  if (lines.length < all.length) notes.push(`Left out ${all.length - lines.length} of ${all.length} lines to fit ${Math.round(limit / MINUTE)} minutes; every scene keeps its opening.`)
  const kept = lengthOf(lines)
  if (kept < recipe.target.min) notes.push(`The talk has ${(kept / MINUTE).toFixed(1)} minutes worth keeping, under this recipe's ${recipe.target.min / MINUTE}; nothing is padded.`)

  const sequence = project.sequences.find((q) => q.id === project.active)
  const base = new Set(sequence.tracks.filter((t) => t.role === "base").map((t) => t.id))
  const runs = lines.flatMap((line) => runsOf(line, recipe.joinGap).map((words) => ({ words, scene: sceneOf.get(line.id) })))
  const ops = [
    ...sequence.clips.filter((c) => base.has(c.track)).map((c) => ({ op: "ripple_delete", clip: c.id })),
    { op: "set_brief", format: recipe.id, targetDuration: brief.targetDuration ?? kept, mustKeep: brief.mustKeep ?? [], mustCut: brief.mustCut ?? [], effort: brief.effort ?? "best", ...(brief.language ? { language: brief.language } : {}) },
    { op: "set_format", width: recipe.canvas.width, height: recipe.canvas.height, fps: recipe.deliverable.fps },
    ...(project.deliverables.some((d) => d.preset === recipe.deliverable.preset) ? [] : [{ op: "add_deliverable", ...recipe.deliverable }]),
    ...runs.map(({ words }) => ({ op: "keep_range", asset, from: { word: words[0].id, edge: "start" }, to: { word: words.at(-1).id, edge: "end" } })),
  ]
  const cut = apply(project, ops, { index, author: "agent" })
  if (!cut.applied) throw new Error(`The long cut was refused: ${cut.diagnostics[0].message}`)

  // Chapters from the scenes, at the first word each scene plays
  const cutTimeline = solve(cut.project, index)
  // With no length asked for, the target is the cut itself, pads included
  if (brief.targetDuration === undefined) ops.find((op) => op.op === "set_brief").targetDuration = cutTimeline.duration
  const times = wordTimes(cutTimeline, index, asset)
  const sentences = new Map(index.sentences.map((s) => [s.id, s]))
  const words = index.words.filter((w) => w.asset === asset)
  const position = new Map(words.map((w, i) => [w.id, i]))
  const firstPlayed = (id) => {
    const s = sentences.get(id)
    return words.slice(position.get(s.firstWord), position.get(s.lastWord) + 1).find((w) => times.has(w.id)) ?? null
  }
  const found = chapters(tree, (id) => times.get(firstPlayed(id)?.id) ?? null, { duration: cutTimeline.duration })
  if (found.note) notes.push(found.note)
  const atWord = new Map([...times].map(([id, t]) => [t, id]))
  for (const chapter of found.chapters) {
    // On the scene's first played word, so it follows a later trim; 00:00 is the start itself
    ops.push({ op: "mark", name: chapter.title, at: chapter.at === 0 ? 0 : { word: atWord.get(chapter.at), edge: "start" } })
  }

  // Retention pacing: every cut is a change; inside a long run, a punch-in on every other stretch
  const every = (scene) => recipe.pace.every * (scene === 0 ? recipe.pace.intro : scene === tree.scenes.length - 1 ? recipe.pace.close : 1)
  for (const run of runs) {
    chunks(run.words, every(run.scene)).forEach((group, i) => {
      if (i % 2 === 1) ops.push({ op: "punch_in", at: { word: group[0].id, edge: "start" }, until: { word: group.at(-1).id, edge: "end" }, scale: recipe.punch.scale })
    })
  }
  // B-roll on each scene's second line, after its opener has set the scene
  if (broll.length) {
    let next = 0
    for (let scene = 1; scene < tree.scenes.length; scene++) {
      const second = runs.filter((r) => r.scene === scene)[1]
      if (!second) continue
      const id = broll[next++ % broll.length]
      const length = Math.min(recipe.broll.length, project.assets.find((a) => a.id === id).facts.duration ?? recipe.broll.length)
      ops.push({ op: "place_broll", asset: id, at: { word: second.words[0].id, edge: "start" }, in: 0, out: length })
    }
  }
  // Captions as a sidecar: YouTube takes the SRT; nothing is burned in
  const look = brief.captions === false ? null : LOOKS[brief.captions] ? brief.captions : recipe.captions
  if (look) for (const run of runs) for (const ids of pages(run.words)) ops.push({ op: "caption_style", look, words: ids })

  const done = apply(project, ops, { index, author: "agent" })
  if (!done.applied) throw new Error(`The long cut was refused: ${done.diagnostics[0].message}`)
  const timeline = solve(done.project, index)

  const changes = pictureChanges(timeline)
  const gaps = changes.slice(1).map((t, i) => ({ at: changes[i], end: t }))
  const longest = Math.max(0, ...gaps.map((g) => g.end - g.at))
  const flat = gaps.filter((g) => g.end - g.at > recipe.pace.every * 1.5)
  notes.push(`${tree.scenes.length} scenes from the story tree; ${runs.length} cuts; the picture changes at least every ${Math.round(longest / FLICKS)} s${flat.length ? `, except ${flat.length} flat stretch${flat.length === 1 ? "" : "es"}` : ""}.`)
  if (found.chapters.length) notes.push(`Chapters for the description:\n${chapterList(found.chapters)}`)
  const endScreen = timeline.duration >= recipe.endScreen + 5 * FLICKS ? { at: timeline.duration - recipe.endScreen, end: timeline.duration } : null
  if (endScreen) notes.push(`The last ${recipe.endScreen / FLICKS} s are the end-screen slot; keep cards clear of it.`)
  return { ops, project: done.project, notes, calls: 0, tree, chapters: found.chapters, chapterList: chapterList(found.chapters), endScreen, pace: { every: recipe.pace.every, longest, flat } }
}
