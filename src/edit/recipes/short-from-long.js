// `short-from-long` (EDITOR_WORKFLOWS §3.1): a long recording (30 to 60+ minutes)
// becomes a standalone 30–60 s vertical short. Code does all of it, with no model call:
// story search over the cleaned lines (EDIT_LOOP §6 step 2), three candidates ranked by
// a pairwise tournament at F0 (the compiled plan) and F1 (the text), never rendered;
// the winner reframed to 9:16 on the L8 face track (EDIT_ENGINE §5.2).
// EDD-16: the rubric orders candidates for this one video. Nothing here forecasts views.

import { apply } from "../core/ops.js"
import { compile } from "../core/plan.js"
import { LOOKS, pages } from "../engine/captions.js"
import { candidateLines, fitLines, runsOf } from "./reel.js"

const FLICKS = 705_600_000

/** The recipe is data (ET-RCP-01): no command, path, URL, model or price. */
export const SHORT_FROM_LONG = {
  id: "short-from-long",
  target: { min: 30 * FLICKS, max: 60 * FLICKS, default: 45 * FLICKS },
  canvas: { width: 1080, height: 1920 },
  deliverable: { preset: "short-9x16", size: { width: 1080, height: 1920 }, fps: { n: 30, d: 1 }, codec: "h264", audio: "aac", loudness: { lufs: -14, tp: -1 }, burnCaptions: false, gates: ["QG-01", "QG-02", "QG-03", "QG-04", "QG-05", "QG-06", "QG-07", "QG-11", "QG-12", "QG-13", "QG-14"] },
  thresholds: { lengthTolerance: 1 / 3 },
  candidates: 3,
  joinGap: Math.round(0.7 * FLICKS),
  topicGap: 4 * FLICKS, // a pause this long between lines ends a story (PERCEPTION §8: split at pauses and embedding distance)
  minCohesion: 0.08, // a line this far from the story's centroid starts a new topic
  notes: "Recipe: a standalone short cut from a long recording. It opens on a line that works alone and ends on a finished thought.",
}

/** With captions asked for, they burn in and the text gates run, as for the reel (ED8). */
export function deliverableFor(brief = {}) {
  const base = SHORT_FROM_LONG.deliverable
  return LOOKS[brief.captions] ? { ...base, burnCaptions: true, gates: [...base.gates, "QG-08", "QG-09", "QG-10"].sort() } : base
}

// Openers that lean on something said before: a short that starts here starts mid-thought
const DANGLING = new Set(["and", "but", "so", "because", "also", "then", "or", "which", "it", "this", "that", "these", "those", "they", "he", "she", "him", "her", "them", "there", "yeah", "right", "anyway"])
const STOP = new Set([...DANGLING, "a", "an", "the", "i", "you", "we", "to", "of", "in", "on", "for", "is", "was", "are", "be", "with", "as", "at", "my", "our", "your", "me", "us", "do", "did", "have", "has", "had", "not", "just", "if", "what", "how", "why", "when", "all", "about", "from", "by", "one", "can", "will", "would", "now", "here", "its", "it's", "i'm", "let", "let's", "like", "um", "uh", "okay", "ok"])
const DIMS = 256

const tokensOf = (text) => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []

/**
 * A sentence vector: content words hashed into 256 dims, L2-normalised.
 * shortcut: lexical, so synonyms don't meet; L11's embeddings replace it when that layer is built
 */
export function embed(text) {
  const v = new Float64Array(DIMS)
  for (const word of tokensOf(text)) {
    if (STOP.has(word) || word.length < 3) continue
    let h = 2166136261
    for (const c of word.replace(/(ing|ed|es|s)$/, "")) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
    v[(h >>> 0) % DIMS] += 1
  }
  const norm = Math.hypot(...v)
  return norm ? v.map((x) => x / norm) : v
}

const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0)
const textOf = (line) => line.words.map((w) => w.text).join(" ")
const spoken = (line, joinGap) => runsOf(line, joinGap).reduce((sum, run) => sum + (run.at(-1).end - run[0].start), 0)

function centroid(vectors) {
  const c = new Float64Array(DIMS)
  for (const v of vectors) for (let i = 0; i < DIMS; i++) c[i] += v[i]
  const norm = Math.hypot(...c)
  return norm ? c.map((x) => x / norm) : c
}

/** How well a line opens a short on its own, 0 to 1 (F1, text only). */
export function openingStrength(line) {
  const words = tokensOf(textOf(line))
  if (!words.length || DANGLING.has(words[0])) return 0
  let score = 0.5
  if (words.some((w) => /\d/.test(w)) || /\?$/.test(textOf(line).trim())) score += 0.25
  if (words.length >= 5 && words.length <= 16) score += 0.25
  return score
}

const finished = (line) => /[.!?]["')]?$/.test(textOf(line).trim())

/**
 * The rubric (EDD-16): numbers that order candidates, each 0 to 1, higher better.
 * hook: the opening line stands alone; cohesion: lines stay on one topic; density:
 * words a second against the recording's own pace; fit: length against the target;
 * ending: it ends on a finished sentence; references: no line leans on a cut one.
 */
function rubricOf(story, { target, pace }) {
  const vectors = story.lines.map((l) => l.vector)
  const c = centroid(vectors)
  const words = story.lines.reduce((sum, l) => sum + l.words.length, 0)
  const seconds = story.duration / FLICKS
  const cut = story.lines.slice(1).filter((l, i) => l.n !== story.lines[i].n + 1)
  return {
    hook: openingStrength(story.lines[0]),
    cohesion: vectors.length ? vectors.reduce((sum, v) => sum + dot(v, c), 0) / vectors.length : 0,
    density: Math.min(1, words / seconds / (pace * 1.25)),
    fit: Math.max(0, 1 - Math.abs(story.duration - target) / target),
    ending: finished(story.lines.at(-1)) ? 1 : 0,
    references: cut.length ? 1 - cut.filter((l) => openingStrength(l) === 0).length / cut.length : 1,
  }
}

const total = (rubric) => Object.values(rubric).reduce((a, b) => a + b, 0)

/**
 * Story search: each line that opens well starts a window that grows until a topic
 * shift or 1.5× the maximum; a knapsack (dynamic programming over 100 ms steps, reel.js)
 * keeps the lines worth most, by length × closeness to the story's topic × density,
 * under the maximum with the opener always in. Windows are scored by the rubric and the
 * best that don't overlap become candidates.
 * @returns {{ lines: object[], duration: number, rubric: object, score: number }[]}
 */
export function storySearch(index, asset, { recipe = SHORT_FROM_LONG, max = recipe.target.max, count = recipe.candidates, target = recipe.target.default } = {}) {
  const lines = candidateLines(index, asset).map((line, n) => {
    const duration = spoken(line, recipe.joinGap)
    return { ...line, n, duration, vector: embed(textOf(line)), density: line.words.length / Math.max(duration / FLICKS, 0.1) }
  })
  if (!lines.length) return []
  const pace = lines.reduce((sum, l) => sum + l.words.length, 0) / (lines.reduce((sum, l) => sum + l.duration, 0) / FLICKS)
  const windows = []
  for (let i = 0; i < lines.length; i++) {
    if (openingStrength(lines[i]) < 0.5) continue
    const window = [lines[i]]
    let length = lines[i].duration
    for (let j = i + 1; j < lines.length && length < max * 1.5; j++) {
      const gap = lines[j].start - lines[j - 1].end
      if (gap > recipe.topicGap || dot(lines[j].vector, centroid(window.map((l) => l.vector))) < recipe.minCohesion) break
      window.push(lines[j])
      length += lines[j].duration
    }
    if (length < recipe.target.min) continue
    const c = centroid(window.map((l) => l.vector))
    const valueOf = (line, cost) => cost * (0.5 + Math.max(0, dot(line.vector, c))) * Math.min(1.5, line.density / pace)
    const kept = length > max ? fitLines(window, max, new Set([lines[i].id]), valueOf) : window
    // A knapsack can drop the ending; trim back to the last finished sentence when there is one
    const end = kept.findLastIndex(finished)
    const story = end > 0 ? kept.slice(0, end + 1) : kept
    const storyLength = story.reduce((sum, l) => sum + l.duration, 0)
    if (storyLength < recipe.target.min || storyLength > max) continue
    const candidate = { lines: story, duration: storyLength }
    candidate.rubric = rubricOf(candidate, { target, pace })
    candidate.score = total(candidate.rubric)
    windows.push(candidate)
  }
  windows.sort((a, b) => b.score - a.score || a.lines[0].start - b.lines[0].start)
  const chosen = []
  const overlaps = (a, b) => a.lines[0].start <= b.lines.at(-1).end && b.lines[0].start <= a.lines.at(-1).end
  for (const w of windows) {
    if (chosen.length === count) break
    if (!chosen.some((c) => overlaps(c, w))) chosen.push(w)
  }
  return chosen
}

/**
 * The tournament (EDIT_LOOP §6 step 2): every pair meets once; a candidate takes the
 * pair when it is ahead on more rubric criteria, then on the sum. Ranked by wins
 * (Copeland), ties by the sum. F0 adds the compiled plan's own facts: a plan that
 * doesn't compile, or has issues, gives up the criterion to one that does.
 * @param {{ rubric: object, f0?: { issues: number, duration: number } }[]} candidates
 * @returns {{ order: number[], wins: number[], pairs: { a: number, b: number, winner: number, ahead: string[] }[] }}
 */
export function tournament(candidates) {
  const criteria = (c) => ({ ...c.rubric, plan: c.f0 ? 1 / (1 + c.f0.issues) : 0 })
  const wins = candidates.map(() => 0)
  const pairs = []
  for (let a = 0; a < candidates.length; a++) {
    for (let b = a + 1; b < candidates.length; b++) {
      const [x, y] = [criteria(candidates[a]), criteria(candidates[b])]
      const aheadA = Object.keys(x).filter((k) => x[k] > y[k] + 1e-9)
      const aheadB = Object.keys(x).filter((k) => y[k] > x[k] + 1e-9)
      const winner = aheadA.length !== aheadB.length ? (aheadA.length > aheadB.length ? a : b) : total(x) >= total(y) ? a : b
      wins[winner]++
      pairs.push({ a, b, winner, ahead: winner === a ? aheadA : aheadB })
    }
  }
  const order = candidates.map((_, i) => i).sort((i, j) => wins[j] - wins[i] || total(criteria(candidates[j])) - total(criteria(candidates[i])) || i - j)
  return { order, wins, pairs }
}

/** The operations that cut `lines` into a 9:16 short on `project`. */
function cutOps(project, index, asset, lines, brief, recipe) {
  const sequence = project.sequences.find((q) => q.id === project.active)
  const base = new Set(sequence.tracks.filter((t) => t.role === "base").map((t) => t.id))
  const ops = [
    ...sequence.clips.filter((c) => base.has(c.track)).map((c) => ({ op: "ripple_delete", clip: c.id })),
    { op: "set_brief", format: recipe.id, targetDuration: brief.targetDuration ?? recipe.target.default, mustKeep: brief.mustKeep ?? [], mustCut: brief.mustCut ?? [], effort: brief.effort ?? "best", ...(brief.language ? { language: brief.language } : {}) },
    { op: "set_format", width: recipe.canvas.width, height: recipe.canvas.height, fps: recipe.deliverable.fps },
    ...(project.deliverables.some((d) => d.preset === recipe.deliverable.preset) ? [] : [{ op: "add_deliverable", ...deliverableFor(brief) }]),
  ]
  for (const line of lines) for (const run of runsOf(line, recipe.joinGap)) ops.push({ op: "keep_range", asset, from: { word: run[0].id, edge: "start" }, to: { word: run.at(-1).id, edge: "end" } })
  const step = apply(project, ops, { index, author: "agent" })
  return { ops, step, base }
}

/**
 * Plans the short as operations on `project`. The three candidates are compiled (F0)
 * but never rendered; the tournament picks the one that is cut, reframed and dressed.
 * @param {{ project: object, index: object, asset: string, brief?: object, variant?: { tighter?: number } }} input
 * @returns {{ ops: object[], project: object, notes: string[], calls: number, slots: Record<string, string>, candidates: object[] }}
 */
export function planShort({ project, index, asset, brief = {}, variant = {} }) {
  const recipe = SHORT_FROM_LONG
  const notes = []
  const max = Math.round(recipe.target.max * (variant.tighter ?? 1))
  const found = storySearch(index, asset, { max, target: brief.targetDuration ?? recipe.target.default })
  if (!found.length) throw new Error(`No standalone story of ${recipe.target.min / FLICKS} to ${max / FLICKS} s was found in this recording.`)

  // F0: each candidate's plan, compiled; nothing is rendered
  for (const candidate of found) {
    const { step } = cutOps(project, index, asset, candidate.lines, brief, recipe)
    const plan = step.applied ? compile(step.project, index, { engineVersion: "f0", runtimeVersion: "f0" }) : null
    candidate.f0 = plan ? { issues: plan.issues.length, duration: plan.duration } : undefined
  }
  const ranked = tournament(found)
  const best = found[ranked.order[0]]
  const summary = ranked.order.map((i, rank) => ({ rank: rank + 1, wins: ranked.wins[i], from: found[i].lines[0].id, to: found[i].lines.at(-1).id, seconds: Math.round(found[i].duration / FLICKS), plan: found[i].f0 ? { issues: found[i].f0.issues, seconds: Math.round(found[i].f0.duration / FLICKS) } : null, rubric: Object.fromEntries(Object.entries(found[i].rubric).map(([k, v]) => [k, Math.round(v * 100) / 100])) }))
  notes.push(`Compared ${found.length} candidate stories in pairs on the rubric and picked the one from ${best.lines[0].id} to ${best.lines.at(-1).id}. The rubric ranks them for this video; it doesn't predict views.`)
  const dropped = best.lines.slice(1).filter((l, i) => l.n !== best.lines[i].n + 1).length
  if (dropped) notes.push(`Left out ${dropped === 1 ? "a line" : `${dropped} places`} inside the story to fit the length.`)

  const { ops, step, base } = cutOps(project, index, asset, best.lines, brief, recipe)
  if (!step.applied) throw new Error(`The short's cut was refused: ${step.diagnostics[0].message}`)

  // Reframe to 9:16 on the face track (L8); the solver keeps the face box in and moves without whips (ET-SOL-03)
  const facts = project.assets.find((a) => a.id === asset).facts
  const cropWidth = Math.round((facts.height * recipe.canvas.width) / recipe.canvas.height)
  const subject = (index.subjects?.[asset]?.length ?? 0) > 0
  if (!subject) notes.push("No face track for this recording, so the frame holds the centre.")
  const clips = step.project.sequences.find((q) => q.id === step.project.active).clips.filter((c) => base.has(c.track))
  const framing = clips.map((c) => (subject ? { op: "reframe", clip: c.id, mode: "subject" } : { op: "reframe", clip: c.id, mode: "fixed", x: Math.max(0, Math.round((facts.width - cropWidth) / 2)) }))
  const captions = LOOKS[brief.captions] ? best.lines.flatMap((l) => runsOf(l, recipe.joinGap)).flatMap((run) => pages(run)).map((ids) => ({ op: "caption_style", look: brief.captions, words: ids })) : []
  const all = [...ops, ...framing, ...captions]
  const done = apply(project, all, { index, author: "agent" })
  if (!done.applied) throw new Error(`The short was refused: ${done.diagnostics[0].message}`)
  return { ops: all, project: done.project, notes, calls: 0, slots: { story: "code" }, candidates: summary }
}
