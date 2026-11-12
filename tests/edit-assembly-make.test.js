import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

import { PLATE, frameSteps, segmentArgs } from "../src/edit/core/ffmpeg.js"
import { apply } from "../src/edit/core/ops.js"
import { compile } from "../src/edit/core/plan.js"
import { hashProject, newProject } from "../src/edit/core/project.js"
import { solve } from "../src/edit/core/solver.js"
import { applyMoves, ASSEMBLY_SCHEMA, assemblyProblems, clipList, decideAssembly, defaultParts, essence, findSaid, isAssembly, resolveRefs, sameAssembly, splitAt, withIds } from "../src/edit/director/assembly.js"
import { remapIds, replayable, storyFor } from "../src/edit/director/continuity.js"
import { PLAN_SCHEMA } from "../src/edit/director/plan.js"
import { judgeOrder, sameRegion, thumbDistance } from "../src/edit/gates/assembly.js"
import { GATES } from "../src/edit/gates/index.js"
import { carryEdits } from "../src/edit/loop/make.js"
import { replayAsk } from "../src/edit/loop/replay.js"
import { frameFor, levelsFor, planAssembly, storyKey } from "../src/edit/recipes/assembly.js"
import { planReel, remadeClips } from "../src/edit/recipes/reel.js"
import { ROOT } from "./helpers.js"
import { indexOf, lengthOf } from "./edit/script.js"

// TP2 (ASSEMBLY_AND_INTENT §3 to §6, TOP_TIER_PLAN §5): the resolver, the slot's check, who wins,
// the assembly recipe, conform, continuity across parts, and the proof that one take is what it was.
// No media and no model: a function stands in wherever a slot is asked.

const FLICKS = 705_600_000
const OTHER = ["Welcome back to the second recording of the day.", "Here we talk about shipping and the delivery times.", "It took fifty thousand steps to walk there.", "That is all for the second recording."]

const video = (id, seconds, path, more = {}) => ({ op: "add_asset", id, kind: "video", fingerprint: `f-${id}`, path, linked: true, rights: "unknown", facts: { width: 640, height: 360, hasAudio: true, duration: Math.round(seconds * FLICKS), vfr: false, fps: { n: 30, d: 1 } }, ...more })
const sound = (id, seconds, path, more = {}) => ({ op: "add_asset", id, kind: "audio", fingerprint: `f-${id}`, path, linked: true, rights: "own", facts: { duration: Math.round(seconds * FLICKS), hasAudio: true }, ...more })

/** a1 talks (the script), a2 "beach final" is wide B-roll, a3 "outro" is tall, a4 a song, a5 talks too, a6 a narration. */
function world() {
  const base = apply(newProject({ id: "p", name: "Film" }), [video("a1", lengthOf(), "talk.mov"), video("a2", 5, "beach final.mov", { facts: { width: 1280, height: 720, hasAudio: true, duration: 5 * FLICKS, vfr: false, fps: { n: 30, d: 1 } } }), video("a3", 2, "outro.mov", { facts: { width: 1080, height: 1920, hasAudio: true, duration: 2 * FLICKS, vfr: false, fps: { n: 30, d: 1 } } }), sound("a4", 30, "song.wav", { role: "music" }), video("a5", lengthOf(OTHER), "second take.mov"), sound("a6", lengthOf(OTHER), "narration.wav")], { author: "code" })
  assert.equal(base.applied, true)
  const [one, two, three] = [indexOf("a1"), indexOf("a5", OTHER), indexOf("a6", OTHER)]
  const index = { ...one, words: [...one.words, ...two.words, ...three.words], sentences: [...one.sentences, ...two.sentences, ...three.sentences], takes: [...one.takes, ...two.takes, ...three.takes] }
  return { project: base.project, index, clips: clipList(base.project, index) }
}
const w = world()
// Three files, no second talker: what most requests are about
const small = () => {
  const project = apply(newProject({ id: "p", name: "Film" }), [video("a1", lengthOf(), "talk.mov"), video("a2", 5, "beach final.mov", { facts: { width: 1280, height: 720, hasAudio: true, duration: 5 * FLICKS, vfr: false, fps: { n: 30, d: 1 } } }), video("a3", 2, "outro.mov"), sound("a4", 30, "song.wav", { role: "music" })], { author: "code" }).project
  const index = indexOf("a1")
  return { project, index, clips: clipList(project, index) }
}
const s3 = small()
const said = (text, at = s3, options = {}) => resolveRefs(text, at.clips, { index: at.index, ...options })
const order = (text, at = s3, base) => {
  const read = said(text, at)
  const made = applyMoves(base ?? defaultParts(at.clips), read.moves, { clips: at.clips, index: at.index, anchored: !!base })
  return { parts: made.parts, open: [...read.open, ...made.open], spine: made.parts.filter((p) => ["story", "whole"].includes(p.use)).map((p) => p.asset) }
}
/** A slot stand-in: counts each task and answers with the slot's own default, or what `answers` says. */
const asker = (answers = {}) => {
  const tasks = []
  const ask = async (slot) => {
    tasks.push(slot.task)
    const value = answers[slot.task] ? answers[slot.task](slot, tasks.filter((t) => t === slot.task).length) : slot.fallback()
    const problems = value && slot.check ? slot.check(value) : []
    return problems.length ? { value: slot.fallback(), source: "default", reason: problems[0], calls: 1 } : { value, source: "model", calls: 1 }
  }
  return { ask, tasks }
}
const assemblyOf = (parts) => ({ version: 1, parts: withIds(parts) })
const plays = (project, index) => solve(project, index).picture.map((p) => p.asset).filter((asset, i, all) => asset !== all[i - 1])

test("ET-ASM-10: numbers point at clips: clip 2, clips 1, 3 and 2, the 2nd video, the last one; a number no clip has is left open", () => {
  assert.deepEqual(said("clip 3 first, then clip 1, then clip 2").refs.map((r) => r.asset), ["a3", "a1", "a2"])
  assert.deepEqual(said("use clips 1, 3 and 2 in that order").refs.map((r) => r.asset), ["a1", "a3", "a2"])
  assert.equal(said("the 2nd video goes first").refs[0].asset, "a2")
  assert.equal(said("put the last one at the start").refs[0].asset, "a4", "the last file added, whatever it is")
  assert.equal(said("the third clip at the end").refs[0].asset, "a3")
  const none = said("clip 9 first")
  assert.deepEqual([none.refs[0].asset, none.open.length, none.moves.length], [undefined, 1, 0], "no clip 9: left open, and nothing is moved")
  // A time is not a clip number
  assert.deepEqual(said("trim clip 1 to 30 seconds").refs.map((r) => r.asset), ["a1"])
  assert.deepEqual(said("cut the video at 0:30").refs, [])
  // A mention needs no reading at all
  const pointed = said("put ⟦1⟧ before ⟦2⟧", s3, { mentions: [{ asset: "a3" }, { asset: "a1", from: 2 * FLICKS, to: 4 * FLICKS }] })
  assert.deepEqual(pointed.refs.map((r) => [r.asset, r.from ?? null]), [["a3", null], ["a1", 2 * FLICKS]])
  assert.equal(pointed.moves[0].do, "before")
})

test("ET-ASM-11: labels, then a file name's words; a near miss counts at five letters; two clips with one name are left open", () => {
  assert.equal(said("start with the outro").refs[0].asset, "a3")
  assert.equal(said("the beach final clip goes last").refs[0].asset, "a2", "the whole file name")
  assert.equal(said("put beach first").refs[0].asset, "a2", "one telling word of it")
  assert.equal(said("put the beech first").refs[0].asset, "a2", "one letter off, five letters")
  assert.deepEqual(said("put the song first", { ...s3, clips: s3.clips.filter((c) => c.asset !== "a4") }).refs, [], "no such file: not a place at all")
  // A label wins over a file name, and is data: cleaned before it is matched
  const labelled = apply(s3.project, [{ op: "describe_asset", asset: "a3", label: "Beach <b>walk</b>" }], { author: "person" }).project
  const clips = clipList(labelled, s3.index)
  assert.equal(clips.find((c) => c.asset === "a3").label, "beach b walk b")
  assert.equal(resolveRefs("beach first", clips, { index: s3.index }).refs[0].asset, "a3", "the label, before any file name")
  // Two file names share the word: two candidates, never guessed
  const both = clipList(apply(s3.project, [video("a7", 4, "beach walk.mov")], { author: "code" }).project, s3.index)
  const twice = resolveRefs("beach first", both, { index: s3.index })
  assert.deepEqual([twice.refs[0].asset, twice.refs[0].open?.sort()], [undefined, ["a2", "a7"]], "two clips answer to beach")
  assert.deepEqual([twice.moves.length, twice.open[0].candidates.sort()], [0, ["a2", "a7"]])
  assert.equal(resolveRefs("beach walk first", both, { index: s3.index }).refs[0].asset, "a7", "the whole name settles it")
})

test("ET-ASM-12: a role points at a clip when one file has it", () => {
  assert.equal(said("use the song under everything").refs[0].asset, "a4")
  assert.equal(said("the talking clip goes last").refs[0].asset, "a1")
  assert.deepEqual(said("add some music").refs, [], "a setting, not a file")
  assert.deepEqual(said("clip 2 as the music").refs.map((r) => r.asset), ["a2"], "what a clip is for isn't a second file")
  // Two files talk: "the talking clip" is left open
  const two = said("the talking clip goes first", w)
  assert.deepEqual([two.refs[0].asset, two.refs[0].open.sort(), two.moves.length], [undefined, ["a1", "a5"], 0])
  const screen = clipList(apply(s3.project, [{ op: "describe_asset", asset: "a2", role: "screen" }], { author: "code" }).project, s3.index)
  assert.equal(resolveRefs("start with the screen recording", screen, { index: s3.index }).refs[0].asset, "a2")
})

test("ET-ASM-13: words spoken find a stretch above the floor; said equally in two files, it is left open", () => {
  const hit = findSaid("fifty thousand rupees", s3.index)
  assert.equal(hit.asset, "a1")
  assert.deepEqual([s3.index.words.find((x) => x.id === hit.from).text, s3.index.words.find((x) => x.id === hit.to).text], ["It", "total."], "the sentence it is said in")
  assert.equal(findSaid("quarterly revenue forecast", s3.index), null, "under the floor: not found")
  const ref = said("start with where I talk about fifty thousand rupees").refs[0]
  assert.deepEqual([ref.by, ref.asset, ref.from.word, ref.to.word], ["transcript", "a1", hit.from, hit.to])
  // "fifty thousand" is said in a1 and in a5
  assert.deepEqual(findSaid("fifty thousand", w.index).open.sort(), ["a1", "a5", "a6"])
  const open = said("start with where I say fifty thousand", w)
  assert.deepEqual([open.moves.length, open.open.length], [0, 1])
  // Asked of one file, it is found
  assert.equal(findSaid("fifty thousand", w.index, { assets: ["a5"] }).asset, "a5")
})

test("ET-ASM-14: each placement word, read by code: first, last, then, after, before, between, in the middle, over, while I say, as the music, leave out", () => {
  assert.deepEqual(order("clip 3 first, then clip 1, then clip 2").spine, ["a3", "a1", "a2"])
  assert.deepEqual(order("start with the outro and end with beach").spine, ["a3", "a1", "a2"])
  assert.deepEqual(order("put clip 3 at the start").spine, ["a3", "a1", "a2"])
  assert.deepEqual(order("clip 1 goes at the end").spine, ["a2", "a3", "a1"])
  assert.deepEqual(order("clip 3 before clip 1").spine, ["a3", "a1", "a2"])
  assert.deepEqual(order("clip 1 after clip 3").spine, ["a2", "a3", "a1"])
  assert.deepEqual(order("after clip 3 comes clip 1").spine, ["a2", "a3", "a1"])
  assert.deepEqual(order("put the outro between clip 1 and clip 2").spine, ["a1", "a3", "a2"])
  assert.deepEqual(order("use only clips 3 and 1").spine, ["a3", "a1"])
  assert.deepEqual(order("don't use clip 2").spine, ["a1", "a3"])
  assert.deepEqual(order("leave out clips 2 and 3").spine, ["a1"])
  // In the middle: the host splits, and the other clip sits between the halves
  const middle = order("put clip 2 in the middle of clip 1")
  assert.deepEqual(middle.spine, ["a1", "a2", "a1", "a3"])
  assert.deepEqual(order("insert clip 2 into clip 1 after I say the hardest part was the design").spine, ["a1", "a2", "a1", "a3"])
  // Over: its picture over another part's voice, on the word when one is named
  const over = order("show clip 2 over clip 1 while I say fifty thousand")
  const part = over.parts.find((p) => p.use === "over")
  assert.deepEqual([over.spine, part.asset, part.at.part, s3.index.words.find((x) => x.id === part.at.word).text], [["a1", "a3"], "a2", "p1", "fifty"])
  assert.deepEqual(order("play clip 2 over the voice at the end").parts.find((p) => p.use === "over").at, { part: "p1", where: "end" })
  assert.deepEqual(order("clip 2 over clip 1 at 0:10").parts.find((p) => p.use === "over").at, { part: "p1", t: 10 * FLICKS })
  // Sound: heard, not seen
  assert.deepEqual(order("use the song under everything").parts.filter((p) => p.use === "sound").map((p) => p.asset), ["a4"])
  assert.deepEqual(order("clip 4 as the music").parts.filter((p) => p.use === "sound").map((p) => p.asset), ["a4"])
  // Nothing about the order: nothing is read into it
  assert.deepEqual(said("make a reel with captions and a whoosh on every cut").moves, [])
  assert.deepEqual(said("remove everything after 0:25").moves, [])
  // A place nobody settled is said, never guessed: no place for the cutaway
  assert.equal(order("use clip 2 as b-roll").open.length, 1)
  // Every part carries who decided
  assert.deepEqual(order("clip 3 first").parts.map((p) => p.why), ["person", "default", "default"])
})

test("ET-ASM-15: splitAt lands on a sentence boundary; the middle is half the kept length; a silent clip splits on the time", () => {
  const part = { id: "p1", asset: "a1", use: "story" }
  const clip = s3.clips[0]
  const sentences = s3.index.sentences
  const [left, right] = splitAt(part, { where: "middle" }, { index: s3.index, clip })
  const [a, b] = [s3.index.words.find((x) => x.id === left.to.word), s3.index.words.find((x) => x.id === right.from.word)]
  assert.ok(sentences.some((s) => s.lastWord === a.id) && sentences.some((s) => s.firstWord === b.id), "between two sentences, never inside one")
  assert.deepEqual([left.to.edge, right.from.edge, left.from, right.to], ["end", "start", undefined, undefined])
  // Half the kept length: with only the last four sentences kept, the middle moves to between them
  const kept = sentences.slice(-4).map((s) => s.id)
  const [keptLeft] = splitAt(part, { where: "middle" }, { index: s3.index, clip, kept })
  assert.equal(keptLeft.to.word, sentences.at(-3).lastWord, "two kept sentences either side")
  const total = sentences.reduce((sum, s) => sum + (s.end - s.start), 0)
  let before = 0
  const boundaries = sentences.slice(0, -1).map((s) => (before += s.end - s.start))
  const nearest = boundaries.reduce((best, x, i) => (Math.abs(x - total / 2) < Math.abs(boundaries[best] - total / 2) ? i : best), 0)
  assert.equal(left.to.word, sentences[nearest].lastWord, "the boundary nearest half the kept speech")
  // A word: straight after the sentence it is in
  const word = s3.index.words.find((x) => x.text === "fifty")
  assert.equal(splitAt(part, { word: word.id }, { index: s3.index, clip })[0].to.word, sentences.find((s) => word.start >= s.start && word.end <= s.end).lastWord)
  // A time in the file
  const [timed] = splitAt(part, { t: sentences[5].end + 1 }, { index: s3.index, clip })
  assert.equal(timed.to.word, sentences[5].lastWord)
  // Nobody speaks: whole flicks, at the half
  const silent = splitAt({ id: "p2", asset: "a2", use: "whole" }, { where: "middle" }, { index: s3.index, clip: s3.clips[1] })
  assert.deepEqual([silent[0].to, silent[1].from], [Math.round(2.5 * FLICKS), Math.round(2.5 * FLICKS)])
  assert.ok(Number.isSafeInteger(silent[0].to))
  // One sentence can't be split
  assert.equal(splitAt({ id: "p", asset: "a1", use: "story", from: { word: sentences[0].firstWord, edge: "start" }, to: { word: sentences[0].lastWord, edge: "end" } }, { where: "middle" }, { index: s3.index, clip }), null)
})

test("ET-ASM-16: assemblyProblems refuses each bad answer, and a refused Director falls back to an order it names", async () => {
  const check = (parts, more = {}) => assemblyProblems({ version: 1, parts }, { project: s3.project, index: s3.index, ...more })
  const p = (id, asset, more = {}) => ({ id, asset, use: "whole", ...more })
  assert.deepEqual(check([p("p1", "a1", { use: "story" }), p("p2", "a2")]), [])
  assert.match(check([p("p1", "nope")])[0], /no asset/)
  assert.match(check([p("p1", "a2", { from: 0, to: 9 * FLICKS })])[0], /past the end/)
  assert.match(check([p("p1", "a1"), p("p2", "a2", { use: "over" })])[0], /plays over another part/)
  assert.match(check([p("p1", "a4")])[0], /can only be heard/)
  assert.match(check([p("p1", "a4", { use: "sound" })])[0], /nothing is in the film's order/)
  assert.match(check([p("p1", "a2", { from: 0, to: 3 * FLICKS }), p("p2", "a3"), p("p3", "a2", { from: 2 * FLICKS, to: 5 * FLICKS })])[0], /same stretch twice/)
  assert.deepEqual(check([p("p1", "a2", { from: 0, to: 2 * FLICKS }), p("p2", "a2", { from: 2 * FLICKS, to: 5 * FLICKS })]), [], "the same file twice, different stretches")
  assert.match(check([p("p1", "a1"), p("p2", "a2")], { targetDuration: 10 * FLICKS })[0], /far over/)
  assert.equal(check(null)[0] ?? assemblyProblems(null, { project: s3.project })[0], "the answer has no parts")
  // Every line the person fixed is kept
  const fixed = said("clip 3 first").moves
  assert.match(check([p("p1", "a1"), p("p2", "a3")], { fixed })[0], /fixed "clip 3 first"/)
  assert.deepEqual(check([p("p1", "a3"), p("p2", "a1")], { fixed }), [])
  // The slot: a bad answer is refused by the check, and the fallback says which order was used
  const bad = asker({ assembly: () => ({ parts: [{ clip: 9, use: "whole", reason: "x" }] }) })
  const fell = await decideAssembly({ project: s3.project, index: s3.index, text: "make one film from all of these", ask: bad.ask })
  assert.deepEqual([bad.tasks, fell.source, fell.assembly.parts.map((x) => x.asset)], [["assembly"], "default", ["a1", "a2", "a3"]])
  assert.match(fell.lines[0], /couldn't be used.*in the order you added them/)
  // A good answer is used, with the Director's name on it
  const good = asker({ assembly: () => ({ parts: [{ clip: 3, use: "whole", reason: "opens on the logo" }, { clip: 1, use: "story", reason: "the talk" }, { clip: 2, use: "over", at: { part: 2, where: "middle" }, reason: "the beach while they talk" }] }) })
  const made = await decideAssembly({ project: s3.project, index: s3.index, text: "combine these into one video", ask: good.ask })
  assert.deepEqual([made.source, made.assembly.parts.map((x) => [x.asset, x.use, x.why])], ["director", [["a3", "whole", "director"], ["a1", "story", "director"], ["a2", "over", "director"]]])
  assert.match(made.lines[0], /clip 2 over part 2: the beach while they talk/)
  // The schema has no field for a path, a command or free text on screen
  assert.deepEqual(Object.keys(ASSEMBLY_SCHEMA.properties.parts.items.properties).sort(), ["at", "clip", "from", "reason", "to", "use"])
})

test("ET-ASM-17: who wins: this message, then the storyboard, earlier messages, the revised plan, the Director, the default", async () => {
  const board = { version: 1, parts: [{ id: "p1", asset: "a2", use: "whole", why: "storyboard" }, { id: "p2", asset: "a1", use: "whole", why: "storyboard" }, { id: "p3", asset: "a3", use: "whole", why: "storyboard" }] }
  const previous = assemblyOf([{ asset: "a3", use: "whole" }, { asset: "a2", use: "whole" }, { asset: "a1", use: "story" }])
  const history = [{ who: "you", text: "clip 2 first, then clip 3, then clip 1" }, { who: "kriya", text: "clip 1 first" }]
  const spineOf = (d) => d.assembly?.parts.filter((x) => ["story", "whole"].includes(x.use)).map((x) => x.asset)
  const none = asker()
  const base = { project: s3.project, index: s3.index, ask: none.ask }
  // This message over everything
  const now = await decideAssembly({ ...base, text: "clip 3 first", storyboard: board, history, previous })
  assert.deepEqual([now.source, spineOf(now)], ["person", ["a3", "a2", "a1"]], "the message moves clip 3; the rest is the storyboard's")
  assert.deepEqual(now.assembly.parts.map((x) => x.why), ["person", "storyboard", "storyboard"])
  // No words about the order: the storyboard, over earlier messages and the plan
  const drawn = await decideAssembly({ ...base, text: "make it punchy", storyboard: board, history, previous })
  assert.deepEqual([drawn.source, spineOf(drawn)], ["storyboard", ["a2", "a1", "a3"]])
  // No storyboard: earlier messages (the person's only, never Kriya's own words), over the plan
  const earlier = await decideAssembly({ ...base, text: "make it punchy", history, previous })
  assert.deepEqual([earlier.source, spineOf(earlier)], ["earlier", ["a2", "a3", "a1"]])
  // Neither: the plan being revised
  const revised = await decideAssembly({ ...base, text: "make it punchy", previous })
  assert.deepEqual([revised.source, spineOf(revised)], ["plan", ["a3", "a2", "a1"]])
  assert.deepEqual(none.tasks, [], "none of these asked a model")
  // Nothing from anyone and a request for one film: the Director
  const director = asker({ assembly: () => ({ parts: [{ clip: 2, use: "whole", reason: "a" }, { clip: 1, use: "story", reason: "b" }] }) })
  const asked = await decideAssembly({ ...base, ask: director.ask, text: "stitch all of these into one film" })
  assert.deepEqual([asked.source, spineOf(asked), director.tasks], ["director", ["a2", "a1"], ["assembly"]])
  // The Director can't be reached: the default, said plainly
  const silent = await decideAssembly({ ...base, ask: null, text: "stitch all of these into one film" })
  assert.deepEqual([silent.source, spineOf(silent)], ["default", ["a1", "a2", "a3"]])
  // Nothing asked of the order at all: no assembly, and no model call (the reel it always was)
  const plain = asker()
  const reel = await decideAssembly({ ...base, ask: plain.ask, text: "make a 30 second reel with captions" })
  assert.deepEqual([reel.assembly, reel.source, plain.tasks], [null, null, []])
  // The Director never overrules the person: an answer that drops what they fixed is refused
  const wrong = asker({ assembly: () => ({ parts: [{ clip: 1, use: "story", reason: "a" }, { clip: 3, use: "whole", reason: "b" }] }) })
  const kept = await decideAssembly({ ...base, ask: wrong.ask, text: "clip 3 first, and use clip 9 as well" })
  assert.deepEqual([kept.source, spineOf(kept)[0], wrong.tasks], ["person", "a3", ["assembly"]])
})

test("ET-ASM-18: conform's frame: same shape fills, a face is followed, anything else is whole over a blur; the effect is `frame`, never `fit`", async () => {
  const tall = { width: 1080, height: 1920 }
  assert.equal(frameFor({}, { width: 1080, height: 1920 }, tall, false), "fill")
  assert.equal(frameFor({}, { width: 1920, height: 1080 }, tall, true), "subject")
  assert.equal(frameFor({}, { width: 1920, height: 1080 }, tall, false), "blur")
  assert.equal(frameFor({ fit: "fit" }, { width: 1920, height: 1080 }, tall, true), "fit", "the person's choice wins")
  assert.equal(frameFor({ fit: "fill" }, { width: 1920, height: 1080 }, tall, false), "fill")
  // The operation: fill is the absence of the effect (EH-59)
  const cut = apply(s3.project, [{ op: "keep_range", asset: "a2", from: 0, to: 2 * FLICKS }], { index: s3.index }).project
  const clip = cut.sequences[0].clips[0].id
  const framed = apply(cut, [{ op: "set_frame", clip, mode: "blur" }], { index: s3.index }).project
  assert.deepEqual(framed.sequences[0].clips[0].effects, [{ type: "frame", mode: "blur" }])
  assert.deepEqual(apply(framed, [{ op: "set_frame", clip, mode: "fill" }], { index: s3.index }).project, cut, "fill takes it away: the project it was")
  assert.equal(apply(cut, [{ op: "set_frame", clip, mode: "wide" }], { index: s3.index }).applied, false)
  // It is a picture effect: the music's `fit` is untouched, and a framed clip isn't fitted music (EH-56)
  const versions = { engineVersion: "t", runtimeVersion: "t" }
  const plan = compile(framed, s3.index, versions)
  assert.deepEqual(plan.segments[0].node.picture[0].effects, [{ type: "frame", mode: "blur" }])
  assert.deepEqual(compile(cut, s3.index, versions).segments[0].node.picture[0].effects, [], "no new key for a cut that fills")
  assert.equal(JSON.stringify(compile(cut, s3.index, versions)).includes("frame"), false)
  assert.equal(plan.audio.items.every((item) => !item.fit && !item.effects.some((e) => e.type === "fit")), true)
  // The builder draws each: bars in the plate colour; a blurred copy behind the whole picture
  const io = { input: () => "/x/a.mov", tile: () => "/x/t.mov", output: "/x/o.mp4", encoder: [] }
  const graph = (project) => segmentArgs(compile(project, s3.index, versions), compile(project, s3.index, versions).segments[0], io).find((arg) => arg.includes("[p0]") || arg.includes("trim"))
  assert.match(graph(framed), /split\[fa0\]\[fb0\];\[fa0\].*boxblur.*\[fbg0\];\[fb0\]scale=.*force_original_aspect_ratio=decrease.*\[ffg0\];\[fbg0\]\[ffg0\]overlay/)
  assert.match(graph(apply(cut, [{ op: "set_frame", clip, mode: "fit" }], { index: s3.index }).project), new RegExp(`force_original_aspect_ratio=decrease.*pad=.*color=${PLATE}`))
  assert.match(graph(cut), /force_original_aspect_ratio=increase,crop=/)
  assert.equal(frameSteps({ mode: "fit" }, 1080, 1920, 0).length, 2)
  // The recipe uses it: the wide clip in a tall film is blurred, the tall one fills
  const { ask } = asker()
  const made = await planAssembly({ project: s3.project, index: s3.index, ask, brief: { assembly: assemblyOf([{ asset: "a2", use: "whole" }, { asset: "a3", use: "whole" }, { asset: "a2", use: "whole", from: 0, to: FLICKS, fit: "fit" }].slice(0, 2)) } })
  const effects = Object.fromEntries(made.project.sequences[0].clips.filter((c) => c.source).map((c) => [c.source.asset, c.effects.map((e) => `${e.type}${e.mode ? `:${e.mode}` : ""}`)]))
  assert.deepEqual(effects, { a2: ["frame:blur"], a3: ["frame:blur"] }, "both are wide and the film is tall")
  // A part the person set to fill is cropped to the frame as a reel is, with no new effect
  const filled = await planAssembly({ project: s3.project, index: s3.index, ask, brief: { assembly: assemblyOf([{ asset: "a2", use: "whole", fit: "fill" }, { asset: "a3", use: "whole", fit: "fit" }]) } })
  assert.deepEqual(Object.fromEntries(filled.project.sequences[0].clips.filter((c) => c.source).map((c) => [c.source.asset, c.effects.map((e) => `${e.type}:${e.mode}`)])), { a2: ["reframe:fixed"], a3: ["frame:fit"] })
})

test("ET-ASM-19: speech is levelled to the reference part, within 1 LU, each move inside its limit; unmeasured parts are left", async () => {
  const levels = levelsFor([{ id: "ref", lufs: -20 }, { id: "quiet", lufs: -26.4 }, { id: "loud", lufs: -15.1 }, { id: "same", lufs: -20.3 }, { id: "far", lufs: -40 }, { id: "unknown", lufs: null }])
  assert.deepEqual([...levels], [["quiet", 6.4], ["loud", -4.9], ["far", 12]])
  for (const [id, db] of levels) if (id !== "far") assert.ok(Math.abs({ quiet: -26.4, loud: -15.1 }[id] + db - -20) <= 1, `${id} is within 1 LU of the reference`)
  assert.deepEqual([...levelsFor([{ id: "a", lufs: null }, { id: "b", lufs: -20 }])], [], "the first measured part is the reference")
  // The recipe: the longest talking part is the reference; the others move to it
  const { ask } = asker()
  const brief = { assembly: assemblyOf([{ asset: "a2", use: "whole" }, { asset: "a1", use: "story" }, { asset: "a3", use: "whole" }]) }
  const made = await planAssembly({ project: s3.project, index: s3.index, ask, brief, loudness: { a1: -20, a2: -26, a3: -19.8 } })
  const level = (asset) => made.project.sequences[0].clips.filter((c) => c.source?.asset === asset).map((c) => c.effects.find((e) => e.type === "level")?.db ?? null)
  assert.deepEqual([level("a2"), level("a3"), [...new Set(level("a1"))]], [[6], [null], [null]])
  const unmeasured = await planAssembly({ project: s3.project, index: s3.index, ask, brief })
  assert.ok(unmeasured.notes.some((n) => /loudness wasn't measured/.test(n)))
  assert.equal(unmeasured.project.sequences[0].clips.some((c) => c.effects.some((e) => e.type === "level")), false)
})

test("ET-ASM-20: colour is matched toward the reference where the runtime can; without lut3d each part is left as shot, with a note, and the make still plans", async () => {
  const { ask } = asker()
  const brief = { assembly: assemblyOf([{ asset: "a1", use: "story" }, { asset: "a2", use: "whole" }]) }
  const able = await planAssembly({ project: s3.project, index: s3.index, ask, brief, filters: new Set(["lut3d"]) })
  const clips = able.project.sequences[0].clips
  const reference = clips.find((c) => c.source?.asset === "a1").id
  assert.deepEqual(clips.filter((c) => c.source?.asset === "a2").map((c) => c.effects.find((e) => e.type === "grade")?.match), [reference], "the other file is matched to the talking part")
  assert.equal(clips.filter((c) => c.source?.asset === "a1").some((c) => c.effects.some((e) => e.type === "grade")), false, "the reference keeps its own colour")
  for (const filters of [new Set(["scale", "crop"]), null]) {
    const without = await planAssembly({ project: s3.project, index: s3.index, ask, brief, filters })
    assert.equal(without.project.sequences[0].clips.some((c) => c.effects.some((e) => e.type === "grade")), false)
    assert.ok(without.notes.some((n) => /can't match colour.*lut3d/.test(n)), "said plainly")
    assert.deepEqual(plays(without.project, s3.index), ["a1", "a2"], "and the film is the same film")
  }
})

test("ET-ASM-21: a story is kept per part, so a reorder asks the model nothing; one take still asks once", async () => {
  const first = asker()
  const parts = [{ asset: "a1", use: "story" }, { asset: "a2", use: "whole" }, { asset: "a5", use: "story" }]
  const made = await planAssembly({ project: w.project, index: w.index, ask: first.ask, brief: { assembly: assemblyOf(parts) } })
  assert.deepEqual(first.tasks, ["story", "story"], "one story call per talking part, under the reel's own task name, and nothing else")
  assert.deepEqual(Object.keys(made.story.parts).sort(), [storyKey({ asset: "a1" }), storyKey({ asset: "a5" })].sort())
  assert.deepEqual(plays(made.project, w.index), ["a1", "a2", "a5"])
  // The same parts in another order, with the last make's story: no call at all, and the same lines
  const again = asker()
  const reordered = await planAssembly({ project: made.project, index: w.index, ask: again.ask, brief: { assembly: assemblyOf([parts[2], parts[0], parts[1]]), story: made.story } })
  assert.deepEqual(again.tasks, [])
  assert.deepEqual(plays(reordered.project, w.index), ["a5", "a1", "a2"])
  assert.deepEqual(reordered.story, made.story)
  assert.equal(reordered.slots.story, "kept")
  const words = (project) => solve(project, w.index).picture.filter((p) => p.asset === "a1").map((p) => [p.in, p.out])
  assert.deepEqual(words(reordered.project), words(made.project), "the same cut of each part")
  // A new part asks for its own story only
  const more = asker()
  await planAssembly({ project: made.project, index: w.index, ask: more.ask, brief: { assembly: assemblyOf([parts[0], parts[1]]), story: { parts: { [storyKey({ asset: "a1" })]: made.story.parts[storyKey({ asset: "a1" })] } } } })
  assert.deepEqual(more.tasks, [])
  // The Host's rule for keeping a story: one kind is never read as the other
  const last = { brief: { targetDuration: 5, assembly: {} }, story: made.story }
  assert.equal(storyFor(last, { targetDuration: 5, assembly: {} }), made.story)
  assert.equal(storyFor(last, { targetDuration: 5 }), null, "a single take never reads a film's stories")
  assert.equal(storyFor({ brief: { targetDuration: 5 }, story: { hook: null, drop: [] } }, { targetDuration: 5, assembly: {} }), null)
  assert.deepEqual(storyFor({ brief: { targetDuration: 5 }, story: { hook: null, drop: [] } }, { targetDuration: 5 }), { hook: null, drop: [] }, "a record written before TP2 is a single take's, as it was")
})

const recorded = JSON.parse(readFileSync(join(ROOT, "tests", "edit", "pre-tp2-make.golden.json"), "utf8"))

test("ET-ASM-22, ET-TP-REG-01: one file and no assembly makes the same operations as before TP2, and the plan schema is the object it was", async () => {
  // The job recorded before any TP2 code, made again by today's reel recipe from its own recording
  const extra = recorded.answers.find((a) => a.task === "brief_extra")
  const brief = { ...(extra ? JSON.parse(extra.value) : {}), ...recorded.request.brief }
  assert.equal(isAssembly(brief.assembly?.parts), false, "its brief has no order, so the Host takes the reel")
  const made = await planReel({ project: recorded.before, index: recorded.index, asset: recorded.request.asset, ask: replayAsk(recorded.answers.filter((a) => a.task !== "brief_extra")), brief })
  const { head: _h, history: _y, ...before } = recorded.after
  assert.equal(hashProject(made.project), hashProject(before), "the same project, to the hash, as the make that ran before TP2")
  assert.equal(JSON.stringify(made.project).includes('"frame"') || JSON.stringify(made.project).includes('"plan"'), false, "no new key in a single take")
  // One file, any words: no assembly is decided, and no slot is asked
  const one = apply(newProject({ id: "p", name: "One" }), [video("a1", lengthOf(), "talk.mov")], { author: "code" }).project
  const none = asker()
  for (const text of ["make a reel", "put clip 1 first", "make one film from all of these", "clip 1, then clip 1"]) {
    const decided = await decideAssembly({ project: one, index: s3.index, text, ask: none.ask })
    assert.equal(decided.assembly, null, text)
  }
  assert.deepEqual(none.tasks, [])
  // One file can still be reordered by its own words: that is asked for, so it is an assembly of that file's stretches
  const moved = await decideAssembly({ project: one, index: s3.index, text: "start with where I talk about fifty thousand rupees", ask: none.ask })
  assert.deepEqual([moved.assembly.parts.map((p) => p.asset), assemblyProblems(moved.assembly, { project: one, index: s3.index })], [["a1", "a1", "a1"], []])
  // The plan's schema has no field for an order: the Director never chooses one in the plan call (EH-58, EH-64)
  assert.equal(Object.hasOwn(PLAN_SCHEMA.properties.settings.properties, "assembly"), false)
  assert.equal(GATES.includes("QG-15"), false, "a film with no assembly has the 14 gates it had")
})

test("ET-TP-REG-03: a make recorded before TP2 replays to the end: no slot is asked that its recording lacks", async () => {
  const asked = []
  const answers = recorded.answers.filter((a) => a.task !== "brief_extra")
  const replay = replayAsk(answers)
  const ask = async (slot) => (asked.push(slot.task), replay(slot))
  await planReel({ project: recorded.before, index: recorded.index, asset: recorded.request.asset, ask, brief: recorded.request.brief })
  assert.deepEqual(asked, answers.map((a) => a.task), "exactly the slots it recorded, in order")
  assert.deepEqual(asked, ["story", "emphasis"])
  // A slot the recording lacks stops a replay, which is why none may be added to this path
  await assert.rejects(replayAsk(answers)({ task: "assembly" }), /no answer for "assembly"/)
})

test("ET-ASM-23, EH-60a: make twice: every cutaway a make placed is there once, and nothing dead is left behind", async () => {
  const { ask } = asker()
  const brief = { assembly: assemblyOf(order("show clip 2 over clip 1 while I say fifty thousand").parts), captions: "clean" }
  let project = s3.project
  const counts = []
  for (let round = 0; round < 3; round++) {
    const made = await planAssembly({ project, index: s3.index, ask, brief })
    project = made.project
    const clips = project.sequences[0].clips
    const role = new Map(project.sequences[0].tracks.map((t) => [t.id, t.role]))
    const timeline = solve(project, s3.index)
    counts.push({ over: clips.filter((c) => role.get(c.track) === "broll").length, marked: clips.filter((c) => c.plan === true).length, shown: timeline.overlays.filter((o) => !o.block).length, captions: timeline.captions.length, dead: timeline.issues.filter((i) => i.code === "anchor_removed").length })
  }
  assert.deepEqual(counts[0], { over: 1, marked: 1, shown: 1, captions: counts[0].captions, dead: 0 })
  assert.deepEqual(counts[1], counts[0], "the second make shows it once")
  assert.deepEqual(counts[2], counts[0])
  // The person's own B-roll isn't the make's to remove
  const mine = apply(project, [{ op: "place_broll", asset: "a3", at: 2 * FLICKS, duration: FLICKS }], { index: s3.index, author: "person" }).project
  const after = await planAssembly({ project: mine, index: s3.index, ask, brief })
  assert.deepEqual(after.project.sequences[0].clips.filter((c) => c.source?.asset === "a3" && !c.plan).length, 1 + 1, "theirs stays (and a3 is also a part of the order)")
  // EH-60a, the single take: B-roll, cut sounds and angles hung on the old cut's clips went dead and piled up
  const sfx = apply(newProject({ id: "p", name: "Reel" }), [video("a1", lengthOf(), "talk.mov"), video("a2", 10, "street.mov"), sound("x1", 1, "kriya-sfx-whoosh.wav", { rightsNote: "Made by Kriya", facts: { duration: FLICKS, hasAudio: true, peak: FLICKS / 5 } })], { author: "code" }).project
  const reelBrief = { broll: "own", sfx: { cut: "x1" }, angles: true }
  let reel = sfx
  const sizes = []
  for (let round = 0; round < 3; round++) {
    reel = (await planReel({ project: reel, index: s3.index, asset: "a1", ask, brief: reelBrief })).project
    sizes.push([reel.sequences[0].clips.length, solve(reel, s3.index).issues.filter((i) => i.code === "anchor_removed").length])
  }
  assert.deepEqual(sizes[1], sizes[0], "a remake leaves as many clips as a first make")
  assert.deepEqual(sizes[2], [sizes[0][0], 0])
  // What a remake takes out: the rebuilt tracks, and only what hung on them; a person's clip stays
  const sequence = { clips: [{ id: "c1", track: "b" }, { id: "c2", track: "o", at: { clip: "c1", edge: "start" }, createdBy: "agent" }, { id: "c3", track: "o", at: { clip: "c2", edge: "end" }, createdBy: "agent" }, { id: "c4", track: "o", at: { clip: "c1", edge: "start" }, createdBy: "person" }, { id: "c5", track: "o", at: { word: "w1", edge: "start" }, createdBy: "agent" }] }
  assert.deepEqual(remadeClips(sequence, (c) => c.track === "b").map((c) => c.id), ["c1", "c2", "c3"])
})

test("ET-ASM-24: one file as two parts: an edit carried over a remake lands on the half it was made on", async () => {
  const { ask } = asker()
  const halves = order("put clip 2 in the middle of clip 1").parts
  const brief = { assembly: assemblyOf(halves) }
  const made = await planAssembly({ project: s3.project, index: s3.index, ask, brief })
  const timeline = solve(made.project, s3.index)
  const a2At = timeline.picture.find((p) => p.asset === "a2").at
  // The person grades the last clip of the second half
  const target = timeline.picture.filter((p) => p.asset === "a1" && p.at > a2At).at(-1)
  const early = timeline.picture.find((p) => p.asset === "a1" && p.at < a2At)
  const edits = [{ op: "grade", clip: target.clip, saturation: 0 }, { op: "set_assembly", assembly: assemblyOf([{ asset: "a3", use: "whole" }]) }, { op: "describe_asset", asset: "a1", label: "old" }]
  const edited = apply(made.project, [edits[0]], { index: s3.index, author: "person" }).project
  // Remade with the halves the other way round, so "the first a1 clip" and "the same track" both point at the wrong half
  const swapped = { assembly: assemblyOf([halves.find((p) => p.asset === "a1" && p.from !== undefined), halves.find((p) => p.asset === "a2"), halves.find((p) => p.asset === "a1" && p.from === undefined), halves.find((p) => p.asset === "a3")]), story: made.story }
  const remade = await planAssembly({ project: edited, index: s3.index, ask, brief: swapped })
  const ids = remapIds(edited, remade.project, s3.index)
  const now = solve(remade.project, s3.index)
  const landed = now.picture.find((p) => p.clip === ids.get(target.clip))
  assert.deepEqual([landed.asset, landed.in, landed.out], [target.asset, target.in, target.out], "the clip that plays the same stretch of the file")
  assert.notEqual(ids.get(target.clip), ids.get(early.clip))
  const carried = carryEdits(remade, edits, { before: edited, index: s3.index })
  const graded = carried.project.sequences[0].clips.filter((c) => c.effects.some((e) => e.type === "grade" && e.saturation === 0))
  assert.deepEqual(graded.map((c) => c.id), [ids.get(target.clip)], "graded once, on that half")
  // A clip overlapping two new clips equally goes to the one that starts where it did
  const twoWay = (project) => apply(project, [{ op: "keep_range", asset: "a2", from: 0, to: 2 * FLICKS }, { op: "keep_range", asset: "a2", from: 2 * FLICKS, to: 4 * FLICKS }], { index: s3.index }).project
  const before = apply(s3.project, [{ op: "keep_range", asset: "a2", from: FLICKS, to: 3 * FLICKS }], { index: s3.index }).project
  const fresh = twoWay({ ...s3.project, nextId: 50 })
  assert.equal(remapIds(before, fresh, s3.index).get(before.sequences[0].clips[0].id), fresh.sequences[0].clips[0].id)
})

test("ET-ASM-25: set_assembly, describe_asset and what the make itself places are never carried onto a remake", async () => {
  const { ask } = asker()
  const brief = { assembly: assemblyOf(order("clip 3 first, then clip 1, then clip 2").parts) }
  const made = await planAssembly({ project: s3.project, index: s3.index, ask, brief })
  const clip = made.project.sequences[0].clips.find((c) => c.source).id
  const edits = [{ op: "set_assembly", assembly: assemblyOf([{ asset: "a2", use: "whole" }, { asset: "a3", use: "whole" }]) }, { op: "describe_asset", asset: "a1", label: "old name" }, { op: "place_over", asset: "a2", at: 0, duration: FLICKS }, { op: "set_frame", clip, mode: "fit" }, { op: "grade", clip, saturation: 0.5 }]
  assert.deepEqual(replayable(edits, made.project).map((op) => op.op), ["grade"])
  const remade = await planAssembly({ project: made.project, index: s3.index, ask, brief: { ...brief, story: made.story } })
  const carried = carryEdits(remade, edits, { before: made.project, index: s3.index })
  assert.deepEqual(carried.carried.map((op) => op.op), ["grade"])
  assert.equal(carried.project.sequences[0].assembly, undefined, "the old order isn't put back on the new cut")
  assert.equal(carried.project.assets.find((a) => a.id === "a1").label, undefined)
  assert.deepEqual(plays(carried.project, s3.index), ["a3", "a1", "a2"], "the film keeps the order this make was asked for")
})

test("the recipe: parts in the order asked, an over part on its word, a song fitted and ducked, a voice-over as the clock, and What I did says the order", async () => {
  const { ask } = asker()
  const brief = (text, more = {}, at = s3) => ({ assembly: assemblyOf(order(text, at).parts), ...more })
  const film = await planAssembly({ project: s3.project, index: s3.index, ask, brief: brief("clip 3 first, then clip 1, then clip 2", { captions: "clean", grade: "warm" }) })
  assert.deepEqual(plays(film.project, s3.index), ["a3", "a1", "a2"])
  assert.match(film.notes[0], /^The film's order: 1\. clip 3, whole, 2\.0 s; 2\. clip 1, story, [\d.]+ s; 3\. clip 2, whole, 5\.0 s/)
  const timeline = solve(film.project, s3.index)
  assert.ok(timeline.captions.length > 5, "captions across the talking part")
  assert.ok(film.project.sequences[0].clips.filter((c) => c.source && !c.at).every((c) => c.effects.some((e) => e.type === "grade")), "the look over every part")
  assert.equal(film.project.brief.targetDuration, timeline.duration, "with no length asked, the film is as long as its parts")
  assert.equal(film.project.sequences[0].assembly, undefined, "the make writes no storyboard onto the project")
  // In the middle: the talk, the other clip, the rest of the talk
  const middle = await planAssembly({ project: s3.project, index: s3.index, ask, brief: brief("put clip 2 in the middle of clip 1") })
  assert.deepEqual(plays(middle.project, s3.index), ["a1", "a2", "a1", "a3"])
  const cut = solve(middle.project, s3.index)
  const [firstHalf, secondHalf] = [cut.picture.filter((p) => p.asset === "a1" && p.at < cut.picture.find((x) => x.asset === "a2").at), cut.picture.filter((p) => p.asset === "a1" && p.at > cut.picture.find((x) => x.asset === "a2").at)]
  assert.ok(Math.max(...firstHalf.map((p) => p.out)) <= Math.min(...secondHalf.map((p) => p.in)), "no word plays twice, none out of order")
  // Over: on its word, inside its host, for no longer than the sentence
  const over = await planAssembly({ project: s3.project, index: s3.index, ask, brief: brief("show clip 2 over clip 1 while I say fifty thousand") })
  const shown = solve(over.project, s3.index)
  const cutaway = shown.overlays.find((o) => !o.block)
  const fifty = s3.index.words.find((x) => x.text === "fifty")
  const host = shown.picture.find((p) => p.asset === "a1" && fifty.start >= p.in && fifty.end <= p.out)
  assert.equal(cutaway.asset, "a2")
  assert.ok(Math.abs(cutaway.at - (host.at + (fifty.start - host.in))) <= FLICKS / 30, "it starts on the word")
  assert.ok(cutaway.end <= host.end + FLICKS / 30 && cutaway.end - cutaway.at >= FLICKS / 2)
  assert.equal(shown.audio.some((a) => a.asset === "a2"), false, "the voice carries on: the cutaway isn't heard")
  assert.equal(over.project.sequences[0].clips.find((c) => c.source?.asset === "a2").plan, true)
  // A song: fitted, ducked
  const song = await planAssembly({ project: s3.project, index: s3.index, ask, brief: brief("clip 3 first and use the song under everything") })
  const music = song.project.sequences[0].clips.find((c) => c.source?.asset === "a4")
  assert.deepEqual(music.effects.map((e) => e.type).sort(), ["duck", "fade", "fit"])
  // A voice-over is the clock: the film is as long as it, the pictures share it in order, and only it is heard
  const voiced = await planAssembly({ project: w.project, index: w.index, ask, brief: { assembly: assemblyOf([{ asset: "a2", use: "whole" }, { asset: "a3", use: "whole" }, { asset: "a6", use: "sound" }]), captions: "clean" } })
  const told = solve(voiced.project, w.index)
  assert.deepEqual(plays(voiced.project, w.index), ["a2", "a3"])
  assert.ok(told.duration <= 7 * FLICKS + FLICKS / 30, "never longer than the pictures there are")
  const narration = told.audio.find((a) => a.asset === "a6")
  assert.deepEqual([narration.at, narration.effects.find((e) => e.type === "level").db], [0, 0])
  assert.ok(told.audio.filter((a) => a.asset !== "a6").every((a) => a.effects.find((e) => e.type === "level")?.db === -60), "the pictures' own sound is under it")
  assert.ok(told.captions.length > 0 && told.captions.every((c) => c.words.every((word) => word.id.startsWith("a6:"))), "captions follow the narration's words")
  assert.match(voiced.notes[0], /clip 6 as the voice-over, which sets the timing/)
  // A file gone: left out, with a note; the rest is made
  const gone = await planAssembly({ project: s3.project, index: s3.index, ask, offline: ["a2"], brief: brief("clip 3 first, then clip 1, then clip 2") })
  assert.deepEqual(plays(gone.project, s3.index), ["a3", "a1"])
  assert.ok(gone.notes.some((n) => /Left out clip 2: its file isn't where it was/.test(n)))
})

test("QG-15's readings, without a file: order, a missing part, a wrong stretch, an over part outside its host; the hash and the regions", async () => {
  const { ask } = asker()
  const assembly = assemblyOf(order("show clip 2 over clip 1 while I say fifty thousand").parts)
  const made = await planAssembly({ project: s3.project, index: s3.index, ask, brief: { assembly } })
  const judge = (project, asked = assembly) => judgeOrder({ assembly: asked, timeline: solve(project, s3.index), project, index: s3.index }).failures.map((f) => f.kind)
  assert.deepEqual(judge(made.project), [])
  // A swap: the cut plays a3 then a1
  const base = made.project.sequences[0].clips.filter((c) => c.source && c.at === null)
  const swapped = apply(made.project, [{ op: "reorder", clip: base.at(-1).id, after: null }], { index: s3.index }).project
  assert.deepEqual(judge(swapped), ["order"])
  // A missing part
  const missing = apply(made.project, [{ op: "ripple_delete", clip: base.at(-1).id }], { index: s3.index }).project
  assert.deepEqual(judge(missing), ["missing_part"])
  // A wrong stretch: asked for the first second of clip 3, the cut plays all of it
  const narrow = assemblyOf(assembly.parts.map((p) => (p.asset === "a3" ? { ...p, from: 0, to: FLICKS / 2 } : p)))
  assert.deepEqual(judge(made.project, narrow), ["outside_stretch"])
  // An over part with no clip, and one outside its host
  const overClip = made.project.sequences[0].clips.find((c) => c.plan)
  assert.deepEqual(judge(apply(made.project, [{ op: "ripple_delete", clip: overClip.id }], { index: s3.index }).project), ["missing_part"])
  const last = solve(made.project, s3.index).picture.at(-1)
  const moved = structuredClone(made.project)
  moved.sequences[0].clips.find((c) => c.plan).at = last.at + FLICKS / 4
  assert.deepEqual(judge(moved), ["over_outside_host"])
  // A part the make left out with a note isn't counted against it
  assert.deepEqual(judgeOrder({ assembly, timeline: solve(missing, s3.index), project: missing, index: s3.index, left: [assembly.parts.find((p) => p.asset === "a3").id] }).failures, [])
  // The comparison: the same picture brighter and flatter is the same; another picture isn't; black is only like black
  const picture = (seed) => Uint8Array.from({ length: 32 * 18 }, (_, i) => (i * seed * 37 + ((i * i) % 97) * 3) % 256)
  assert.ok(thumbDistance(picture(3), picture(3).map((v) => Math.min(255, Math.round(v * 0.7 + 30)))) < 0.01)
  assert.ok(thumbDistance(picture(3), picture(11)) > 0.5)
  assert.equal(thumbDistance(new Uint8Array(576).fill(16), new Uint8Array(576).fill(18)), 0)
  assert.equal(thumbDistance(new Uint8Array(576).fill(16), picture(3)), 1)
  assert.equal(thumbDistance(null, picture(3)), 2)
  // The same picture, in source and in output
  assert.deepEqual(sameRegion({ source: { width: 1920, height: 1080 }, output: { width: 1080, height: 1920 }, mode: "fill" }), { source: { x: 657, y: 0, w: 606, h: 1080 }, output: { x: 0, y: 0, w: 1080, h: 1920 } })
  assert.deepEqual(sameRegion({ source: { width: 1920, height: 1080 }, output: { width: 1080, height: 1920 }, mode: "blur" }), { source: { x: 0, y: 0, w: 1920, h: 1080 }, output: { x: 0, y: 657, w: 1080, h: 606 } })
})

test("three ways in, one assembly: a storyboard, mentions and words for the same order are the same object in essence", async () => {
  const board = { version: 1, parts: [{ id: "p1", asset: "a3", use: "whole", why: "storyboard" }, { id: "p2", asset: "a2", use: "whole", why: "storyboard" }] }
  const quiet = apply(newProject({ id: "p", name: "Film" }), [video("a1", 3, "walk-in.mov"), video("a2", 5, "beach final.mov"), video("a3", 2, "outro.mov")], { author: "code" }).project
  const base = { project: quiet, index: {} }
  const drawn = await decideAssembly({ ...base, text: "", storyboard: { version: 1, parts: [{ id: "p1", asset: "a3", use: "whole", why: "storyboard" }, { id: "p2", asset: "a1", use: "whole", why: "storyboard" }, { id: "p3", asset: "a2", use: "whole", why: "storyboard" }] } })
  const pointed = await decideAssembly({ ...base, text: "⟦1⟧ first, then ⟦2⟧, then ⟦3⟧", mentions: [{ asset: "a3" }, { asset: "a1" }, { asset: "a2" }] })
  const worded = await decideAssembly({ ...base, text: "clip 3 first, then clip 1, then clip 2" })
  assert.equal(sameAssembly(drawn.assembly, pointed.assembly), true)
  assert.equal(sameAssembly(pointed.assembly, worded.assembly), true)
  assert.deepEqual(essence(worded.assembly.parts).map((p) => [p.asset, p.use]), [["a3", "whole"], ["a1", "whole"], ["a2", "whole"]])
  assert.deepEqual([drawn.source, pointed.source, worded.source], ["storyboard", "person", "person"])
  assert.equal(sameAssembly(board, worded.assembly), false)
})
