import assert from "node:assert/strict"
import { test } from "node:test"

import { apply } from "../src/edit/core/ops.js"
import { compile } from "../src/edit/core/plan.js"
import { newProject } from "../src/edit/core/project.js"
import { solve } from "../src/edit/core/solver.js"
import { createAsk, DIRECTOR_CORE, parseReply, schemaErrors, THINKING } from "../src/edit/director/ask.js"
import { cleanSelection, CONSOLE_OPS, describe, revise } from "../src/edit/director/revise.js"
import { UNTRUSTED_OPEN } from "../src/edit/index/views.js"
import { createGovernor } from "../src/edit/loop/governor.js"
import { candidateLines, planReel, REEL_TALKING_HEAD, runsOf } from "../src/edit/recipes/reel.js"
import { indexOf, lengthOf, wordId } from "./edit/script.js"

// The Director on a scripted model (AGENTS.md: model calls cost money; behaviour is
// tested with scripts). The model is a function of the slot it's asked to fill.

const FLICKS = 705_600_000

function rawProject() {
  const made = apply(newProject({ id: "p", name: "Pricing" }), [{ op: "add_asset", id: "a1", kind: "video", fingerprint: "f", path: "take.mov", linked: true, rights: "unknown", facts: { width: 640, height: 360, hasAudio: true, duration: Math.round(lengthOf() * FLICKS), vfr: false, fps: { n: 30, d: 1 }, color: { primaries: "bt709", transfer: "bt709", range: "tv", tagged: true, hdr: false } } }], { author: "code" })
  return made.project
}

/** A Director whose model answers by slot; every request it got is kept. */
function director(answers, { budget } = {}) {
  const requests = []
  const send = async (body) => {
    requests.push(body)
    const task = body.response_format.json_schema.name
    const turn = requests.filter((r) => r.response_format.json_schema.name === task).length
    const reply = typeof answers[task] === "function" ? answers[task](turn, body) : answers[task]
    if (reply instanceof Error) throw reply
    return { choices: [{ message: { content: typeof reply === "string" ? reply : JSON.stringify(reply) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }
  }
  const records = []
  const ask = createAsk({ governor: createGovernor({ send, windowMs: 50 }), record: (row) => records.push(row), ...(budget ? { budget } : {}) })
  return { ask, requests, records }
}

/** The words the cut plays, in the order it plays them. */
const kept = (project, index) => {
  const { picture } = solve(project, index)
  const at = (w) => picture.find((p) => p.asset === w.asset && w.start >= p.in && w.end <= p.out)
  return index.words.filter(at).sort((a, b) => at(a).at + (a.start - at(a).in) - (at(b).at + (b.start - at(b).in)))
}

test("ET-DIR-01: a scripted run gives a valid reel: the best takes, no fillers, the hook first, punch-ins, 9:16", async () => {
  const index = indexOf()
  const hook = index.sentences.find((s) => index.words.find((w) => w.id === s.firstWord).text === "It").id
  const { ask, requests } = director({ story: { hook, drop: [] }, emphasis: { emphasis: [wordId(index, "fifty"), wordId(index, "week.")] } })
  const made = await planReel({ project: rawProject(), index, asset: "a1", ask })
  assert.deepEqual(made.slots, { story: "model", emphasis: "model" })
  const words = kept(made.project, index).map((w) => w.text)
  for (const gone of ["um", "Uh,", "Sorry,", "again."]) assert.ok(!words.includes(gone), `"${gone}" is cut`)
  const keptIds = new Set(kept(made.project, index).map((w) => w.id))
  const line = (first) => index.sentences.find((s) => index.words.find((w) => w.id === s.firstWord).text === first)
  const wordsOf = (s) => index.words.filter((w) => w.start >= s.start && w.end <= s.end)
  assert.ok(wordsOf(line("Uh,")).every((w) => !keptIds.has(w.id)), "the stuttered attempt is out")
  assert.ok(wordsOf(line("The")).every((w) => keptIds.has(w.id)), "its clean retake is in, whole")
  assert.equal(words.join(" ").includes("We built the whole thing in a We built"), false, "the cut-off attempt isn't kept")
  assert.equal(words.slice(0, 3).join(" "), "It cost us", "the hook plays first")
  assert.match(made.notes.join(" "), /hook/)
  const punches = made.ops.filter((op) => op.op === "punch_in")
  assert.deepEqual(punches.map((p) => p.at.word), [wordId(index, "fifty"), wordId(index, "week.")])
  assert.equal(made.project.canvas.width, 1080)
  assert.equal(made.project.canvas.height, 1920)
  assert.ok(made.ops.filter((op) => op.op === "reframe").every((op) => op.mode === "fixed"), "no face track: a centred crop")
  assert.match(made.notes.join(" "), /holds the centre/)
  // Every id an operation names resolves in the index
  const ids = new Set(index.words.map((w) => w.id))
  for (const op of made.ops) for (const ref of [op.from, op.to, op.at, op.until]) if (ref?.word) assert.ok(ids.has(ref.word), ref.word)
  const plan = compile(made.project, index, { engineVersion: "t", runtimeVersion: "t", quality: "master", deliverable: made.project.deliverables[0].id })
  assert.deepEqual(plan.audio.loudness, { lufs: -14, tp: -1 }, "the master is mastered to the reel's target")
  assert.ok(plan.duration >= 30 * FLICKS && plan.duration <= 60 * FLICKS, `${plan.duration / FLICKS} s`)
  assert.ok(requests.every((r) => r.messages[1].content.includes(UNTRUSTED_OPEN)), "the transcript reaches the model fenced as untrusted")
})

test("with a face track the reel follows the speaker, through the ADMM reframe solver", async () => {
  const index = indexOf()
  index.shots = [{ id: "a1:sh0", asset: "a1", start: 0, end: Math.round(lengthOf() * FLICKS) }]
  index.subjects = { a1: Array.from({ length: Math.floor(lengthOf()) }, (_, i) => ({ t: i * FLICKS, x: 250 + (i % 7) * 8, shot: "a1:sh0" })) }
  const { ask } = director({ story: new Error("down"), emphasis: new Error("down") })
  const made = await planReel({ project: rawProject(), index, asset: "a1", ask })
  assert.ok(made.ops.filter((op) => op.op === "reframe").every((op) => op.mode === "subject"))
  const plan = compile(made.project, index, { engineVersion: "t", runtimeVersion: "t", quality: "master", deliverable: made.project.deliverables[0].id })
  const crops = plan.segments.flatMap((s) => s.node.picture).filter((p) => p.crop?.length)
  assert.ok(crops.length > 0, "a crop path from the solver")
  assert.ok(crops.every((p) => p.crop.every((point) => point.x >= 0 && point.x <= 640 - 202)), "inside the frame")
})

test("ET-DIR-02: malformed output gets one repair, then the slot's default, and the run finishes and says so", async () => {
  const index = indexOf()
  const once = director({ story: (turn) => (turn === 1 ? "this isn't json" : { hook: null, drop: [] }), emphasis: { emphasis: [] } })
  const first = await planReel({ project: rawProject(), index, asset: "a1", ask: once.ask })
  assert.equal(first.slots.story, "repaired")
  assert.match(once.requests[1].messages.at(-1).content, /refused: isn't valid JSON/, "the repair carries the exact reason")
  const twice = director({ story: "{oops", emphasis: { nope: 1 } })
  const second = await planReel({ project: rawProject(), index, asset: "a1", ask: twice.ask })
  assert.deepEqual(second.slots, { story: "default", emphasis: "default" })
  assert.equal(twice.requests.length, 4, "two tries per slot, never a loop")
  assert.match(second.notes.join(" "), /didn't fit, twice/)
  assert.ok(second.project.sequences[0].clips.length > 0, "and the reel still exists")
  assert.equal(second.ops.filter((op) => op.op === "punch_in").length, 0, "the emphasis default takes words with digits, and this take has none")
})

test("ET-DIR-03: an id that doesn't exist is refused by meaning, and repaired", async () => {
  const index = indexOf()
  const { ask, requests } = director({ story: (turn) => (turn === 1 ? { hook: "a1:s99", drop: ["a1:s77"] } : { hook: null, drop: [] }), emphasis: (turn) => (turn === 1 ? { emphasis: ["a1:w9999"] } : { emphasis: [wordId(index, "week.")] }) })
  const made = await planReel({ project: rawProject(), index, asset: "a1", ask })
  assert.deepEqual(made.slots, { story: "repaired", emphasis: "repaired" })
  assert.match(requests[1].messages.at(-1).content, /"a1:s99" isn't one of the sentences shown/)
  assert.deepEqual(made.ops.filter((op) => op.op === "punch_in").map((op) => op.at.word), [wordId(index, "week.")])
})

test("ET-DIR-04: with the model unavailable throughout, the reel is made on defaults, and marked", async () => {
  const index = indexOf()
  const down = Object.assign(new Error("signed out"), { status: 401, code: "signed_out" })
  const { ask } = director({ story: down, emphasis: down })
  const made = await planReel({ project: rawProject(), index, asset: "a1", ask })
  assert.deepEqual(made.slots, { story: "default", emphasis: "default" })
  assert.match(made.notes.join(" "), /couldn't answer: signed out/)
  assert.equal(kept(made.project, index)[0].text, "Okay", "no hook chosen: the original order")
})

test("ET-DIR-06: the job's budget stops calls; the slot takes its default", async () => {
  let left = 1
  const { ask, requests } = director({ story: { hook: null, drop: [] }, emphasis: { emphasis: [] } }, { budget: { take: () => left-- > 0 } })
  const made = await planReel({ project: rawProject(), index: indexOf(), asset: "a1", ask })
  assert.equal(requests.length, 1)
  assert.equal(made.slots.emphasis, "default")
  assert.match(made.notes.join(" "), /budget is spent/)
})

test("ET-DIR-07: prompt blocks 0 and 1 are byte-stable across calls in a project", async () => {
  const index = indexOf()
  const { ask, requests } = director({ story: { hook: null, drop: [] }, emphasis: { emphasis: [] } })
  await planReel({ project: rawProject(), index, asset: "a1", ask })
  await planReel({ project: rawProject(), index, asset: "a1", ask })
  const systems = new Set(requests.map((r) => r.messages[0].content))
  assert.equal(systems.size, 1, "one system prefix for every call")
  assert.ok([...systems][0].startsWith(DIRECTOR_CORE))
  assert.doesNotMatch([...systems][0], /\d{4}-\d\d-\d\d|Pricing|take\.mov/, "nothing volatile in it: no date, no project or file name")
  // The answer's own budget plus room for a thinking model's reasoning, asked to keep it low
  assert.ok(requests.every((r) => Number.isInteger(r.max_tokens) && r.max_tokens <= 2000 + THINKING), "every call has its output budget")
  assert.ok(requests.every((r) => r.reasoning?.effort === "low"), "and asks a thinking model to think briefly")
})

test("ET-GOV-04: a first cut uses at most 8 model calls", async () => {
  const { ask, requests } = director({ story: (turn) => (turn === 1 ? "bad" : { hook: null, drop: [] }), emphasis: (turn) => (turn === 1 ? "bad" : { emphasis: [] }) })
  await planReel({ project: rawProject(), index: indexOf(), asset: "a1", ask })
  assert.ok(requests.length <= 8, `${requests.length} calls, with both repairs`)
})

test("the console: words and a selection become a proposal on stable ids, described by code", async () => {
  const index = indexOf()
  let project = (await planReel({ project: rawProject(), index, asset: "a1", ask: director({ story: { hook: null, drop: [] }, emphasis: { emphasis: [] } }).ask })).project
  const fifty = wordId(index, "fifty")
  const { ask, requests } = director({ console: (turn, body) => (body.messages[1].content.includes(`words ${fifty} to ${fifty}`) ? { ops: [{ op: "punch_in", at: { word: fifty, edge: "start" }, duration: FLICKS / 2, scale: 1.2 }] } : { ops: [] }) })
  const result = await revise({ ask, project, index, text: "punch in here", selection: cleanSelection({ words: [fifty, fifty] }, project, index) })
  assert.equal(result.source, "model")
  assert.deepEqual(result.changes, ['Punched in 1.2× at "fifty"'])
  assert.ok(result.project, "applied to a copy only")
  assert.equal(project.sequences[0].clips.some((c) => c.effects?.some((e) => e.type === "zoom" && e.scale === 1.2)), false, "the project itself is untouched")
  assert.match(requests[0].messages[1].content, /"punch in here"/)
  // A bad id, then a bad op: refused by Edit Core, repaired once, then nothing
  const stubborn = director({ console: { ops: [{ op: "split", clip: "c999", at: 5 }] } })
  const refused = await revise({ ask: stubborn.ask, project, index, text: "split it" })
  assert.deepEqual(refused.ops, [])
  assert.match(stubborn.requests[1].messages.at(-1).content, /operation 1:/)
  assert.ok(schemaErrors({ type: "object", properties: { ops: { type: "array", items: { type: "object", properties: { op: { type: "string", enum: CONSOLE_OPS } }, required: ["op"], additionalProperties: false } } }, required: ["ops"] }, { ops: [{ op: "add_asset" }] }).length > 0, "a file can't be added by asking (ES-01)")
  for (const op of ["caption_style", "caption_edit", "add_title", "grade"]) assert.ok(CONSOLE_OPS.includes(op), `${op} can be asked for now captions render`)
  assert.equal(cleanSelection({ words: ["a1:w0", "../etc"] }, project, index), null, "a selection naming anything unknown is dropped")
  assert.equal(describe({ op: "remove_range", asset: "a1", from: { word: "a1:w1", edge: "start" }, to: { word: "a1:w2", edge: "end" } }, index), 'Cut "so" to "um"')
})

test("ET-RCP-01: the recipe is data, with no command, path, URL, model or price", () => {
  const text = JSON.stringify(REEL_TALKING_HEAD)
  assert.doesNotMatch(text, /"(command|cmd|path|file|url|href|model|price|cost|shell|exec)"\s*:/i)
  assert.doesNotMatch(text, /https?:\/\/|\/usr\/|\.sh\b|ffmpeg/i)
  const lines = candidateLines(indexOf(), "a1")
  assert.equal(lines.length, 9, "twelve lines less a restart, a cut-off attempt and a retake")
  assert.ok(lines.every((l) => runsOf(l).length >= 1))
})

test("a reply is read through a thinking block, a fence or a sentence around it; a cut-off one says so", () => {
  const value = { ops: [{ op: "mark", name: "a {brace} \"quoted\"", at: 0 }] }
  const json = JSON.stringify(value)
  for (const text of [json, `\`\`\`json\n${json}\n\`\`\``, `<think>maybe {ops: []} works</think>${json}`, `Here is the edit:\n${json}\nHope that helps.`]) assert.deepEqual(parseReply(text).value, value, text.slice(0, 30))
  assert.match(parseReply('{"ops": [{"op": "mark"', "length").problem, /cut off/)
  assert.match(parseReply("", "length").problem, /cut off/)
  assert.match(parseReply("", "stop").problem, /cut off/, "an empty answer is too")
  assert.equal(parseReply("no json here", "stop").problem, "isn't valid JSON")
})

test("the console proposes transcript fixes on known words, and hands a whole-video request to the Director", async () => {
  const index = indexOf()
  const klea = index.words[3]
  const { ask } = director({ console: { ops: [], corrections: [{ word: klea.id, text: "Kriya" }, { word: "a1:w99999", text: "nope" }, { word: index.words[4].id, text: index.words[4].text }], direct: { seconds: 30, captions: "karaoke" } } })
  const made = await revise({ ask, project: rawProject(), index, text: "make it stunning, fix the transcript and direct it" })
  assert.equal(made.source, "model")
  assert.deepEqual(made.corrections, [{ word: klea.id, text: "Kriya", change: `Corrected "${klea.text}" to "Kriya"` }], "an unknown word and a no-change are dropped")
  assert.deepEqual(made.direct, { seconds: 30, captions: "karaoke" })
  assert.deepEqual(made.ops, [])
})
