import assert from "node:assert/strict"
import { test } from "node:test"

import { mapBox } from "../src/edit/core/faces.js"
import { safeZoneFor } from "../src/edit/core/layout.js"
import { apply } from "../src/edit/core/ops.js"
import { solve } from "../src/edit/core/solver.js"
import { createAsk } from "../src/edit/director/ask.js"
import { briefOf, formatAsked, formatIn, pitchGaps, planCut, planProblems, settingsIn, trimsIn } from "../src/edit/director/plan.js"
import { planReel } from "../src/edit/recipes/reel.js"
import { cleanRefs, takeFrom } from "../src/edit/engine/reference.js"
import { flagWords } from "../src/edit/index/layers/retakes.js"
import { createGovernor } from "../src/edit/loop/governor.js"
import { makeIndex, makeProject, ms } from "./edit/fixture.js"
import { indexOf, lengthOf } from "./edit/script.js"

// From use (2026-11-09): a plan approved for 16:9 came out 9:16; captions sat on the face;
// a reference should give only what the person took it for.

const FLICKS = 705_600_000

test("the format is read from the person's words, a ratio over a word, turned-away mentions skipped", () => {
  const cases = {
    "make a 16:9 aspect ratio video": "16:9",
    "16x9 please": "16:9",
    "landscape, 16 by 9": "16:9",
    "a reel in 16:9": "16:9",
    "make it 16:9 not 9:16": "16:9",
    "change it from 9:16 to 16:9": "16:9",
    "I asked 16:9 but it made 9:16": "16:9",
    "for youtube": "16:9",
    "youtube shorts": "9:16",
    "a vertical reel": "9:16",
    "square post": "1:1",
    "4:5 for the feed": "4:5",
    "remove the first 5 seconds": null,
    "make the story punchier": null,
  }
  for (const [text, format] of Object.entries(cases)) assert.equal(formatIn(text), format, text)
  // This message, then the person's earlier words (not Kriya's), then the plan being revised
  assert.equal(formatAsked("add calm music", [{ who: "you", text: "make it 16:9" }, { who: "kriya", text: "a vertical reel" }], { settings: { format: "9:16" } }), "16:9")
  assert.equal(formatAsked("add calm music", [], { settings: { format: "1:1" } }), "1:1")
  assert.equal(formatAsked("add calm music", [], null), null)
})

function talk() {
  const index = indexOf()
  const facts = { width: 1080, height: 1920, hasAudio: true, duration: Math.round(lengthOf() * FLICKS), vfr: false, fps: { n: 30, d: 1 }, color: { primaries: "bt709", transfer: "bt709", range: "tv", tagged: true, hdr: false } }
  const base = apply(makeProject(), [], { author: "code" }).project
  const project = apply({ ...base, assets: [{ id: "a1", kind: "video", fingerprint: "f", path: "take.mov", linked: true, rights: "own", facts }] }, [{ op: "keep_range", asset: "a1", from: 0, to: facts.duration }], { author: "person", index }).project
  return { index, project }
}

test("a plan for 16:9 is made in 16:9 even when the model leaves the format out or gets it wrong", async () => {
  const { index, project } = talk()
  const replies = [
    { say: "A vertical reel with captions.", steps: ["Captions"], settings: { captions: "clean" } },
    { say: "A vertical reel.", steps: ["Reframe"], settings: { format: "9:16", captions: "clean" } },
    { say: "Calmer now.", steps: ["Calm music"], settings: { music: "calm" } },
  ]
  let n = 0
  const asked = []
  const send = async (body) => (asked.push(body), { choices: [{ message: { content: JSON.stringify(replies[n++]) } }], usage: { completion_tokens: 40 } })
  const ask = createAsk({ governor: createGovernor({ send, windowMs: 10 }), record() {} })
  const left = await planCut({ ask, project, index, text: "edit this raw video into a 16:9 film with captions", choices: { format: "9:16" } })
  assert.equal(left.settings.format, "16:9", "left out: the person's words, not the panel's default")
  assert.equal(briefOf(left.settings).format, "16:9", "and the approved brief carries it")
  assert.match(asked[0].messages.at(-1).content, /wants the 16:9 format/, "the model is told, so its pitch agrees")
  const wrong = await planCut({ ask, project, index, text: "16:9 please, for YouTube" })
  assert.equal(wrong.settings.format, "16:9", "a wrong format from the model is overruled")
  const revised = await planCut({ ask, project, index, text: "make the music calmer", previous: left })
  assert.equal(revised.settings.format, "16:9", "a revision keeps the format the person asked for")
})

test("captions clear the face as the render draws it, between face samples, in a new frame shape", () => {
  const index = makeIndex()
  const w = (n, edge = "start") => ({ word: `a1:w${n}`, edge })
  // A vertical take (1080×1920) made into a 16:9 film, after an earlier 9:16 export
  const project = apply(makeProject(), [{ op: "set_format", width: 1920, height: 1080 }, { op: "keep_range", asset: "a1", from: w(0), to: w(49, "end") }, { op: "caption_style", look: "bold", words: ["a1:w30", "a1:w31"] }], { index, author: "agent" }).project
  project.deliverables = [{ id: "d0", preset: "reel-9x16", size: { width: 1080, height: 1920 } }]
  assert.deepEqual(safeZoneFor(project), {}, "a 9:16 export's margins don't squeeze the 16:9 frame")
  const word = index.words.find((x) => x.id === "a1:w31")
  // One sample, half a second after the caption: faces are sampled once a second
  const face = { asset: "a1", shot: null, t: word.end + ms(500), box: { x: 340, y: 900, w: 400, h: 400 } }
  const timeline = solve(project, { ...index, faces: [face] })
  const caption = timeline.captions[0]
  assert.ok(caption.placement, "placed")
  const onScreen = mapBox(face.box, {}, { width: 1080, height: 1920 }, project.canvas, project.canvas, face.t)
  const overlaps = (a, b) => a.y < b.y + b.h && b.y < a.y + a.h
  assert.equal(overlaps(caption.placement, onScreen), false, `caption at ${caption.placement.y}, face ${onScreen.y} to ${onScreen.y + onScreen.h}`)
})

test("references: each gives only what the person took it for", () => {
  assert.deepEqual(cleanRefs(["r1", { id: "r2", aspect: "sound" }, { id: "r3", aspect: "made-up" }, { id: "../x" }, 5, "r1"]), [
    { id: "r1", aspect: "all" },
    { id: "r2", aspect: "sound" },
    { id: "r3", aspect: "all" },
  ])
  const video = { kind: "video", pace: { every: 1.2, shots: 30 }, captions: true, colour: { grade: { temperature: 5200 }, words: ["warm"] }, music: { bpm: 120, mood: "upbeat", lufs: -9 }, lines: ["Colour: warm", "Pace: 1.2 s", "Captions: yes", "Music: 120 bpm"], parts: { colour: "Colour: warm", editing: "Pace: 1.2 s", graphics: "Captions: yes", sound: "Music: 120 bpm" } }
  const sound = takeFrom(video, "sound")
  assert.deepEqual([sound.music?.bpm, sound.pace, sound.colour, sound.captions, sound.lines], [120, undefined, undefined, undefined, ["Music: 120 bpm"]], "its song, nothing else")
  const editing = takeFrom(video, "editing")
  assert.deepEqual([editing.pace?.every, editing.music, editing.lines], [1.2, undefined, ["Pace: 1.2 s"]])
  assert.deepEqual(Object.keys(takeFrom(video, "colour")).sort(), ["colour", "kind", "lines"])
  assert.equal(takeFrom(video, "graphics").captions, true)
  // Everything, as before: a cut video's soundtrack is usually speech, so its music isn't used
  const all = takeFrom(video, "all")
  assert.deepEqual([all.pace?.every, all.colour?.words[0], all.captions, all.music], [1.2, "warm", true, undefined])
  assert.equal(takeFrom({ kind: "audio", music: { bpm: 90, mood: "warm" }, lines: ["Music"], parts: { sound: "Music" } }, "all").music.bpm, 90)
  assert.deepEqual(takeFrom({ kind: "image", colour: { grade: {}, words: [] }, lines: ["Colour"], parts: { colour: "Colour" } }, "sound").lines, [], "an image has no sound to give")
  // An analysis kept from before aspects: whole, for everything
  assert.deepEqual(takeFrom({ kind: "video", lines: ["Colour: warm"], colour: { grade: {}, words: ["warm"] } }, "all").lines, ["Colour: warm"])
})

// The person's own session (journal, 2026-11-09): the pitch promised a cold open, a riser, a
// cinematic grade, captions, music, whooshes, denoise and 25 s; the settings held the format and
// a hook; Approve made that, so the cut looked like the original
const PITCH = "I'll open cold on your strongest line from the middle in black and white for about 4 seconds, then a riser drops us into the story on your hook line. Cool, cinematic grade with a vignette in 16:9, clean captions, warm low music, a whoosh on every cut and the background noise pulled off your voice. Fillers, restarts and long pauses go, and I'll punch in on 3-4 key words. Everything after 25 seconds is cut, transcript included, so the whole thing lands at 25 seconds max."
const ASKED = "Captions: clean, simple captions.\nLength: the strongest remove the video after the 25 seconds upto 25 only and the transcript too.\nTell me your plan before you make it.\ni also need the bestsound effectes"

test("what the pitch promises is what's made: code fills the settings the model left out", async () => {
  const { index, project } = talk()
  const reply = { say: PITCH, steps: ["Cold open", "Riser", "Trim to 25 seconds max"], settings: { format: "16:9", hook: index.sentences[0].id, titles: false } }
  assert.equal(pitchGaps(reply).length, 9, "nine promises the settings didn't make")
  const send = async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }], usage: { completion_tokens: 400 } })
  const ask = createAsk({ governor: createGovernor({ send, windowMs: 10 }), record() {} })
  const plan = await planCut({ ask, project, index, text: ASKED })
  const brief = briefOf(plan.settings)
  assert.deepEqual(
    { format: brief.format, seconds: brief.seconds, captions: brief.captions, grade: brief.grade, music: brief.music, cleanVoice: brief.cleanVoice, cutSound: brief.cutSound, introSound: brief.introSound, punches: brief.punches },
    { format: "16:9", seconds: 25, captions: "clean", grade: "cinematic", music: "generated:warm", cleanVoice: true, cutSound: "whoosh", introSound: "riser", punches: 3 },
  )
  assert.ok(brief.coldOpen, "a cold open chosen by code")
  assert.deepEqual(planProblems({ coldOpen: brief.coldOpen }, index), [], "and a valid one: one take, forward, 8 s at most")
  assert.deepEqual(pitchGaps(plan), [], "nothing promised is left out")
})

test("the person's words decide, a 'no' included; a split decimal isn't a stutter", () => {
  assert.deepEqual(settingsIn("no music, no captions, just clean the background noise"), { music: "none", captions: "none", cleanVoice: true })
  assert.deepEqual(settingsIn(ASKED), { captions: "clean", cutSound: "whoosh", seconds: 25 })
  const words = ["with", "opus", "5", ".5", "so", "I", "I", "think"].map((text, i) => ({ text, start: i * 1000, end: i * 1000 + 900, conf: 0.9 }))
  const flags = flagWords(words)
  assert.deepEqual(flags[2], [], "'5' then '.5' is 4.5 heard in two, and stays (cutting it is a cut inside a word, QG-05)")
  assert.deepEqual(flags[5], ["stutter"], "a real repeat is still a stutter")
})

test("trims in plain words become exact stretches of the take; 'every cut' trims nothing", () => {
  const D = 60 * FLICKS
  const cases = {
    "remove the video after the 25 seconds upto 25 only": [{ from: 25, to: 60 }],
    "Removethe vidoe form 25 secods": [{ from: 25, to: 60 }],
    "trim the video from 0:05 to 0:20": [{ from: 0, to: 5 }, { from: 20, to: 60 }],
    "keep only 10 to 40 seconds": [{ from: 0, to: 10 }, { from: 40, to: 60 }],
    "cut 0:05 to 0:09 and 0:30 to 0:35": [{ from: 5, to: 9 }, { from: 30, to: 35 }],
    "remove the first 3 seconds": [{ from: 0, to: 3 }],
    "delete the last 5 seconds": [{ from: 55, to: 60 }],
    "remove everything before 0:04": [{ from: 0, to: 4 }],
    "remove everything after 14.6 seconds. Then add music": [{ from: 14.6, to: 60 }],
    "a whoosh on every cut, 30 seconds long": [],
    "open cold at 0:12 to 0:16": [],
  }
  for (const [text, cuts] of Object.entries(cases)) assert.deepEqual(trimsIn(text, D), cuts, text)
})

test("an approved trim is cut between words: nothing after it plays, and the plan shows it", async () => {
  const { index, project } = talk()
  const words = index.words
  const half = (words[0].start + words.at(-1).end) / 2 / FLICKS
  const fallback = async ({ fallback }) => ({ value: fallback(), source: "default", calls: 0 })
  const plan = await planCut({ ask: fallback, project, index, text: `remove everything after ${half.toFixed(1)} seconds` })
  const cuts = briefOf(plan.settings).cuts
  assert.equal(cuts.length, 1)
  assert.equal(cuts[0].from, Math.round(half * 10) / 10)
  const brief = { ...briefOf(plan.settings), cuts: cuts.map((c) => ({ from: Math.round(c.from * FLICKS), to: Math.round(c.to * FLICKS) })) }
  const made = await planReel({ project, index, asset: "a1", ask: fallback, brief })
  const after = apply(project, made.ops, { author: "agent", index })
  assert.deepEqual(after.diagnostics, [])
  const t = solve(after.project, index)
  const playing = t.picture.filter((p) => !p.hold)
  const lastOut = Math.max(...playing.map((p) => p.out))
  const boundary = cuts[0].from * FLICKS
  const straddler = words.find((w) => w.start < boundary && w.end > boundary)
  // The last word kept is the one whose middle is before the trim; a word isn't split
  const limit = straddler && (straddler.start + straddler.end) / 2 < boundary ? straddler.end : boundary
  assert.ok(lastOut <= limit + Math.round(0.3 * FLICKS), `plays to ${lastOut / FLICKS} s, trim at ${boundary / FLICKS} s`)
  assert.ok(made.notes.some((n) => /^Trimmed /.test(n)), "the note says what was trimmed")
})

test("without the model, only the person's words and choices are made: the fallback's sentence promises nothing", async () => {
  const { index, project } = talk()
  const fallback = async ({ fallback }) => ({ value: fallback(), source: "default", calls: 0 })
  const plan = await planCut({ ask: fallback, project, index, text: "Make it 16:9 with a cinematic grade and warm music." })
  const brief = briefOf(plan.settings)
  assert.deepEqual([brief.format, brief.grade, brief.music, brief.captions], ["16:9", "cinematic", "generated:warm", undefined])
})

test("the final cut: finished films listed newest first, only from exports, current or not, never a path from the browser", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { createJobs } = await import("../src/edit/host/jobs.js")
  const folder = mkdtempSync(join(tmpdir(), "kh-final-"))
  mkdirSync(join(folder, "exports"))
  for (const name of ["a-draft.mp4", "b-master.mp4"]) writeFileSync(join(folder, "exports", name), "x")
  writeFileSync(join(folder, "elsewhere.mp4"), "x")
  const rows = [
    { id: 1, kind: "render", status: "done", dispatch: join(folder, "exports", "a-draft.mp4"), project_version: "v1", request: JSON.stringify({ quality: "draft" }), finished_at: "2026-11-09T10:00:00Z" },
    { id: 2, kind: "make", status: "done", dispatch: JSON.stringify({ file: join(folder, "exports", "b-master.mp4"), head: "v2", verdict: "delivered" }), finished_at: "2026-11-09T10:05:00Z" },
    { id: 3, kind: "render", status: "done", dispatch: join(folder, "elsewhere.mp4"), project_version: "v2", request: "{}" },
    { id: 4, kind: "render", status: "done", dispatch: join(folder, "exports", "gone.mp4"), project_version: "v2", request: "{}" },
    { id: 5, kind: "index", status: "done", dispatch: "{}" },
    { id: 6, kind: "render", status: "done", dispatch: join(folder, "exports", "a-draft.mp4"), project_version: "v2", request: JSON.stringify({ quality: "draft" }), finished_at: "2026-11-09T10:09:00Z" },
  ]
  const state = { id: "p", folder, log: { head: "v2" }, journal: { jobs: (status) => rows.filter((r) => !status || r.status === status) } }
  const jobs = createJobs({ projects: {}, emit() {}, log() {} })
  assert.deepEqual(jobs.renders(state).map((r) => [r.job, r.quality, r.name, r.current, r.verdict]), [
    [6, "draft", "a-draft.mp4", true, null],
    [2, "master", "b-master.mp4", true, "delivered"],
  ], "outside exports or deleted: not listed; one file twice: once, its newest job")
  assert.equal(jobs.renderFile(state, 2), join(folder, "exports", "b-master.mp4"))
  assert.equal(jobs.renderFile(state, 3), null)
})
