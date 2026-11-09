import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { apply } from "../src/edit/core/ops.js"
import { newProject } from "../src/edit/core/project.js"
import { solve } from "../src/edit/core/solver.js"
import { createAsk } from "../src/edit/director/ask.js"
import { briefOf, planCut, planProblems } from "../src/edit/director/plan.js"
import { timesIn, timesView } from "../src/edit/director/revise.js"
import { gradeFromStats } from "../src/edit/engine/reference.js"
import { SFX, writeSfx } from "../src/edit/engine/sfx.js"
import { createGovernor } from "../src/edit/loop/governor.js"
import { indexOf, lengthOf } from "./edit/script.js"

// The Director's plan, the cold open, sound design and references (2026-11-09, from use):
// "remove the video from 25 seconds" failed on a typo; a cold open in black and white; a
// plan the person approves or changes before anything is made.

const FLICKS = 705_600_000
const at = (s) => Math.round(s * FLICKS)

function talk() {
  const index = indexOf()
  const facts = { width: 1920, height: 1080, hasAudio: true, duration: Math.round(lengthOf() * FLICKS), vfr: false, fps: { n: 30, d: 1 }, color: { primaries: "bt709", transfer: "bt709", range: "tv", tagged: true, hdr: false } }
  const base = apply(newProject({ id: "p", name: "Talk" }), [{ op: "add_asset", id: "a1", kind: "video", fingerprint: "f", path: "take.mov", linked: true, rights: "own", facts }], { author: "code" }).project
  const project = apply(base, [{ op: "keep_range", asset: "a1", from: 0, to: facts.duration }], { author: "person", index }).project
  return { index, project, facts }
}

test("times as people type them: typos, 'from 25 s' to the end, 'the last 5 seconds', 'before 4 s'", () => {
  const duration = at(29)
  const seen = (text) => timesIn(text, { duration }).map((t) => [t.at / FLICKS, t.to === undefined ? null : t.to / FLICKS])
  assert.deepEqual(seen("removethe vidoe form 25 secods"), [[25, 29]], "the person's own words, typos and all")
  assert.deepEqual(seen("remove after 25s"), [[25, 29]])
  assert.deepEqual(seen("cut the last 5 seconds"), [[24, 29]])
  assert.deepEqual(seen("the first 3 sec"), [[0, 3]])
  assert.deepEqual(seen("everything before 4s"), [[0, 4]])
  assert.deepEqual(seen("what's at 12 secnds"), [[12, null]])
  assert.deepEqual(seen("make it 3 times better"), [])
})

test("'remove from 25 seconds' becomes an exact removal that ends the cut at 25 s", () => {
  const { index, project } = talk()
  const view = timesView("remove the video from 25 seconds", project, index)
  const removal = JSON.parse(/To take it out exactly: (\{[^}]+\})/.exec(view)[1])
  assert.equal(removal.op, "remove_range")
  const after = apply(project, [removal], { author: "agent", index })
  assert.deepEqual(after.diagnostics, [])
  // 25 s falls inside "total." (24.70 to 25.10 s): the cut finishes the word rather than chop it
  const end = solve(after.project, index).duration
  const word = index.words.find((w) => w.start <= at(25) && w.end >= at(25))
  assert.ok(end >= at(25) && end <= word.end + at(0.04), `${end / FLICKS} s`)
})

test("a cold open plays a later moment first, in black and white, and captions stay on the moment itself", () => {
  const { index, project } = talk()
  const w = index.words
  const made = apply(project, [{ op: "cold_open", asset: "a1", from: { word: w[20].id, edge: "start" }, to: { word: w[25].id, edge: "end" }, mono: true }, { op: "caption_style", look: "clean", words: [w[20].id, w[21].id] }], { author: "agent", index })
  assert.deepEqual(made.diagnostics, [])
  const { picture, captions } = solve(made.project, index)
  assert.equal(picture[0].echo, true, "the teaser comes first")
  assert.ok(picture[0].effects.some((e) => e.type === "grade" && e.saturation === 0), "in black and white")
  assert.ok(captions[0].at >= picture[0].end, "the caption is on the story's moment, not the teaser")
})

test("a plan's settings are checked by code and become the exact brief an approval makes", () => {
  const { index } = talk()
  const s0 = index.sentences[3].id
  const w = index.words
  assert.deepEqual(planProblems({ hook: s0, coldOpen: { from: w[20].id, to: w[25].id } }, index), [])
  assert.match(planProblems({ hook: "a1:s999" }, index)[0], /isn't a sentence id/)
  assert.match(planProblems({ coldOpen: { from: w[25].id, to: w[20].id } }, index)[0], /runs forward/)
  assert.match(planProblems({ coldOpen: { from: w[0].id, to: w.at(-1).id } }, index)[0], /8 seconds/)
  assert.deepEqual(briefOf({ format: "16:9", seconds: 30, captions: "none", grade: "cinematic", music: "warm", cleanVoice: true, hook: s0, coldOpen: { from: w[20].id, to: w[25].id, mono: true }, cutSound: "whoosh", introSound: "riser", punches: 3 }), { format: "16:9", seconds: 30, grade: "cinematic", music: "generated:warm", cleanVoice: true, hook: s0, coldOpen: { from: w[20].id, to: w[25].id, mono: true }, cutSound: "whoosh", introSound: "riser", punches: 3 })
  assert.deepEqual(briefOf({ captions: "none", grade: "natural", music: "none", cutSound: "none" }), {}, "'none' asks for nothing")
})

test("the Director pitches a plan, revises it on a change of mind, and an invalid id is sent back once", async () => {
  const { index, project } = talk()
  const w = index.words
  const asked = []
  let n = 0
  const plans = [
    { say: "Open cold on the price, then the story.", steps: ["Cold open on the cost line"], settings: { format: "9:16", coldOpen: { from: "a1:w9999", to: w[25].id }, captions: "karaoke" } },
    { say: "Open cold on the price, then the story.", steps: ["Cold open on the cost line", "Karaoke captions"], settings: { format: "9:16", coldOpen: { from: w[20].id, to: w[25].id, mono: true }, captions: "karaoke", cutSound: "whoosh", introSound: "riser" } },
    { say: "Same plan, landscape and calmer.", steps: ["Landscape", "Calm music"], settings: { format: "16:9", coldOpen: { from: w[20].id, to: w[25].id, mono: true }, captions: "clean", music: "calm" } },
  ]
  const send = async (body) => {
    asked.push(body)
    return { choices: [{ message: { content: JSON.stringify(plans[n++]) } }], usage: { completion_tokens: 50 } }
  }
  const ask = createAsk({ governor: createGovernor({ send, windowMs: 10 }), record() {} })
  const first = await planCut({ ask, project, index, text: "make it stunning: start with the price in black and white" })
  assert.equal(first.source, "repaired", "the unknown word id went back once")
  assert.equal(first.settings.coldOpen.from, w[20].id)
  assert.equal(briefOf(first.settings).cutSound, "whoosh")
  const second = await planCut({ ask, project, index, text: "make it landscape and calmer", previous: first })
  assert.match(asked.at(-1).messages[1].content, /Your previous plan/, "the revision carries the plan it changes")
  assert.equal(second.settings.format, "16:9")
  assert.equal(briefOf(second.settings).music, "generated:calm")
})

test("a reference's colour becomes a tasteful grade and plain words", () => {
  const warm = gradeFromStats({ YAVG: 120, UAVG: 110, VAVG: 150, SATAVG: 45, YLOW: 20, YHIGH: 230 })
  assert.deepEqual(warm.words.slice(0, 2), ["warm", "saturated"])
  assert.ok(warm.grade.temperature < 6500 && warm.grade.temperature >= 4200)
  const cool = gradeFromStats({ YAVG: 70, UAVG: 140, VAVG: 120, SATAVG: 18, YLOW: 40, YHIGH: 180 })
  assert.deepEqual(cool.words, ["cool", "muted", "soft contrast", "dark"])
  assert.ok(cool.grade.temperature > 6500 && cool.grade.saturation >= 0.75, "kept within range")
})

test("sound effects are written by code and say where their peak is", () => {
  const dir = mkdtempSync(join(tmpdir(), "ksfx-"))
  for (const kind of Object.keys(SFX)) assert.equal(writeSfx(join(dir, `${kind}.wav`), kind).peak, Math.round(SFX[kind].peak * FLICKS), kind)
  assert.throws(() => writeSfx(join(dir, "x.wav"), "explosion"), /no "explosion"/)
})

test("a speed ramp eases up to its peak and back in five steps that join exactly, sound and picture", () => {
  const { index, project } = talk()
  const clip = project.sequences[0].clips[0].id
  const before = solve(project, index).duration
  const up = apply(project, [{ op: "speed_ramp", clip, from: at(4), to: at(8), peak: { n: 2, d: 1 } }], { author: "agent", index })
  assert.deepEqual(up.diagnostics, [])
  const pieces = solve(up.project, index).picture
  assert.deepEqual(pieces.map((p) => p.speed.n / p.speed.d), [1, 1.4, 1.8, 2, 1.8, 1.4, 1])
  for (let i = 1; i < pieces.length; i++) assert.equal(pieces[i].in, pieces[i - 1].out, "each step starts where the last ended: no repeat, no gap")
  assert.ok(solve(up.project, index).duration < before - at(1.4), "four seconds play in about two and a half")
  const slow = apply(project, [{ op: "speed_ramp", clip, from: at(4), to: at(6), peak: { n: 1, d: 2 } }], { author: "agent", index })
  assert.ok(solve(slow.project, index).duration > before + at(1), "two seconds of eased slow motion play in about three")
  assert.equal(apply(project, [{ op: "speed_ramp", clip, from: at(4), to: at(6), peak: { n: 8, d: 1 } }], { author: "agent", index }).diagnostics[0].code, "bad_value")
})

test("the plan's new abilities become the brief: angles, B-roll from the person's clips, title cards, ramps", () => {
  assert.deepEqual(briefOf({ angles: true, broll: "own", titles: true, ramps: true }), { angles: true, broll: "own", titles: true, ramps: true })
  assert.deepEqual(briefOf({ angles: false, broll: "none", titles: false, ramps: false }), {})
})
