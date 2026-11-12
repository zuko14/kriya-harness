// The assembly make (TP2, ASSEMBLY_AND_INTENT §6): many files in one film, in the order the
// person gave. It runs only when the make's own brief carries an assembly with two or more
// parts in the order, or a part over or under them (EH-63); one file with none is the reel
// it always was. It reuses the reel's steps: the same story slot per talking part, the same
// captions, look and music. Code does the editing; the model only chooses a story per part.

import { apply } from "../core/ops.js"
import { solve } from "../core/solver.js"
import { TRANSITION_DEFAULT, TRANSITIONS } from "../core/transitions.js"
import { clipList, stretchOf } from "../director/assembly.js"
import { ALL_LOOKS, pageLimits, pages, placeOf, readablePages } from "../engine/captions.js"
import { paperEdit } from "../index/views.js"
import { isSceneBlock } from "../core/layout.js"
import { graphicOps, isPlanGraphic } from "./graphic-clips.js"
import { candidateLines, deliverableFor, fitLines, GRADES, recipeFor, remadeClips, runsOf, STORY_SCHEMA, trimIndex } from "./reel.js"
import { sceneOps } from "./scene-clips.js"
import { referenceLook } from "./reference-look.js"

const FLICKS = 705_600_000
const SPINE = ["story", "whole"]
const LEVEL_MAX = 12 // dB a part's speech may be moved to meet the others
const LEVEL_MIN = 0.5 // under this the parts already sound alike
const OVER_MIN = FLICKS / 2
const MUTE = -60 // dB: a picture's own sound under a voice-over

/** A part's story is kept by what it plays, so a reorder (or new part ids) asks the model nothing (TG-08). */
export const storyKey = (part) => JSON.stringify([part.asset, part.from ?? null, part.to ?? null])

/**
 * How a part's picture sits in the frame when nobody said (§6.2): the same shape fills it; a face
 * is followed; anything else of another shape keeps its whole picture over a blurred copy.
 * @returns {"fill" | "fit" | "blur" | "subject"}
 */
export function frameFor(part, facts, canvas, hasSubject) {
  if (part.fit) return part.fit
  if (!facts?.width || !facts?.height) return "fill"
  const [source, frame] = [facts.width / facts.height, canvas.width / canvas.height]
  if (Math.abs(source - frame) / frame < 0.02) return "fill"
  return hasSubject ? "subject" : "blur"
}

/**
 * Each part's speech brought to the loudest-used part's level (§6.2): within 1 LU after, each
 * move inside LEVEL_MAX. A part nobody measured is left as it is.
 * @param {{ id: string, lufs: number | null | undefined }[]} measured the reference first
 * @returns {Map<string, number>} part id → dB
 */
export function levelsFor(measured) {
  const out = new Map()
  const reference = measured.find((m) => Number.isFinite(m.lufs))
  if (!reference) return out
  for (const m of measured) {
    if (m === reference || !Number.isFinite(m.lufs)) continue
    const db = Math.round((reference.lufs - m.lufs) * 10) / 10
    if (Math.abs(db) >= LEVEL_MIN) out.set(m.id, Math.max(-LEVEL_MAX, Math.min(LEVEL_MAX, db)))
  }
  return out
}

/**
 * @param {{
 *   project: object, index: object, brief: object, ask: Function, signal?: AbortSignal,
 *   loudness?: Record<string, number | null>, filters?: Set<string> | null, offline?: string[]
 * }} input
 *   brief.assembly: `{ version, parts }`, already checked; loudness: each file's measured speech
 *   loudness in LUFS (the Host measures; none means nothing is levelled); filters: what this
 *   FFmpeg can draw (null: unknown, so nothing that needs a pack is asked for); offline: files gone
 * @returns {Promise<{ ops: object[], project: object, notes: string[], calls: number, slots: Record<string, string>, story: object, order: string[] }>}
 */
export async function planAssembly({ project, index: fullIndex, brief = {}, ask, signal, loudness = {}, filters = null, offline = [] }) {
  const recipe = recipeFor(brief)
  const notes = []
  const slots = {}
  let calls = 0
  const clips = clipList(project, fullIndex)
  const clipOf = (asset) => clips.find((c) => c.asset === asset)
  const name = (part) => `clip ${clipOf(part.asset)?.n ?? "?"}`
  const factsOf = (asset) => project.assets.find((a) => a.id === asset)?.facts ?? {}

  // A file that has gone is left out, with a note (§8); the Host ends `needs_you` when it was asked for by name
  const gone = new Set(offline)
  const all = brief.assembly.parts.filter((part) => {
    if (!gone.has(part.asset)) return true
    notes.push(`Left out ${name(part)}: its file isn't where it was.`)
    return false
  })
  const hosts = new Set(all.filter((p) => SPINE.includes(p.use)).map((p) => p.id))
  const parts = all.filter((part) => SPINE.includes(part.use) || part.use === "sound" || hosts.has(part.at?.part) || (notes.push(`Left out ${name(part)}: the part it played over isn't in this film.`), false))
  const spine = parts.filter((p) => SPINE.includes(p.use))
  if (!spine.length) throw new Error("This film has no part left to show: every file in its order is missing.")
  // A sound part with speech is a voice-over: it becomes the clock, and the pictures are laid over it in order
  const sounds = parts.filter((p) => p.use === "sound")
  const voice = sounds.find((p) => clipOf(p.asset)?.speech && clipOf(p.asset)?.kind === "audio") ?? null
  for (const p of sounds.filter((p) => clipOf(p.asset)?.speech && clipOf(p.asset)?.kind !== "audio")) notes.push(`${name(p)} is a video, and only a sound file can be the voice-over yet, so it isn't heard.`)
  const song = sounds.find((p) => p !== voice && !clipOf(p.asset)?.speech) ?? null
  for (const p of sounds.filter((p) => p !== voice && p !== song && !clipOf(p.asset)?.speech)) notes.push(`${name(p)} isn't heard: a film has one song.`)

  // 1. Story, per talking part, in the film's order: the reel's own slot, scoped to that part's stretch
  const talking = voice ? [] : spine.filter((p) => p.use === "story" && clipOf(p.asset)?.speech)
  const asked = brief.targetDuration
  const lengthOfLine = (line) => runsOf(line).reduce((sum, run) => sum + (run.at(-1).end - run[0].start), 0)
  const scopes = new Map()
  for (const part of talking) {
    const { from, to } = stretchOf(part, clipOf(part.asset), fullIndex)
    const outside = [{ from: 0, to: from }, { from: to, to: Number.MAX_SAFE_INTEGER }].filter((c) => c.to > c.from)
    const { index } = trimIndex(fullIndex, part.asset, outside)
    const lines = candidateLines(index, part.asset, brief.picks)
    scopes.set(part.id, { index, lines, speech: lines.reduce((sum, l) => sum + lengthOfLine(l), 0) })
  }
  const wholeLength = spine.filter((p) => !talking.includes(p)).reduce((sum, p) => sum + (stretchOf(p, clipOf(p.asset), fullIndex).to - stretchOf(p, clipOf(p.asset), fullIndex).from), 0)
  const speechTotal = [...scopes.values()].reduce((sum, s) => sum + s.speech, 0)
  const stories = {}
  const chosenBy = new Map()
  for (const part of talking) {
    const { index, lines, speech } = scopes.get(part.id)
    const ids = new Set(lines.map((l) => l.id))
    if (!lines.length) {
      chosenBy.set(part.id, [])
      continue
    }
    // The share of the asked length this part may take, when a length was asked for
    const share = asked && speechTotal > 0 ? Math.max(0, Math.round(((asked - wholeLength) * speech) / speechTotal)) : null
    const mustKeep = (brief.mustKeep ?? []).filter((id) => ids.has(id))
    const key = storyKey(part)
    const was = brief.story?.parts?.[key]
    const kept = was && typeof was === "object" ? { hook: ids.has(was.hook) ? was.hook : null, drop: (Array.isArray(was.drop) ? was.drop : []).filter((id) => ids.has(id)) } : null
    const scoped = { ...index, sentences: lines, words: lines.flatMap((l) => l.words), takes: [] }
    const story = kept
      ? { value: kept, source: "kept", calls: 0 }
      : await ask({
          task: "story",
          schema: STORY_SCHEMA,
          recipe: recipe.notes,
          view: paperEdit(scoped, { assets: [part.asset] }),
          request: `This is part ${spine.indexOf(part) + 1} of ${spine.length} of one film made from several files. Choose this part's opening line (a sentence id from the list, or null to keep the order) and any lines to drop because they repeat or wander.${share ? ` This part should run about ${Math.round(share / FLICKS)} seconds.` : ""} Never drop: ${mustKeep.join(", ") || "(none)"}.`,
          maxOutput: 300,
          check: ({ hook, drop }) => [hook, ...drop].filter((id) => id !== null && !ids.has(id)).map((id) => `"${id}" isn't one of the sentences shown`),
          fallback: () => ({ hook: null, drop: [] }),
          signal,
        })
    calls += story.calls
    slots.story = slots.story && slots.story !== story.source ? "mixed" : story.source
    if (story.reason) notes.push(`Story of ${name(part)}: ${story.reason} Kept every line, in order.`)
    stories[key] = { hook: story.value.hook ?? null, drop: story.value.drop ?? [] }
    let chosen = lines.filter((l) => !story.value.drop.includes(l.id) || mustKeep.includes(l.id))
    const hook = story.value.hook
    if (share && chosen.reduce((sum, l) => sum + lengthOfLine(l), 0) > share) chosen = fitLines(chosen, share, new Set([...mustKeep, ...(hook ? [hook] : [])]))
    if (hook && chosen.some((l) => l.id === hook)) chosen = [chosen.find((l) => l.id === hook), ...chosen.filter((l) => l.id !== hook)]
    chosenBy.set(part.id, chosen)
  }

  // 2. The spine: what was there goes, then each part's ranges in the film's order. A join between two files is a real cut
  const sequence = project.sequences.find((q) => q.id === project.active)
  const rebuilt = new Set(sequence.tracks.filter((t) => ["base", "caption", "music", "ambience"].includes(t.role)).map((t) => t.id))
  const ops = [
    // What an earlier make placed goes too: its cutaways carry the mark, so none shows twice (EH-60)
    ...remadeClips(sequence, (c) => rebuilt.has(c.track) || c.plan === true || c.effects?.some((e) => isSceneBlock(e) || isPlanGraphic(e))).map((c) => ({ op: "ripple_delete", clip: c.id })),
    { op: "set_brief", format: "assembly", targetDuration: asked ?? FLICKS, mustKeep: brief.mustKeep ?? [], mustCut: brief.mustCut ?? [], effort: brief.effort ?? "best", ...(brief.language ? { language: brief.language } : {}) },
    { op: "set_format", width: recipe.canvas.width, height: recipe.canvas.height, fps: recipe.deliverable.fps },
    ...(project.deliverables.some((d) => d.preset === recipe.deliverable.preset) ? [] : [{ op: "add_deliverable", ...deliverableFor(brief) }]),
  ]
  const counts = [] // how many clips each spine part laid, in order
  const voiceLength = voice ? stretchOf(voice, clipOf(voice.asset), fullIndex).to - stretchOf(voice, clipOf(voice.asset), fullIndex).from : 0
  const pictureTotal = spine.reduce((sum, p) => sum + (stretchOf(p, clipOf(p.asset), fullIndex).to - stretchOf(p, clipOf(p.asset), fullIndex).from), 0)
  for (const part of spine) {
    const before = ops.length
    const stretch = stretchOf(part, clipOf(part.asset), fullIndex)
    if (voice) {
      // The voice-over is the clock: each picture gets its share of it, never more than it has
      const length = Math.min(stretch.to - stretch.from, Math.round((voiceLength * (stretch.to - stretch.from)) / pictureTotal))
      if (length > 0) ops.push({ op: "keep_range", asset: part.asset, from: stretch.from, to: stretch.from + length })
    } else if (chosenBy.has(part.id)) {
      for (const line of chosenBy.get(part.id)) for (const run of runsOf(line)) ops.push({ op: "keep_range", asset: part.asset, from: { word: run[0].id, edge: "start" }, to: { word: run.at(-1).id, edge: "end" } })
    } else ops.push({ op: "keep_range", asset: part.asset, from: part.from ?? stretch.from, to: part.to ?? stretch.to })
    counts.push(ops.length - before)
    if (ops.length === before) notes.push(`${name(part)} has nothing left to play in this cut, so it's out.`)
  }
  let step = apply(project, ops, { index: fullIndex, author: "agent" })
  if (!step.applied) throw new Error(`The film's order was refused: ${step.diagnostics[0].message}`)
  const baseTracks = new Set(sequence.tracks.filter((t) => t.role === "base").map((t) => t.id))
  const laid = step.project.sequences.find((q) => q.id === step.project.active).clips.filter((c) => baseTracks.has(c.track) || c.track === "t-base")
  const clipsOf = new Map()
  let at = 0
  spine.forEach((part, i) => {
    clipsOf.set(part.id, laid.slice(at, at + counts[i]))
    at += counts[i]
  })
  const live = spine.filter((p) => clipsOf.get(p.id).length)

  // 3. Conform each part to the film (§6.2): shape, level, colour, room sound. Each degrades with a note; none fails a make (EH-76)
  const conform = []
  const canvas = recipe.canvas
  for (const part of live) {
    const facts = factsOf(part.asset)
    const subject = (fullIndex.subjects?.[part.asset]?.length ?? 0) > 0
    const mode = frameFor(part, facts, canvas, subject)
    const cropWidth = facts.height ? Math.round((facts.height * canvas.width) / canvas.height) : 0
    for (const clip of clipsOf.get(part.id)) {
      if (mode === "fit" || mode === "blur") conform.push({ op: "set_frame", clip: clip.id, mode })
      // Fill is today's behaviour: follow the speaker where there is one, else hold the centre
      else if (facts.width && cropWidth < facts.width) conform.push(subject ? { op: "reframe", clip: clip.id, mode: "subject" } : { op: "reframe", clip: clip.id, mode: "fixed", x: Math.max(0, Math.round((facts.width - cropWidth) / 2)) })
    }
    if (facts.vfr) notes.push(`${name(part)} was recorded at a changing frame rate; it plays at the film's ${canvas.fps?.n ?? recipe.deliverable.fps.n} frames a second.`)
  }
  // The reference is the longest talking part: the others meet its level and its colour
  const lengthOf = (part) => solveLength(step.project, fullIndex, clipsOf.get(part.id))
  const speaking = live.filter((p) => clipOf(p.asset)?.speech && !voice)
  const reference = [...speaking].sort((a, b) => lengthOf(b) - lengthOf(a))[0] ?? null
  if (reference) {
    const heard = live.filter((p) => factsOf(p.asset).hasAudio !== false)
    const levels = levelsFor([reference, ...heard.filter((p) => p !== reference)].map((p) => ({ id: p.id, lufs: loudness[p.asset] })))
    for (const [id, db] of levels) for (const clip of clipsOf.get(id)) conform.push({ op: "set_level", clip: clip.id, db })
    if (heard.length > 1 && !Number.isFinite(loudness[reference.asset])) notes.push("The parts' loudness wasn't measured here, so each keeps the level it was recorded at.")
    const others = live.filter((p) => p.asset !== reference.asset && clipOf(p.asset)?.picture)
    if (others.length) {
      if (filters?.has("lut3d")) for (const p of others) for (const clip of clipsOf.get(p.id)) conform.push({ op: "match_color", clip: clip.id, reference: clipsOf.get(reference.id)[0].id })
      else notes.push("This computer's FFmpeg can't match colour between files (it has no lut3d), so each part keeps the colour it was shot with.")
    }
    // Room sound under the joins: a quiet stretch of the reference file, looped under the film
    const quiet = (fullIndex.silences ?? []).filter((s) => s.asset === reference.asset && s.end - s.start >= 0.4 * FLICKS).sort((a, b) => b.end - b.start - (a.end - a.start))[0]
    if (quiet && live.length > 1) conform.push({ op: "room_tone", asset: reference.asset, from: quiet.start, to: quiet.end })
  }
  if (voice) for (const part of live) if (factsOf(part.asset).hasAudio !== false) for (const clip of clipsOf.get(part.id)) conform.push({ op: "set_level", clip: clip.id, db: MUTE })

  // 4. Over parts: the picture plays over its host's voice, at the word or the place asked for
  const over = []
  const wordsById = new Map((fullIndex.words ?? []).map((w) => [w.id, w]))
  const keptWords = new Set([...chosenBy.values()].flatMap((lines) => lines.flatMap((l) => runsOf(l).flat().map((w) => w.id))))
  for (const part of parts.filter((p) => p.use === "over")) {
    const clip = clipOf(part.asset)
    const host = clipsOf.get(part.at.part) ?? []
    if (!clip?.picture || !host.length) {
      notes.push(`Left out ${name(part)} as a cutaway: ${clip?.picture ? "the part it plays over has nothing left in this cut" : "it has no picture"}.`)
      continue
    }
    const stretch = stretchOf(part, clip, fullIndex)
    const own = stretch.to - stretch.from
    const hostLength = solveLength(step.project, fullIndex, host)
    let anchor
    let length = Math.min(own, hostLength)
    const word = part.at.word === undefined ? null : wordsById.get(part.at.word)
    if (word && keptWords.has(word.id)) {
      anchor = { word: word.id, edge: "start" }
      // Capped by the sentence it sits on, unless the part's own stretch was asked for
      const sentence = (fullIndex.sentences ?? []).find((s) => s.asset === word.asset && word.start >= s.start && word.end <= s.end)
      if (sentence && part.from === undefined) length = Math.min(length, Math.max(OVER_MIN, sentence.end - word.start))
    } else {
      if (part.at.word !== undefined) notes.push(`The word ${name(part)} was to play over isn't in this cut, so it starts with that part.`)
      const where = part.at.where ?? "start"
      if (part.at.t !== undefined) anchor = { clip: host[0].id, edge: "start", offset: Math.min(part.at.t, Math.max(0, hostLength - OVER_MIN)) }
      else if (where === "end") anchor = { clip: host.at(-1).id, edge: "end", offset: -Math.min(length, hostLength) }
      else if (where === "middle") anchor = { clip: host[0].id, edge: "start", offset: Math.max(0, Math.round((hostLength - length) / 2)) }
      else anchor = { clip: host[0].id, edge: "start" }
    }
    if (length < OVER_MIN) {
      notes.push(`Left out ${name(part)} as a cutaway: there's under half a second for it.`)
      continue
    }
    over.push({ op: "place_over", asset: part.asset, at: anchor, in: stretch.from, duration: length })
  }

  // 5. Sound parts: a song is fitted and ducked as in a reel; a voice-over is heard at its own level
  const music = []
  const bed = song ? song.asset : brief.music && project.assets.some((a) => a.id === brief.music && a.kind === "audio") ? brief.music : null
  if (brief.music && !bed) notes.push(`There is no sound "${brief.music}" in this project, so the film has no music.`)
  if (bed) music.push({ op: "set_music", asset: bed }, { op: "music_shape", fit: true, fadeIn: Math.round(FLICKS * 0.3) }, { op: "duck" })
  const narration = voice ? [{ op: "add_sfx", asset: voice.asset, peak_at: 0 }] : []

  // 6. The dressing: look, voice cleanup, captions, transitions at the joins when asked
  const look = GRADES[brief.grade] ?? (brief.customGrade && typeof brief.customGrade === "object" ? brief.customGrade : null)
  const pictures = live.flatMap((p) => clipsOf.get(p.id))
  // TP6: a reference's colour as a measured match (a LUT the Host wrote), only when this brief carries one
  const grading = brief.lut ? pictures.map((c) => ({ op: "apply_lut", clip: c.id, asset: brief.lut })) : look ? pictures.map((c) => ({ op: "grade", clip: c.id, ...look })) : []
  const cleaning = brief.cleanVoice && !voice ? live.filter((p) => clipOf(p.asset)?.speech).flatMap((p) => clipsOf.get(p.id)).map((c) => ({ op: "clean_voice", clip: c.id, strength: 0.6 })) : []
  const runs = voice ? [wordsRun(fullIndex, voice, clipOf(voice.asset))] : live.flatMap((p) => (chosenBy.get(p.id) ?? []).flatMap((l) => runsOf(l)))
  const captions = ALL_LOOKS[brief.captions] ? runs.filter((run) => run.length).flatMap((run) => readablePages(pages(run, pageLimits(brief.captions)), run)).map((ids) => ({ op: "caption_style", look: brief.captions, words: ids })) : []
  const captionLook = { ...(brief.captionStyle ?? {}), ...(brief.holdCaptions ? { hold: true } : {}), ...(placeOf(brief.captions) ? { place: placeOf(brief.captions) } : {}) }
  const style = ALL_LOOKS[brief.captions] && Object.keys(captionLook).length ? [{ op: "set_look", caption: captionLook }] : []
  const joins = Object.hasOwn(TRANSITIONS, brief.transition ?? "") ? live.slice(1).map((p) => ({ op: "transition", clip: clipsOf.get(p.id)[0].id, kind: brief.transition, duration: TRANSITION_DEFAULT })) : []
  if (brief.coldOpen || brief.punches || brief.angles || brief.titles || brief.ramps || brief.broll === "own") notes.push("A cold open, punch-ins, angles, title cards, speed ramps and automatic B-roll are a single take's; a film of several files doesn't use them yet.")

  let allOps = [...ops, ...style, ...conform, ...grading, ...cleaning, ...over, ...captions, ...music, ...narration, ...joins]
  step = apply(project, allOps, { index: fullIndex, author: "agent" })
  if (!step.applied) throw new Error(`The film was refused: ${step.diagnostics[0].message}`)
  // TP6: a reference's grain, corners and bars over the whole film, only when this brief carries them (EH-59)
  if (brief.fx?.length) step = referenceLook({ project, all: allOps, step, fx: brief.fx, index: fullIndex, notes })
  const placedNow = step.project.sequences.find((q) => q.id === step.project.active).clips
  // The voice-over plays at its own level, not as an effect under a voice
  if (voice) {
    const heard = placedNow.find((c) => c.source?.asset === voice.asset && !baseTracks.has(c.track))
    if (heard) allOps.push({ op: "set_level", clip: heard.id, db: 0 })
  }
  // A cutaway of another shape sits in the frame by the same rule as a part of the order
  for (const clip of placedNow.filter((c) => c.plan === true)) {
    const part = parts.find((p) => p.use === "over" && p.asset === clip.source.asset)
    const mode = frameFor(part ?? {}, factsOf(clip.source.asset), canvas, false)
    if (mode === "fit" || mode === "blur") allOps.push({ op: "set_frame", clip: clip.id, mode })
  }
  // Scenes and graphics from an approved plan, per talking file: each keys on its own words
  const keptOf = (asset) => live.filter((p) => p.asset === asset).flatMap((p) => (chosenBy.get(p.id) ?? []).flatMap((l) => runsOf(l).flat()))
  const files = [...new Set(live.filter((p) => chosenBy.has(p.id)).map((p) => p.asset))]
  const fileOf = (id) => wordsById.get(id)?.asset
  for (const asset of files) {
    const scenes = (brief.scenes ?? []).filter((s) => fileOf(s.from) === asset)
    const picturesHere = (brief.pictures ?? []).filter((s) => fileOf(s.from) === asset)
    const terms = (brief.terms ?? []).filter((t) => fileOf(t.at) === asset)
    if (scenes.length || picturesHere.length || terms.length) {
      const made = sceneOps({ scenes, pictures: picturesHere, terms, project: apply(project, allOps, { index: fullIndex, author: "agent" }).project, index: fullIndex, asset, kept: keptOf(asset), captions: !!ALL_LOOKS[brief.captions], sound: { scene: brief.sfx?.scene, reveal: brief.sfx?.reveal } })
      allOps.push(...made.ops)
      notes.push(...made.notes)
    }
    // An opening title belongs to the first talking file and an end card to the last; the rest sit on their own words
    const graphics = (brief.graphics ?? []).filter((g) => (g.kind === "intro" ? asset === files[0] : g.kind === "end" ? asset === files.at(-1) : fileOf(g.at) === asset))
    if (graphics.length) {
      const made = graphicOps({ graphics, project: apply(project, allOps, { index: fullIndex, author: "agent" }).project, index: fullIndex, asset, kept: keptOf(asset) })
      allOps.push(...made.ops)
      notes.push(...made.notes)
    }
  }
  step = apply(project, allOps, { index: fullIndex, author: "agent" })
  if (!step.applied) throw new Error(`The film was refused: ${step.diagnostics[0].message}`)
  // With no length asked for, the film is as long as its parts: the brief says so, so QG-12 checks what was meant
  if (!asked) {
    const length = solve(step.project, fullIndex).duration
    allOps = allOps.map((op) => (op.op === "set_brief" ? { ...op, targetDuration: Math.max(1, length) } : op))
    step = apply(project, allOps, { index: fullIndex, author: "agent" })
  }

  // 7. What I did: the order as made, part by part
  const seconds = (flicks) => `${(flicks / FLICKS).toFixed(1)} s`
  const madeProject = step.project
  const order = [
    ...live.map((part, i) => `${i + 1}. ${name(part)}${clipOf(part.asset)?.label ? ` "${clipOf(part.asset).label}"` : ""}, ${voice ? "picture" : part.use}, ${seconds(lengthOf(part))}${part.why && part.why !== "person" && part.why !== "storyboard" ? ` (${part.why === "director" ? "the Director's choice" : "the order added"})` : ""}`),
    ...over.map((op) => `${name({ asset: op.asset })} over the voice for ${seconds(op.duration)}`),
    ...(bed ? [`Music under the film${song ? ` from ${name(song)}` : ""}`] : []),
    ...(voice ? [`${name(voice)} as the voice-over, which sets the timing`] : []),
  ]
  notes.unshift(`The film's order: ${order.join("; ")}.`)
  return { ops: allOps, project: madeProject, notes, calls, slots, story: { parts: stories }, order }
}

// The length a part's clips take on the timeline
function solveLength(project, index, clips) {
  const ids = new Set(clips.map((c) => c.id))
  return solve(project, index).picture.filter((p) => ids.has(p.clip)).reduce((sum, p) => sum + (p.end - p.at), 0)
}

// A voice-over's words, in its stretch, as one run for captions
function wordsRun(index, part, clip) {
  const { from, to } = stretchOf(part, clip, index)
  return (index.words ?? []).filter((w) => w.asset === part.asset && w.start >= from && w.end <= to && !(w.flags ?? []).some((f) => f === "filler" || f === "stutter"))
}
