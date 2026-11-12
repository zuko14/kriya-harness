import assert from "node:assert/strict"
import { test } from "node:test"

import { apply } from "../src/edit/core/ops.js"
import { newProject } from "../src/edit/core/project.js"
import { createAsk } from "../src/edit/director/ask.js"
import { fieldsOf, grounded, MAX_QUESTIONS, readIntent, tidyIntent } from "../src/edit/director/intent.js"
import { PLAN_SCHEMA, planCut } from "../src/edit/director/plan.js"
import { consoleSchema, revise } from "../src/edit/director/revise.js"
import { createGovernor } from "../src/edit/loop/governor.js"
import { answerOnBrief, understoodLine } from "../studio/src/intent.js"
import { indexOf, lengthOf } from "./edit/script.js"

// TP4 (ASSEMBLY_AND_INTENT §7, TOP_TIER_PLAN §5): the intent frame's evidence check, "Not in this
// cut", questions, the same request in four languages, model calls per message, and the switch off.
// A scripted model through the real ask and Governor: no model is called.

const FLICKS = 705_600_000
const fields = fieldsOf(PLAN_SCHEMA.properties.settings)

function talk() {
  const index = indexOf()
  const facts = { width: 1920, height: 1080, hasAudio: true, duration: Math.round(lengthOf() * FLICKS), vfr: false, fps: { n: 30, d: 1 }, color: { primaries: "bt709", transfer: "bt709", range: "tv", tagged: true, hdr: false } }
  const base = apply(newProject({ id: "p", name: "Talk" }), [{ op: "add_asset", id: "a1", kind: "video", fingerprint: "f", path: "take.mov", linked: true, rights: "own", facts }], { author: "code" }).project
  return { index, project: apply(base, [{ op: "keep_range", asset: "a1", from: 0, to: facts.duration }], { author: "person", index }).project }
}
/** The real ask and Governor over a scripted model; `bodies` is every request that reached the model. */
function scripted(answers) {
  const bodies = []
  let n = 0
  const send = async (body) => {
    bodies.push(body)
    const next = answers[Math.min(n++, answers.length - 1)]
    return { choices: [{ message: { content: JSON.stringify(typeof next === "function" ? next(body) : next) } }], usage: { completion_tokens: 50 } }
  }
  return { ask: createAsk({ governor: createGovernor({ send, windowMs: 10 }), record() {} }), bodies }
}
const plan = (settings, intent) => ({ say: "A tight cut.", steps: ["Cut it tight"], settings: { format: "9:16", ...settings }, ...(intent ? { intent } : {}) })

test("ET-NL-01, -02, -03: a field is kept when its words are in the message, dropped when not, and its numbers must be in them", () => {
  const message = "Make it 60 seconds, karaoke captions please"
  const read = readIntent(
    {
      understood: [
        { field: "seconds", value: 60, evidence: "60 seconds" },
        { field: "captions", value: "karaoke", evidence: "Karaoke  captions" }, // case and spacing aside, literal
        { field: "music", value: "upbeat", evidence: "upbeat music" }, // not in the message
        { field: "punches", value: 4, evidence: "Make it" }, // literal, but its number isn't in it
        { field: "grade", value: "noir", evidence: "karaoke" }, // a value the render can't make
      ],
      cannot: [],
      questions: [],
    },
    { message, fields },
  )
  assert.deepEqual(read.understood.map((u) => [u.field, u.value, u.by]), [["seconds", 60, "model"], ["captions", "karaoke", "model"]])
  assert.deepEqual(read.dropped.map((d) => d.field), ["music", "punches", "grade"])
  assert.deepEqual(read.apply, { seconds: 60, captions: "karaoke" })
  assert.equal(grounded("60", "make it 600 seconds", 60), false, "60 isn't the 60 in 600")
  assert.equal(grounded("౬౦ సెకన్లు", "దీన్ని ౬౦ సెకన్లు చేయి", 60), true, "Telugu digits are the number they write")
  assert.equal(grounded("६० सेकंड", "इसे ६० सेकंड का बनाओ", 60), true, "and Devanagari ones")
})

test("ET-NL-04: every piece no setting covers is listed under Not in this cut, in the person's own words; an invented one isn't", () => {
  const message = "Captions, and add a 3D spinning logo at the end"
  const read = readIntent({ understood: [], cannot: [{ evidence: "add a 3D spinning logo", nearest: "a title card with your logo's name" }, { evidence: "a dancing robot" }], questions: [] }, { message, fields, code: { captions: "clean" } })
  assert.deepEqual(read.cannot, [{ said: "add a 3D spinning logo", nearest: "a title card with your logo's name" }])
  assert.deepEqual(read.understood, [{ field: "captions", value: "clean", evidence: null, by: "code" }], "what code read is shown too")
})

test("ET-NL-05: code and model disagree: code's reading wins and the card says what it understood", () => {
  const read = readIntent({ understood: [{ field: "captions", value: "karaoke", evidence: "captions" }], cannot: [], questions: [] }, { message: "boxed captions please", fields, code: { captions: "boxed" } })
  assert.deepEqual(read.apply, { captions: "boxed" })
  assert.deepEqual(read.understood[0], { field: "captions", value: "boxed", evidence: "captions", by: "code", model: "karaoke" })
  assert.equal(understoodLine(read.understood[0]), 'Captions: boxed (you said "captions"); read by Kriya\'s code, not as karaoke')
})

test("ET-NL-06: at most two questions, each with a default selected; a third takes its default; an answer isn't asked again", () => {
  const q = (field, options, chosen) => ({ field, question: `Which ${field}?`, options, default: chosen, evidence: "make it nicer" })
  const intent = { understood: [], cannot: [], questions: [q("grade", ["warm", "cinematic"], "warm"), q("music", ["calm", "upbeat"], "jazz"), q("cutSound", ["whoosh", "pop"], "pop"), q("titles", [true, false], true)] }
  const first = readIntent(intent, { message: "Make it nicer", fields })
  assert.equal(first.questions.length, MAX_QUESTIONS)
  assert.deepEqual(first.questions.map((x) => [x.field, x.default]), [["grade", "warm"], ["music", "calm"]], "a default outside the options becomes the first option")
  assert.deepEqual(first.defaulted.map((x) => [x.field, x.value, x.why]), [["cutSound", "pop", "default"], ["titles", true, "default"]])
  assert.deepEqual(first.apply, { grade: "warm", music: "calm", cutSound: "pop", titles: true }, "every open point has its default, so no plan is blocked")
  const second = readIntent(intent, { message: "Make it nicer", fields, answers: { grade: "cinematic" } })
  assert.equal(second.questions.some((x) => x.field === "grade"), false, "answered: not asked again")
  assert.equal(second.apply.grade, "cinematic", "the person's answer stands")
  // The card's answer becomes the brief an approval sends, as the Host's briefOf would make it
  assert.deepEqual(answerOnBrief({ music: "generated:calm" }, "music", "none"), {})
  assert.deepEqual(answerOnBrief({}, "grade", "cinematic"), { grade: "cinematic" })
  assert.deepEqual(answerOnBrief({ grade: "warm" }, "grade", "natural"), {})
  assert.deepEqual(answerOnBrief({}, "titles", true), { titles: true })
})

test("ET-NL-08: the same request in English, Telugu, Hindi and mixed speech fills the same settings (scripted model)", async () => {
  const { index, project } = talk()
  const asks = {
    en: ["Make it 60 seconds long with karaoke captions and calm music", "60 seconds", "karaoke captions", "calm music"],
    te: ["దీన్ని 60 సెకన్లు చేయండి, కరోకే క్యాప్షన్లు మరియు ప్రశాంతమైన సంగీతం పెట్టండి", "60 సెకన్లు", "కరోకే క్యాప్షన్లు", "ప్రశాంతమైన సంగీతం"],
    hi: ["इसे ६० सेकंड का बनाओ, कराओके कैप्शन और शांत संगीत के साथ", "६० सेकंड", "कराओके कैप्शन", "शांत संगीत"],
    mixed: ["isko 60 seconds ka banao, karaoke captions aur calm music ke saath", "60 seconds", "karaoke captions", "calm music"],
  }
  const made = {}
  for (const [language, [text, seconds, captions, music]] of Object.entries(asks)) {
    // The Director's own settings say otherwise: what the person asked for wins
    const { ask } = scripted([plan({ seconds: 30, captions: "clean", music: "upbeat" }, { understood: [{ field: "seconds", value: 60, evidence: seconds }, { field: "captions", value: "karaoke", evidence: captions }, { field: "music", value: "calm", evidence: music }], cannot: [], questions: [] })])
    const out = await planCut({ ask, project, index, text, intent: true })
    made[language] = { seconds: out.settings.seconds, captions: out.settings.captions, music: out.settings.music }
    assert.deepEqual(out.intent.understood.map((u) => u.field).sort(), ["captions", "music", "seconds"], language)
  }
  for (const language of Object.keys(asks)) assert.deepEqual(made[language], { seconds: 60, captions: "karaoke", music: "calm" }, language)
})

test("ET-NL-09: the frame rides in the call that already happens: one model call per plan and per change, switch on and off; a malformed frame costs no repair", async () => {
  const { index, project } = talk()
  for (const intent of [false, true]) {
    const p = scripted([plan({ captions: "clean" }, intent ? { understood: [{ field: "captions", value: "clean", evidence: "captions" }, { field: "nope", value: 1, evidence: "x" }], cannot: [{ evidence: 42 }], questions: [{ field: "grade" }] } : undefined)])
    const out = await planCut({ ask: p.ask, project, index, text: "captions please", intent })
    assert.equal(p.bodies.length, 1, `plan, intent ${intent}: one call`)
    assert.equal(out.source, "model", "not repaired: the malformed parts were tidied away")
    const c = scripted([{ ops: [], say: "Nothing to change.", ...(intent ? { cannot: [{ evidence: "spin the logo" }] } : {}) }])
    const changed = await revise({ ask: c.ask, project, index, text: "spin the logo", intent })
    assert.equal(c.bodies.length, 1, `change, intent ${intent}: one call`)
    if (intent) assert.deepEqual(changed.cannot, [{ said: "spin the logo" }], "and what it can't do is said")
  }
})

test("ET-NL-REG-01: switch off, the plan's and the console's schema and prompt are the objects and text they were; no frame in the plan", async () => {
  const { index, project } = talk()
  const off = scripted([plan({ captions: "clean" })])
  const before = scripted([plan({ captions: "clean" })])
  const out = await planCut({ ask: off.ask, project, index, text: "captions please, and a spinning logo", intent: false })
  await planCut({ ask: before.ask, project, index, text: "captions please, and a spinning logo" })
  assert.deepEqual(off.bodies, before.bodies, "the request the model sees, byte for byte, is the one with no switch")
  assert.deepEqual(off.bodies[0].response_format.json_schema.schema, PLAN_SCHEMA)
  assert.equal(JSON.stringify(off.bodies[0]).includes("intent"), false)
  assert.equal("intent" in out, false, "the plan has no frame")
  const c = scripted([{ ops: [], say: "ok" }])
  const changed = await revise({ ask: c.ask, project, index, text: "spin the logo" })
  assert.deepEqual(c.bodies[0].response_format.json_schema.schema, consoleSchema(false))
  assert.equal(JSON.stringify(c.bodies[0]).includes("cannot"), false)
  assert.equal("cannot" in changed, false)
  assert.deepEqual(tidyIntent(undefined, fields), { understood: [], cannot: [], questions: [] })
})
