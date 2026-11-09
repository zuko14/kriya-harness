// `reel-talking-head` (EDITOR_WORKFLOWS §3.1): one raw take becomes a vertical reel.
// Best take per line, restarts, fillers and stutters out, hook first, fitted to
// the length, punch-ins on a few emphasis words, reframed to 9:16, mastered to
// −14 LUFS. Code does the editing; the model makes two small choices (the hook and
// the lines to drop; the emphasis words), each with a default that needs no model.

import { isSceneBlock } from "../core/layout.js"
import { apply } from "../core/ops.js"
import { solve } from "../core/solver.js"
import { LOOKS, pages, readablePages } from "../engine/captions.js"
import { paperEdit } from "../index/views.js"
import { sceneOps } from "./scene-clips.js"

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

const STRUCK = new Set(["filler", "stutter", "restart", "trimmed"])

const clock = (t) => { const s = Math.round(t / (FLICKS / 10)) / 10; return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}` }

/**
 * The person's trims ("remove everything after 0:25"): each word whose middle falls inside a
 * stretch is marked `trimmed`, so the cut lands between words, never inside one (QG-05).
 * @param {{ from: number, to: number }[]} cuts source flicks of `asset`
 */
export function trimIndex(index, asset, cuts = []) {
  if (!cuts.length) return { index, trimmed: 0 }
  let trimmed = 0
  const inside = (w) => cuts.some((c) => (w.start + w.end) / 2 >= c.from && (w.start + w.end) / 2 < c.to)
  const words = index.words.map((w) => (w.asset === asset && inside(w) ? (trimmed++, { ...w, flags: [...w.flags, "trimmed"] }) : w))
  return { index: { ...index, words }, trimmed }
}

/** Templates' frames: the reel's 9:16 by default; the same cut also makes a landscape, square or 4:5 film. */
export const FORMATS = {
  "9:16": { width: 1080, height: 1920, preset: "reel-9x16" },
  "16:9": { width: 1920, height: 1080, preset: "landscape-16x9" },
  "1:1": { width: 1080, height: 1080, preset: "square-1x1" },
  "4:5": { width: 1080, height: 1350, preset: "portrait-4x5" },
}

/** Colour looks as FFmpeg renders them: eq, colortemperature, vibrance and vignette. Data, applied by code. */
export const GRADES = {
  vivid: { saturation: 1.15, gain: 1.06, vibrance: 0.35 },
  cinematic: { saturation: 0.9, gain: 1.12, gamma: 0.95, temperature: 7200, vignette: 0.45 },
  warm: { temperature: 5200, saturation: 1.05, vibrance: 0.2, vignette: 0.2 },
  bright: { lift: 0.04, gamma: 1.1, vibrance: 0.2 },
  mono: { saturation: 0, gain: 1.1, vignette: 0.3 },
}

/** The recipe in the brief's frame: canvas and export follow `brief.format`. */
export function recipeFor(brief = {}) {
  const format = FORMATS[brief.format] ?? FORMATS["9:16"]
  const base = REEL_TALKING_HEAD
  return { ...base, canvas: { width: format.width, height: format.height }, deliverable: { ...base.deliverable, preset: format.preset, size: { width: format.width, height: format.height } } }
}

/** The recipe's deliverable; with captions asked for, they burn in and the text gates run (ED8). */
export function deliverableFor(brief = {}) {
  const base = recipeFor(brief).deliverable
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
const EMPHASIS_SCHEMA = { type: "object", properties: { emphasis: { type: "array", maxItems: 8, items: { type: "string", maxLength: 64 } } }, required: ["emphasis"], additionalProperties: false }

/**
 * Plans the reel as operations on `project` (which keeps its assets; its cut is replaced).
 * @param {{ project: object, index: object, asset: string, ask: Function, brief?: object, variant?: { tighter?: number, noHook?: boolean }, signal?: AbortSignal }} input
 * @returns {Promise<{ ops: object[], project: object, notes: string[], calls: number, slots: Record<string, string> }>}
 */
export async function planReel({ project, index: fullIndex, asset, ask, brief = {}, variant = {}, signal }) {
  const recipe = recipeFor(brief)
  const notes = []
  const cuts = (brief.cuts ?? []).filter((c) => Number.isFinite(c.from) && Number.isFinite(c.to) && c.to > c.from)
  const { index, trimmed } = trimIndex(fullIndex, asset, cuts)
  if (cuts.length) notes.push(`Trimmed ${cuts.map((c) => `${clock(c.from)} to ${clock(c.to)}`).join(", ")} of the take, as you asked (${trimmed} word${trimmed === 1 ? "" : "s"}, cut between words).`)
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
  // A hook the person approved in the Director's plan wins over the model's pick
  const planned = typeof brief.hook === "string" && lines.some((l) => l.id === brief.hook) ? brief.hook : null
  const hook = variant.noHook ? null : (planned ?? story.value.hook)
  // The lines under an approved scene stay: fitting the length mustn't take a scene the person approved (found on real footage)
  const wordsById = new Map(index.words.map((w) => [w.id, w]))
  const sceneLines = [...(brief.scenes ?? []), ...(brief.pictures ?? [])].flatMap((scene) => {
    const from = wordsById.get(scene.from)
    const to = wordsById.get(scene.to)
    return from && to ? lines.filter((l) => l.start < to.end && from.start < l.end).map((l) => l.id) : []
  })
  let chosen = lines.filter((l) => !story.value.drop.includes(l.id) || mustKeep.includes(l.id) || sceneLines.includes(l.id))

  // Length: fit under the maximum, the hook and must-keeps always in
  // With scenes, the length the person asked for is the limit, even past the reel's 60 s
  const longest = brief.scenes?.length || brief.pictures?.length ? Math.max(recipe.target.max, brief.targetDuration ?? 0) : recipe.target.max
  const max = Math.round(longest * (variant.tighter ?? 1))
  const required = new Set([...mustKeep, ...sceneLines, ...(hook ? [hook] : [])])
  if (chosen.reduce((sum, l) => sum + lengthOf(l), 0) > max) chosen = fitLines(chosen, max, required)
  const total = chosen.reduce((sum, l) => sum + lengthOf(l), 0)
  // Short footage sets the length: a 29 s take makes a 29 s cut, not a cut that "needs you"
  // for missing a 30 s target nobody can meet (found in use)
  const asked = brief.targetDuration ?? recipe.target.default
  const target = total > 0 && total < asked ? total : asked
  if (target < asked) notes.push(`The footage gives ${(total / FLICKS).toFixed(1)} s of usable speech, so the cut is that long (you asked for about ${Math.round(asked / FLICKS)} s).`)
  if (hook && chosen.some((l) => l.id === hook)) chosen = [chosen.find((l) => l.id === hook), ...chosen.filter((l) => l.id !== hook)]
  if (hook && chosen[0]?.id === hook && lines[0]?.id !== hook) notes.push(`Moved "${hook}" to the front as the hook.`)

  // The cut: replace whatever is there with the kept runs
  const sequence = project.sequences.find((q) => q.id === project.active)
  const base = new Set(sequence.tracks.filter((t) => t.role === "base").map((t) => t.id))
  // The last cut's captions and music go with it: they hang on its words, and a second
  // make left them all on screen twice (found in use, 2026-11-09)
  const rebuilt = new Set(sequence.tracks.filter((t) => ["base", "caption", "music"].includes(t.role)).map((t) => t.id))
  const ops = [
    // Scenes too: an earlier make's scenes hang on the words of that cut
    ...sequence.clips.filter((c) => rebuilt.has(c.track) || c.effects?.some((e) => isSceneBlock(e))).map((c) => ({ op: "ripple_delete", clip: c.id })),
    { op: "set_brief", format: recipe.id, targetDuration: target, mustKeep: brief.mustKeep ?? [], mustCut: brief.mustCut ?? [], effort: brief.effort ?? "best", ...(brief.language ? { language: brief.language } : {}) },
    { op: "set_format", width: recipe.canvas.width, height: recipe.canvas.height, fps: recipe.deliverable.fps },
    ...(project.deliverables.some((d) => d.preset === recipe.deliverable.preset) ? [] : [{ op: "add_deliverable", ...deliverableFor(brief) }]),
  ]
  for (const line of chosen) for (const run of runsOf(line)) ops.push({ op: "keep_range", asset, from: { word: run[0].id, edge: "start" }, to: { word: run.at(-1).id, edge: "end" } })
  // A cold open: a later moment first (an echo, so captions stay on the moment), in black and white
  const takeWords = new Set(index.words.filter((w) => w.asset === asset).map((w) => w.id))
  const cutOut = new Set(index.words.filter((w) => w.flags.includes("trimmed")).map((w) => w.id))
  const coldTrimmed = brief.coldOpen && index.words.some((w) => cutOut.has(w.id) && w.asset === asset && w.start >= (index.words.find((x) => x.id === brief.coldOpen.from)?.start ?? Infinity) && w.end <= (index.words.find((x) => x.id === brief.coldOpen.to)?.end ?? -Infinity))
  if (coldTrimmed) notes.push("No cold open: its moment is inside a stretch you asked to trim.")
  const cold = !coldTrimmed && brief.coldOpen && takeWords.has(brief.coldOpen.from) && takeWords.has(brief.coldOpen.to) ? brief.coldOpen : null
  if (cold) {
    ops.push({ op: "cold_open", asset, from: { word: cold.from, edge: "start" }, to: { word: cold.to, edge: "end" }, mono: cold.mono !== false })
    notes.push(`Opened cold on "${index.words.find((w) => w.id === cold.from).text} …"${cold.mono !== false ? " in black and white" : ""}, then the story starts.`)
  }
  let step = apply(project, ops, { index, author: "agent" })
  if (!step.applied) throw new Error(`The reel's cut was refused: ${step.diagnostics[0].message}`)

  // Emphasis: a few words worth a punch-in; a reference's pace can ask for more (EDD-23)
  const most = Number.isInteger(brief.punches) && brief.punches > 0 ? Math.min(brief.punches, 8) : recipe.punch.max
  const kept = chosen.flatMap((l) => runsOf(l).flat())
  // The approved plan's scenes, on the cut as solved. A zoom or title under one would never be seen
  const scenes = brief.scenes?.length || brief.pictures?.length || brief.terms?.length ? sceneOps({ scenes: brief.scenes ?? [], pictures: brief.pictures ?? [], terms: brief.terms ?? [], project: step.project, index, asset, kept, captions: !!LOOKS[brief.captions], sound: { scene: brief.sfx?.scene, reveal: brief.sfx?.reveal } }) : { ops: [], covered: new Set(), notes: [] }
  notes.push(...scenes.notes)
  const visible = kept.filter((w) => !scenes.covered.has(w.id))
  const keptIds = new Set(visible.map((w) => w.id))
  const emphasis = await ask({
    task: "emphasis",
    schema: EMPHASIS_SCHEMA,
    recipe: recipe.notes,
    view: paperEdit({ ...scoped, sentences: chosen.filter((l) => l.words.some((w) => keptIds.has(w.id))) }, { assets: [asset] }),
    request: `Pick up to ${most} single words to emphasise with a quick zoom: numbers, names, the point of a line. Word ids only.`,
    maxOutput: 200,
    check: ({ emphasis: picked }) => picked.filter((id) => !keptIds.has(id)).map((id) => `"${id}" isn't a kept word`),
    fallback: () => ({ emphasis: visible.filter((w) => /\d/.test(w.text)).slice(0, most).map((w) => w.id) }),
    signal,
  })
  calls += emphasis.calls
  slots.emphasis = emphasis.source
  if (emphasis.reason) notes.push(`Emphasis: ${emphasis.reason}`)
  const punches = [...new Set(emphasis.value.emphasis)].slice(0, most).map((id) => ({ op: "punch_in", at: { word: id, edge: "start" }, until: { word: id, edge: "end" }, scale: brief.zoom ?? recipe.punch.scale }))

  // Reframe to the template's frame: follow the speaker where the index has one, else hold
  // the centre. A frame as wide as the take or wider keeps the whole picture
  const facts = project.assets.find((a) => a.id === asset).facts
  const cropWidth = Math.round((facts.height * recipe.canvas.width) / recipe.canvas.height)
  const crops = cropWidth < facts.width
  const subject = (index.subjects?.[asset]?.length ?? 0) > 0
  if (crops && !subject) notes.push("No face track for this take, so the frame holds the centre.")
  const clips = step.project.sequences.find((q) => q.id === step.project.active).clips.filter((c) => base.has(c.track))
  const framing = crops ? clips.map((c) => (subject ? { op: "reframe", clip: c.id, mode: "subject" } : { op: "reframe", clip: c.id, mode: "fixed", x: Math.max(0, Math.round((facts.width - cropWidth) / 2)) })) : []
  // The template's colour look, on every picture clip
  // The look on every story clip; a cold open keeps its own black and white
  const look = GRADES[brief.grade] ?? (brief.customGrade && typeof brief.customGrade === "object" ? brief.customGrade : null)
  const grading = look ? clips.filter((c) => !c.echo).map((c) => ({ op: "grade", clip: c.id, ...look })) : []
  // Sound design: an effect on every cut of the story, a riser into it after a cold open.
  // Each is placed by its peak, so the loudest moment lands on the cut
  const storyClips = clips.filter((c) => !c.echo)
  // A playbook's restraint: a sound on every nth cut, not on all of them
  const every = Number.isInteger(brief.soundEvery) && brief.soundEvery > 1 ? brief.soundEvery : 1
  const cutSounds = brief.sfx?.cut ? storyClips.slice(1).filter((_, i) => i % every === 0).map((c) => ({ op: "add_sfx", asset: brief.sfx.cut, peak_at: { clip: c.id, edge: "start" } })) : []
  const introSound = brief.sfx?.intro && cold && storyClips[0] ? [{ op: "add_sfx", asset: brief.sfx.intro, peak_at: { clip: storyClips[0].id, edge: "start" } }] : []
  const sounds = [...cutSounds, ...introSound]

  // Angles: one camera cut like two, wide then tight on alternate story clips (a punch the
  // length of the clip). Emphasis punch-ins come after, so they win on their own clips
  const angles = brief.angles ? storyClips.filter((_, i) => i % 2 === 1).map((c) => ({ op: "punch_in", at: { clip: c.id, edge: "start" }, until: { clip: c.id, edge: "end" }, scale: 1.18 })) : []
  // B-roll from the person's own other clips, over every other story clip after the first,
  // 2.5 s or the clip's length, each from a new part of its source
  const brollSources = brief.broll === "own" ? project.assets.filter((a) => a.kind === "video" && a.id !== asset && (a.facts.duration ?? 0) > FLICKS) : []
  const pieces = solve(step.project, index).picture
  const lengthOfClip = (id) => pieces.filter((p) => p.clip === id).reduce((sum, p) => sum + (p.end - p.at), 0)
  const broll = brollSources.length
    ? storyClips
        .slice(1)
        .filter((_, i) => i % 2 === 0)
        .map((c, i) => {
          const source = brollSources[i % brollSources.length]
          const duration = Math.min(Math.round(2.5 * FLICKS), lengthOfClip(c.id))
          const room = Math.max(0, source.facts.duration - duration)
          const from = room ? Math.round((i * 3 * FLICKS) % room) : 0
          return duration > FLICKS / 2 ? { op: "place_broll", asset: source.id, at: { clip: c.id, edge: "start" }, in: from, duration } : null
        })
        .filter(Boolean)
    : []
  if (brief.broll === "own" && !brollSources.length) notes.push("There's no other video in the bin, so the cut has no B-roll. Add clips to the bin and make it again.")
  // Title cards: each emphasis word pops on screen, unless captions already carry the words
  const titleWords = brief.titles && !LOOKS[brief.captions] ? [...new Set(emphasis.value.emphasis)].slice(0, most).map((wid) => index.words.find((w) => w.id === wid)).filter(Boolean) : []
  if (brief.titles && LOOKS[brief.captions]) notes.push("Captions already put the words on screen, so there are no separate title cards.")
  const titles = titleWords.map((w) => ({ op: "add_title", text: w.text.replace(/[^\p{L}\p{N}%$₹' -]/gu, "").toUpperCase().slice(0, 40) || w.text, at: { word: w.id, edge: "start" }, duration: Math.round(1.2 * FLICKS) }))
  // A speed ramp out of the cold open: its last 1.2 s rushes up to 2× into the story
  const coldClip = clips.find((c) => c.echo)
  const coldEnd = cold && index.words.find((w) => w.id === cold.to)?.end
  const coldStart = cold && index.words.find((w) => w.id === cold.from)?.start
  const rampFrom = coldEnd ? Math.max(coldEnd - Math.round(1.2 * FLICKS), coldStart + Math.round((coldEnd - coldStart) / 3)) : 0
  const ramps = brief.ramps && coldClip && coldEnd ? [{ op: "speed_ramp", clip: coldClip.id, from: rampFrom, to: coldEnd, peak: { n: 2, d: 1 } }] : []
  // Background noise out of the voice: FFmpeg's own denoise, EQ, de-ess and compression (clean_voice)
  const cleaning = brief.cleanVoice ? clips.map((c) => ({ op: "clean_voice", clip: c.id, strength: 0.6 })) : []

  // Captions, when the brief asks for a look: pages of the kept words, timed to the speech
  const captions = LOOKS[brief.captions] ? chosen.flatMap((l) => runsOf(l)).flatMap((run) => readablePages(pages(run), run)).map((ids) => ({ op: "caption_style", look: brief.captions, words: ids })) : []
  // Music, when the brief names a sound in the project: fitted on its downbeats, ducked under the speech (ED9)
  const song = brief.music ? project.assets.find((a) => a.id === brief.music && a.kind === "audio") : null
  if (brief.music && !song) notes.push(`There is no sound "${brief.music}" in this project, so the reel has no music.`)
  const music = song ? [{ op: "set_music", asset: song.id }, { op: "music_shape", fit: true, fadeIn: Math.round(FLICKS * 0.3) }, { op: "duck" }] : []
  const captionLook = { ...(brief.captionStyle ?? {}), ...(brief.holdCaptions ? { hold: true } : {}) }
  const style = LOOKS[brief.captions] && Object.keys(captionLook).length ? [{ op: "set_look", caption: captionLook }] : []
  const all = [...ops, ...style, ...angles, ...punches, ...framing, ...grading, ...cleaning, ...broll, ...titles, ...scenes.ops, ...captions, ...music, ...sounds, ...ramps]
  step = apply(project, all, { index, author: "agent" })
  if (!step.applied) throw new Error(`The reel was refused: ${step.diagnostics[0].message}`)
  return { ops: all, project: step.project, notes, calls, slots }
}
