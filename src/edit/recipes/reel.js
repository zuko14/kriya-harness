// `reel-talking-head` (EDITOR_WORKFLOWS §3.1): one raw take becomes a vertical reel.
// Best take per line, restarts, fillers and stutters out, hook first, fitted to
// the length, punch-ins on a few emphasis words, reframed to 9:16, mastered to
// −14 LUFS. Code does the editing; the model makes two small choices (the hook and
// the lines to drop; the emphasis words), each with a default that needs no model.

import { apply } from "../core/ops.js"
import { LOOKS, pages } from "../engine/captions.js"
import { paperEdit } from "../index/views.js"

const FLICKS = 705_600_000

/** The recipe is data (ET-RCP-01): no command, path, URL, model or price. */
export const REEL_TALKING_HEAD = {
  id: "reel-talking-head",
  target: { min: 30 * FLICKS, max: 60 * FLICKS, default: 45 * FLICKS },
  canvas: { width: 1080, height: 1920 },
  deliverable: { preset: "reel-9x16", size: { width: 1080, height: 1920 }, fps: { n: 30, d: 1 }, codec: "h264", audio: "aac", loudness: { lufs: -14, tp: -1 }, burnCaptions: false, gates: ["QG-01", "QG-02", "QG-03", "QG-04", "QG-05", "QG-06", "QG-07", "QG-11", "QG-12", "QG-13", "QG-14"] },
  thresholds: { lengthTolerance: 1 / 3 }, // 30 to 60 s around 45
  punch: { scale: 1.15, max: 3 },
  joinGap: Math.round(0.7 * FLICKS), // a pause longer than this inside a line is cut out
  notes: "Recipe: a talking-head reel for phones. The first sentence must work on its own as a hook. Keep the speaker's meaning; drop only lines that repeat or wander.",
}

const STRUCK = new Set(["filler", "stutter", "restart"])

/** The recipe's deliverable; with captions asked for, they burn in and the text gates run (ED8). */
export function deliverableFor(brief = {}) {
  const base = REEL_TALKING_HEAD.deliverable
  return LOOKS[brief.captions] ? { ...base, burnCaptions: true, gates: [...base.gates, "QG-08", "QG-09", "QG-10"].sort() } : base
}

/** Lines worth keeping: each take group's best, with restarts and abandoned attempts out. */
export function candidateLines(index, asset, picks = {}) {
  const takes = new Map(index.takes.map((t) => [t.sentence, t]))
  const words = index.words.filter((w) => w.asset === asset)
  const byId = new Map(words.map((w, i) => [w.id, i]))
  return index.sentences
    .filter((s) => s.asset === asset)
    .map((s) => ({ ...s, words: words.slice(byId.get(s.firstWord), byId.get(s.lastWord) + 1) }))
    .filter((s) => {
      const take = takes.get(s.id)
      // The person's choice of take, if a decision card asked them (ED15); else the best
      if (take && (picks[take.group] ? picks[take.group] !== s.id : take.rank !== 1)) return false
      if (s.score === 0) return false
      return !s.words.every((w) => w.flags.some((f) => STRUCK.has(f)))
    })
}

/** A line's spoken runs: its words minus fillers and stutters, split at long pauses. */
export function runsOf(line, joinGap = REEL_TALKING_HEAD.joinGap) {
  const runs = []
  let run = null
  for (const word of line.words) {
    if (word.flags.some((f) => STRUCK.has(f))) {
      run = null
      continue
    }
    if (run && word.start - run.at(-1).end <= joinGap) run.push(word)
    else runs.push((run = [word]))
  }
  return runs
}

const lengthOf = (line) => runsOf(line).reduce((sum, run) => sum + (run.at(-1).end - run[0].start), 0)

/**
 * Picks lines to fit `max` by dynamic programming over 100 ms steps: as many seconds
 * of the best lines as fit, in their order, with the required ones always in.
 * `valueOf(line, cost)` weighs a line (ED11's short-from-long: closeness to the topic × density).
 */
export function fitLines(lines, max, required = new Set(), valueOf = (line, cost) => cost * (line.score || 1)) {
  const unit = FLICKS / 10
  const cost = lines.map((l) => Math.ceil(lengthOf(l) / unit))
  const fixed = lines.reduce((sum, l, i) => sum + (required.has(l.id) ? cost[i] : 0), 0)
  const capacity = Math.floor(max / unit) - fixed
  if (capacity < 0) return lines.filter((l) => required.has(l.id))
  // value: by default speech kept, weighted by the line's take score
  const free = lines.map((l, i) => ({ i, cost: cost[i], value: valueOf(l, cost[i]) })).filter(({ i }) => !required.has(lines[i].id))
  const best = new Float64Array(capacity + 1)
  const pick = free.map(() => new Uint8Array(capacity + 1))
  free.forEach((item, k) => {
    for (let c = capacity; c >= item.cost; c--) {
      const value = best[c - item.cost] + item.value
      if (value > best[c]) {
        best[c] = value
        pick[k][c] = 1
      }
    }
  })
  const chosen = new Set([...required])
  let c = capacity
  for (let k = free.length - 1; k >= 0; k--) {
    if (pick[k][c]) {
      chosen.add(lines[free[k].i].id)
      c -= free[k].cost
    }
  }
  return lines.filter((l) => chosen.has(l.id))
}

const STORY_SCHEMA = {
  type: "object",
  properties: { hook: { anyOf: [{ type: "string", maxLength: 64 }, { type: "null" }] }, drop: { type: "array", maxItems: 40, items: { type: "string", maxLength: 64 } } },
  required: ["hook", "drop"],
  additionalProperties: false,
}
const EMPHASIS_SCHEMA = { type: "object", properties: { emphasis: { type: "array", maxItems: 3, items: { type: "string", maxLength: 64 } } }, required: ["emphasis"], additionalProperties: false }

/**
 * Plans the reel as operations on `project` (which keeps its assets; its cut is replaced).
 * @param {{ project: object, index: object, asset: string, ask: Function, brief?: object, variant?: { tighter?: number, noHook?: boolean }, signal?: AbortSignal }} input
 * @returns {Promise<{ ops: object[], project: object, notes: string[], calls: number, slots: Record<string, string> }>}
 */
export async function planReel({ project, index, asset, ask, brief = {}, variant = {}, signal }) {
  const recipe = REEL_TALKING_HEAD
  const notes = []
  const slots = {}
  let calls = 0
  const lines = candidateLines(index, asset, brief.picks)
  const ids = new Set(lines.map((l) => l.id))
  const mustKeep = (brief.mustKeep ?? []).filter((id) => ids.has(id))
  const scoped = { ...index, sentences: lines, words: lines.flatMap((l) => l.words), takes: [] }

  // Story: the hook, and the lines that add nothing (sentence ids only)
  const story = await ask({
    task: "story",
    schema: STORY_SCHEMA,
    recipe: recipe.notes,
    view: paperEdit(scoped, { assets: [asset] }),
    request: `Choose the opening line (a sentence id from the list, or null to keep the order) and any lines to drop because they repeat or wander. The reel should run ${recipe.target.min / FLICKS} to ${recipe.target.max / FLICKS} seconds. Never drop: ${mustKeep.join(", ") || "(none)"}.`,
    maxOutput: 300,
    check: ({ hook, drop }) => [hook, ...drop].filter((id) => id !== null && !ids.has(id)).map((id) => `"${id}" isn't one of the sentences shown`),
    fallback: () => ({ hook: null, drop: [] }),
    signal,
  })
  calls += story.calls
  slots.story = story.source
  if (story.reason) notes.push(`Story: ${story.reason} Kept every line, in order.`)
  const hook = variant.noHook ? null : story.value.hook
  let chosen = lines.filter((l) => !story.value.drop.includes(l.id) || mustKeep.includes(l.id))

  // Length: fit under the maximum, the hook and must-keeps always in
  const max = Math.round(recipe.target.max * (variant.tighter ?? 1))
  const required = new Set([...mustKeep, ...(hook ? [hook] : [])])
  if (chosen.reduce((sum, l) => sum + lengthOf(l), 0) > max) chosen = fitLines(chosen, max, required)
  const total = chosen.reduce((sum, l) => sum + lengthOf(l), 0)
  if (total < recipe.target.min) notes.push(`The footage gives ${(total / FLICKS).toFixed(1)} s of usable speech, under the ${recipe.target.min / FLICKS} s the recipe aims for.`)
  if (hook && chosen.some((l) => l.id === hook)) chosen = [chosen.find((l) => l.id === hook), ...chosen.filter((l) => l.id !== hook)]
  if (hook && chosen[0]?.id === hook && lines[0]?.id !== hook) notes.push(`Moved "${hook}" to the front as the hook.`)

  // The cut: replace whatever is there with the kept runs
  const sequence = project.sequences.find((q) => q.id === project.active)
  const base = new Set(sequence.tracks.filter((t) => t.role === "base").map((t) => t.id))
  const ops = [
    ...sequence.clips.filter((c) => base.has(c.track)).map((c) => ({ op: "ripple_delete", clip: c.id })),
    { op: "set_brief", format: recipe.id, targetDuration: brief.targetDuration ?? recipe.target.default, mustKeep: brief.mustKeep ?? [], mustCut: brief.mustCut ?? [], effort: brief.effort ?? "best", ...(brief.language ? { language: brief.language } : {}) },
    { op: "set_format", width: recipe.canvas.width, height: recipe.canvas.height, fps: recipe.deliverable.fps },
    ...(project.deliverables.some((d) => d.preset === recipe.deliverable.preset) ? [] : [{ op: "add_deliverable", ...deliverableFor(brief) }]),
  ]
  for (const line of chosen) for (const run of runsOf(line)) ops.push({ op: "keep_range", asset, from: { word: run[0].id, edge: "start" }, to: { word: run.at(-1).id, edge: "end" } })
  let step = apply(project, ops, { index, author: "agent" })
  if (!step.applied) throw new Error(`The reel's cut was refused: ${step.diagnostics[0].message}`)

  // Emphasis: a few words worth a punch-in
  const kept = chosen.flatMap((l) => runsOf(l).flat())
  const keptIds = new Set(kept.map((w) => w.id))
  const emphasis = await ask({
    task: "emphasis",
    schema: EMPHASIS_SCHEMA,
    recipe: recipe.notes,
    view: paperEdit({ ...scoped, sentences: chosen }, { assets: [asset] }),
    request: `Pick up to ${recipe.punch.max} single words to emphasise with a quick zoom: numbers, names, the point of a line. Word ids only.`,
    maxOutput: 200,
    check: ({ emphasis: picked }) => picked.filter((id) => !keptIds.has(id)).map((id) => `"${id}" isn't a kept word`),
    fallback: () => ({ emphasis: kept.filter((w) => /\d/.test(w.text)).slice(0, recipe.punch.max).map((w) => w.id) }),
    signal,
  })
  calls += emphasis.calls
  slots.emphasis = emphasis.source
  if (emphasis.reason) notes.push(`Emphasis: ${emphasis.reason}`)
  const punches = [...new Set(emphasis.value.emphasis)].slice(0, recipe.punch.max).map((id) => ({ op: "punch_in", at: { word: id, edge: "start" }, until: { word: id, edge: "end" }, scale: brief.zoom ?? recipe.punch.scale }))

  // Reframe to 9:16: follow the speaker where the index has one, else hold the centre
  const facts = project.assets.find((a) => a.id === asset).facts
  const cropWidth = Math.round((facts.height * recipe.canvas.width) / recipe.canvas.height)
  const subject = (index.subjects?.[asset]?.length ?? 0) > 0
  if (!subject) notes.push("No face track for this take, so the frame holds the centre.")
  const clips = step.project.sequences.find((q) => q.id === step.project.active).clips.filter((c) => base.has(c.track))
  const framing = clips.map((c) => (subject ? { op: "reframe", clip: c.id, mode: "subject" } : { op: "reframe", clip: c.id, mode: "fixed", x: Math.max(0, Math.round((facts.width - cropWidth) / 2)) }))

  // Captions, when the brief asks for a look: pages of the kept words, timed to the speech
  const captions = LOOKS[brief.captions] ? chosen.flatMap((l) => runsOf(l)).flatMap((run) => pages(run)).map((ids) => ({ op: "caption_style", look: brief.captions, words: ids })) : []
  // Music, when the brief names a sound in the project: fitted on its downbeats, ducked under the speech (ED9)
  const song = brief.music ? project.assets.find((a) => a.id === brief.music && a.kind === "audio") : null
  if (brief.music && !song) notes.push(`There is no sound "${brief.music}" in this project, so the reel has no music.`)
  const music = song ? [{ op: "set_music", asset: song.id }, { op: "music_shape", fit: true, fadeIn: Math.round(FLICKS * 0.3) }, { op: "duck" }] : []
  const all = [...ops, ...punches, ...framing, ...captions, ...music]
  step = apply(project, all, { index, author: "agent" })
  if (!step.applied) throw new Error(`The reel was refused: ${step.diagnostics[0].message}`)
  return { ops: all, project: step.project, notes, calls, slots }
}
