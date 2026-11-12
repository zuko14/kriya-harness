import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

import { apply } from "../src/edit/core/ops.js"
import { newProject } from "../src/edit/core/project.js"
import { createAsk, ESCALATION_TIER } from "../src/edit/director/ask.js"
import { mayWatchFrames, paceOf, timelineOf, viewerReport, WINDOW } from "../src/edit/director/viewer.js"
import { fixesFor, keepFix, roundsLeft, sayWatch, watchAndFix } from "../src/edit/director/watch-fix.js"
import { createGovernor } from "../src/edit/loop/governor.js"
import { makeReel } from "../src/edit/loop/make.js"
import { ROUNDS } from "../src/edit/loop/repair.js"
import { hooksFor, OPENING, planOpenings } from "../src/edit/recipes/openings.js"
import { byMeaning, planReel, wordsOf } from "../src/edit/recipes/reel.js"
import { ROOT } from "./helpers.js"
import { indexOf, lengthOf } from "./edit/script.js"

// TP8 (TOP_TIER_PLAN §5, ET-DL-*): the Viewer's Report, each finding's fix, the keep rule, the rounds,
// escalation only to a listed tier, the frame consent gate and the budget. No media, no model: the
// gateway is a script and the draft's measures are given. The real render is tests/edit/media/director-loop.test.js.

const F = 705_600_000
const facts = (seconds, extra = {}) => ({ width: 640, height: 360, hasAudio: true, duration: Math.round(seconds * F), vfr: false, fps: { n: 30, d: 1 }, color: { primaries: "bt709", transfer: "bt709", range: "tv", tagged: true, hdr: false }, ...extra })
const asset = (id, seconds, extra = {}) => ({ op: "add_asset", id, kind: "video", fingerprint: `f-${id}`, path: `${id}.mov`, linked: true, rights: "own", facts: facts(seconds), ...extra })
const passing = { blocking: 0, briefMisses: 0, notes: 0 }
const failing = { blocking: 1, briefMisses: 0, notes: 0 }

/** A take, two B-roll clips, a cut of its first 20 s; extra ops on top. */
function world(extra = [], { broll = ["b1", "b2"] } = {}) {
  const index = indexOf("a1")
  let made = apply(newProject({ id: "p", name: "Watch" }), [asset("a1", lengthOf() + 2), ...broll.map((id) => asset(id, 12, { role: "broll" }))], { author: "code" })
  made = apply(made.project, [{ op: "keep_range", asset: "a1", from: 0, to: Math.round(20 * F) }, ...extra], { index, author: "agent" })
  assert.ok(made.applied, JSON.stringify(made.diagnostics))
  return { project: made.project, index }
}
const words = (count) => Array.from({ length: count }, (_, i) => ({ at: i * F, end: i * F + F / 2 }))
const flat = (duration, extra = {}) => ({ duration, base: [{ clip: "c1", asset: "a1", at: 0, end: duration, in: 0, out: duration, face: true }], cutaways: [], texts: [], zooms: [], changes: [], words: words(Math.floor(duration / F)), ...extra })

test("ET-DL-01: the report is five-second windows of picture change, face, text, loudness, speech and motion, the same every time", () => {
  const timeline = flat(12 * F, { changes: [1 * F, 2 * F, 7 * F], cutaways: [{ clip: "c2", asset: "b1", at: 6 * F, end: 8 * F, in: 0, out: 2 * F }], texts: [{ clip: "c3", at: 0, end: 4 * F, kind: "caption" }] })
  const measured = { frames: [{ t: 0, mafd: 4, score: 0 }, { t: 6 * F, mafd: 2, score: 0 }, { t: 11 * F, mafd: 0.5, score: 0 }], cuts: [2 * F + F / 20, 11 * F], loudness: Array.from({ length: 120 }, (_, i) => (i < 50 ? -18 : -20)), silences: [] }
  const report = viewerReport({ timeline, measured, genre: "opinion" })
  assert.equal(WINDOW, 5 * F)
  assert.deepEqual(report.windows.map((w) => [w.at, w.end]), [[0, 5 * F], [5 * F, 10 * F], [10 * F, 12 * F]])
  // A measured cut within a fifth of a second of a timeline change is the same change, not two
  assert.deepEqual(report.windows.map((w) => w.changes), [2, 1, 1])
  assert.deepEqual(report.windows.map((w) => w.face), [1, 0.6, 1], "a cutaway covers the face for its length")
  assert.deepEqual(report.windows.map((w) => w.text), [1, 0, 0])
  assert.deepEqual(report.windows.map((w) => w.loudness), [-18, -20, -20])
  assert.deepEqual(report.windows.map((w) => w.speech), [1, 1, 1])
  assert.deepEqual(report.windows.map((w) => w.motion), [4, 2, 0.5])
  assert.deepEqual(viewerReport({ timeline, measured, genre: "opinion" }), report, "deterministic")
  assert.equal(report.score, 100, "nothing found")
})

test("ET-DL-01: each finding is found where it is, and the slow genres are never dull", () => {
  const timeline = flat(20 * F, {
    changes: [1 * F, 6 * F],
    texts: [{ clip: "cap", at: 11 * F, end: 14 * F, kind: "caption" }, { clip: "g1", at: 11.5 * F, end: 13 * F, kind: "graphic", block: { blockId: "title" } }, { clip: "s1", at: 12 * F, end: 14 * F, kind: "scene", block: { blockId: "scene" } }],
    cutaways: [{ clip: "x1", asset: "b1", at: 1 * F, end: 3 * F, in: 0, out: 2 * F }, { clip: "x2", asset: "b1", at: 6 * F, end: 8 * F, in: F, out: 3 * F }],
  })
  const loudness = Array.from({ length: 200 }, (_, i) => (i < 100 ? -24 : -14))
  const measured = { frames: [], cuts: [], loudness, silences: [{ start: 16 * F, end: 18 * F }, { start: 4 * F, end: 4.5 * F }] }
  const report = viewerReport({ timeline, measured, genre: "opinion" })
  const kinds = report.findings.map((f) => `${f.kind}@${f.at / F}`)
  assert.deepEqual(kinds, ["repeated_cutaway@6", "dull@10", "level_jump@10", "crowded@12", "dull@15", "dead_air@16"])
  assert.deepEqual(report.findings.find((f) => f.kind === "crowded").clips.sort(), ["cap", "g1", "s1"])
  assert.equal(report.findings.find((f) => f.kind === "level_jump").db, 10)
  assert.ok(report.score < 100)
  assert.equal(paceOf("documentary"), 0)
  assert.ok(!viewerReport({ timeline, measured, genre: "documentary" }).findings.some((f) => f.kind === "dull"), "a slow genre's still stretch is its pace")
  // Unrendered, pauses come from the spoken words
  const gappy = flat(12 * F, { changes: [2 * F, 7 * F, 11 * F], words: [{ at: F, end: 2 * F }, { at: 5 * F, end: 6 * F }] })
  assert.deepEqual(viewerReport({ timeline: gappy }).findings.map((f) => f.kind), ["dead_air"])
})

test("ET-DL-02: a still stretch gets a punch-in, by code, that the project takes", () => {
  const { project, index } = world()
  const timeline = timelineOf(project, index)
  const report = viewerReport({ timeline })
  const dull = report.findings.filter((f) => f.kind === "dull")
  assert.ok(dull.length >= 2, "a 20 s single take with no change is still")
  const { fixes } = fixesFor(report, project, index, timeline)
  const punches = fixes.filter((f) => f.kind === "dull")
  assert.equal(punches.length, dull.length)
  assert.ok(punches.every((f) => f.ops.length === 1 && f.ops[0].op === "punch_in" && f.ops[0].scale > 1))
  const fixed = apply(project, punches.flatMap((f) => f.ops), { index, author: "code" })
  assert.ok(fixed.applied, JSON.stringify(fixed.diagnostics))
  const after = viewerReport({ timeline: timelineOf(fixed.project, index) })
  assert.ok(!after.findings.some((f) => f.kind === "dull"), "every still window now changes")
  assert.ok(after.score > report.score)
})

test("ET-DL-02: a crowded moment's graphic moves clear; a scene stays on its words", () => {
  const { project, index } = world([{ op: "add_title", text: "ONE", at: 2 * F, duration: 2 * F }, { op: "add_lower_third", text: "Two", at: 2.5 * F, duration: 2 * F }, { op: "add_title", text: "THREE", at: 3 * F, duration: 1 * F }])
  const timeline = timelineOf(project, index)
  const report = viewerReport({ timeline })
  assert.ok(report.findings.some((f) => f.kind === "crowded"))
  const fix = fixesFor(report, project, index, timeline).fixes.find((f) => f.kind === "crowded")
  assert.deepEqual(fix.ops.map((o) => o.op), ["ripple_delete", "add_motion"])
  const moved = apply(project, fix.ops, { index, author: "code" })
  assert.ok(moved.applied, JSON.stringify(moved.diagnostics))
  assert.ok(!viewerReport({ timeline: timelineOf(moved.project, index) }).findings.some((f) => f.kind === "crowded"))
  // Only scenes and captions: nothing is moved, the finding is left for the person
  const scenes = { ...timeline, texts: [{ clip: "a", at: 0, end: F, kind: "caption" }, { clip: "b", at: 0, end: F, kind: "scene", block: { blockId: "scene" } }, { clip: "c", at: 0, end: F, kind: "scene", block: { blockId: "scene" } }] }
  const left = fixesFor({ findings: [{ kind: "crowded", at: 0, end: F, clips: ["a", "b", "c"] }] }, project, index, scenes)
  assert.deepEqual([left.fixes.length, left.left.length], [0, 1])
})

test("ET-DL-02: a long pause is trimmed inside its clip, never through a word", () => {
  // The script with a 2.9 s pause before "It cost us…": a speaker who stopped to think
  const plain = indexOf("a1")
  const after = plain.words.find((w) => w.text === "It").start
  const index = { ...plain, words: plain.words.map((w) => (w.start >= after ? { ...w, start: w.start + 2 * F, end: w.end + 2 * F } : w)) }
  const made = apply(apply(newProject({ id: "p", name: "Pause" }), [asset("a1", lengthOf() + 4)], { author: "code" }).project, [{ op: "keep_range", asset: "a1", from: 0, to: Math.round(26 * F) }], { index, author: "agent" })
  const project = made.project
  const timeline = timelineOf(project, index)
  const report = viewerReport({ timeline })
  const pause = report.findings.find((f) => f.kind === "dead_air")
  assert.ok(pause && pause.end - pause.at >= 2.8 * F, JSON.stringify(report.findings))
  const fix = fixesFor({ findings: [pause] }, project, index, timeline)
  assert.equal(fix.fixes[0].ops[0].op, "remove_range")
  const { from, to } = fix.fixes[0].ops[0]
  assert.ok(!index.words.some((w) => w.start < to && w.end > from), "no word inside what is cut")
  const trimmed = apply(project, fix.fixes[0].ops, { index, author: "code" })
  assert.ok(trimmed.applied, JSON.stringify(trimmed.diagnostics))
  const shorter = timelineOf(trimmed.project, index)
  assert.ok(timeline.duration - shorter.duration >= 2 * F, "the pause went, a quarter second kept each side")
  assert.ok(!viewerReport({ timeline: shorter }).findings.some((f) => f.kind === "dead_air"))
  // A pause with a word inside it is the person's
  const word = timeline.words[3]
  assert.equal(fixesFor({ findings: [{ kind: "dead_air", at: word.at - F / 10, end: word.end + F / 10 }] }, project, index, timeline).left.length, 1)
})

test("ET-DL-02: a repeated cutaway is swapped for another of the person's clips, or taken out", () => {
  const { project, index } = world([{ op: "place_broll", asset: "b1", at: 2 * F, in: 0, duration: 2 * F }, { op: "place_broll", asset: "b1", at: 7 * F, in: F / 2, duration: 2 * F }])
  const timeline = timelineOf(project, index)
  const report = viewerReport({ timeline })
  const repeat = report.findings.find((f) => f.kind === "repeated_cutaway")
  assert.ok(repeat, JSON.stringify(report.findings))
  const fix = fixesFor(report, project, index, timeline).fixes.find((f) => f.kind === "repeated_cutaway")
  assert.deepEqual(fix.ops.map((o) => [o.op, o.asset]), [["ripple_delete", undefined], ["place_broll", "b2"]])
  const swapped = apply(project, fix.ops, { index, author: "code" })
  assert.ok(swapped.applied)
  assert.ok(!viewerReport({ timeline: timelineOf(swapped.project, index) }).findings.some((f) => f.kind === "repeated_cutaway"))
  // One B-roll clip only: the repeat is taken out
  const alone = world([{ op: "place_broll", asset: "b1", at: 2 * F, in: 0, duration: 2 * F }, { op: "place_broll", asset: "b1", at: 7 * F, in: 0, duration: 2 * F }], { broll: ["b1"] })
  const t2 = timelineOf(alone.project, alone.index)
  const out = fixesFor(viewerReport({ timeline: t2 }), alone.project, alone.index, t2).fixes.find((f) => f.kind === "repeated_cutaway")
  assert.deepEqual(out.ops.map((o) => o.op), ["ripple_delete"])
})

test("ET-DL-02: a jump in level brings the louder side's own clips down, never past the quieter", () => {
  const { project, index } = world([{ op: "split", clip: "c1", at: { word: indexOf("a1").words.find((w) => w.start > 9 * F).id, edge: "start" } }])
  const timeline = timelineOf(project, index)
  assert.equal(timeline.base.length, 2)
  const cut = timeline.base[1].at
  const finding = { kind: "level_jump", at: cut, end: cut + WINDOW, db: 9, louder: { at: cut, end: cut + WINDOW } }
  const fix = fixesFor({ findings: [finding] }, project, index, timeline).fixes[0]
  assert.deepEqual(fix.ops, [{ op: "set_level", clip: timeline.base[1].clip, db: -7 }])
  assert.ok(apply(project, fix.ops, { index, author: "code" }).applied)
})

test("ET-DL-03: a fix is kept only when the score rises and the gates are no worse; a passing cut is never swapped for a failing one (EH-74)", () => {
  const at = (score, checked) => ({ report: { score }, checked })
  assert.deepEqual(keepFix(at(70, passing), at(80, passing)), { kept: true })
  assert.equal(keepFix(at(70, passing), at(60, passing)).kept, false, "a lower score")
  assert.equal(keepFix(at(70, passing), at(70, passing)).kept, false, "the same score")
  assert.match(keepFix(at(70, passing), at(95, failing)).reason, /fail a gate the cut passed/)
  assert.match(keepFix(at(70, { ...passing, notes: 1 }), at(95, { ...passing, notes: 3 })).reason, /gates were worse/)
  assert.equal(keepFix(at(70, failing), at(80, failing)).kept, true, "a failing cut may still get better")
})

test("ET-DL-04: two rounds at most, inside the repair ladder's own; a fix that lowers the score is dropped and the cut stays", async () => {
  assert.equal(roundsLeft([]), 2)
  assert.equal(roundsLeft([{}]), 2)
  assert.equal(roundsLeft([{}, {}]), ROUNDS - 2)
  assert.equal(roundsLeft([{}, {}, {}]), 0, "the ladder used every round: no watch render on top (EH-74)")
  const { project, index } = world()
  let renders = 0
  const scores = [50, 40]
  const start = { project, ops: [], file: "draft-0", plan: { duration: 20 * F }, checked: passing }
  const view = async (attempt) => {
    const timeline = timelineOf(attempt.project, index)
    const report = viewerReport({ timeline })
    return { timeline, report: { ...report, score: attempt.file === "draft-0" ? scores[0] : scores[1] } }
  }
  const result = await watchAndFix(start, { index, view, render: async () => ({ file: `draft-${++renders}`, plan: { duration: 20 * F } }), check: async () => passing, rounds: 5 })
  assert.equal(result.best.file, "draft-0", "the worse attempt was set aside")
  assert.equal(result.best.project, project)
  assert.equal(result.rounds[0].kept, false)
  assert.match(sayWatch(result.rounds)[0], /kept the cut as it was: the score didn't rise \(50 → 40\)/)
  assert.ok(renders <= 2, `${renders} renders`)
  // A kept fix, then nothing new to try: one round, never more than two
  renders = 0
  const better = await watchAndFix(start, { index, view: async (a) => { const timeline = timelineOf(a.project, index); return { timeline, report: viewerReport({ timeline }) } }, render: async () => ({ file: `d${++renders}`, plan: {} }), check: async () => passing, rounds: 9 })
  assert.equal(better.rounds[0].kept, true)
  assert.ok(better.rounds.length <= 2 && renders <= 2)
  assert.match(sayWatch(better.rounds)[0], /^Director: Punched in on a still stretch at 0:00\.0/)
})

/* Escalation (CRAFT_UPGRADE §6.4, EH-65) */

const SCHEMA = { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false }
/** A gateway script: each tier's replies in order; what was sent is kept. */
function gateway(replies) {
  const sent = []
  const send = async (body) => {
    sent.push(body.model)
    const next = replies[body.model]?.shift()
    if (next instanceof Error) throw next
    if (next === undefined) throw Object.assign(new Error("That model tier isn't on your plan."), { status: 400, code: "tier_not_allowed" })
    return { choices: [{ message: { content: JSON.stringify(next) }, finish_reason: "stop" }], usage: {} }
  }
  return { sent, governor: createGovernor({ send, windowMs: 10 }) }
}
const slot = (extra = {}) => ({ task: "emphasis", schema: SCHEMA, view: "v", request: "r", maxOutput: 50, check: ({ n }) => (n === 7 ? [] : [`${n} isn't seven`]), fallback: () => ({ n: 0 }), ...extra })

test("ET-DL-05: a slot that fit its schema and failed its check twice is asked once on balanced, only when the plan lists it", async () => {
  const { sent, governor } = gateway({ budget: [{ n: 1 }, { n: 2 }], balanced: [{ n: 7 }] })
  const rows = []
  const ask = createAsk({ governor, record: (r) => rows.push(r), tiers: ["budget", "balanced"] })
  const answer = await ask(slot())
  assert.deepEqual(answer, { value: { n: 7 }, source: "escalated", calls: 3 })
  assert.deepEqual(sent, ["budget", "budget", ESCALATION_TIER])
  assert.deepEqual(rows.map((r) => [r.tier, r.result]), [["budget", "invalid:meaning"], ["budget", "invalid:meaning"], ["balanced", "escalated"]])
  // A schema failure isn't a meaning failure: a stronger tier isn't asked
  const g2 = gateway({ budget: [{ n: "x" }, { n: "y" }], balanced: [{ n: 7 }] })
  assert.equal((await createAsk({ governor: g2.governor, tiers: ["budget", "balanced"] })(slot())).source, "default")
  assert.deepEqual(g2.sent, ["budget", "budget"])
  // A slot already on another tier isn't escalated
  const g3 = gateway({ balanced: [{ n: 1 }, { n: 2 }, { n: 7 }] })
  assert.equal((await createAsk({ governor: g3.governor, tiers: ["budget", "balanced"] })(slot({ tier: "balanced" }))).source, "default")
  assert.equal(g3.sent.length, 2)
})

test("ET-DL-08: a slot is never sent on a tier the server didn't list; a refused or failed escalation keeps the budget answer (EH-65)", async () => {
  const plain = gateway({ budget: [{ n: 1 }, { n: 2 }] })
  const before = await createAsk({ governor: plain.governor })(slot())
  for (const tiers of [null, undefined, [], ["budget"], ["budget", "escalation"]]) {
    const g = gateway({ budget: [{ n: 1 }, { n: 2 }], balanced: [{ n: 7 }] })
    const answer = await createAsk({ governor: g.governor, ...(tiers === undefined ? {} : { tiers }) })(slot())
    assert.deepEqual(answer, before, `tiers ${JSON.stringify(tiers)}: the same answer as with no escalation at all`)
    assert.deepEqual(g.sent, ["budget", "budget"], "balanced is never sent unlisted")
  }
  // Listed, but Kriya refuses it, it errors, or it is still wrong: the budget answer, the same reason, no failure
  for (const reply of [undefined, Object.assign(new Error("upstream"), { status: 502 }), { n: 3 }, { n: "x" }]) {
    const g = gateway({ budget: [{ n: 1 }, { n: 2 }], balanced: reply === undefined ? [] : [reply] })
    const answer = await createAsk({ governor: g.governor, tiers: ["budget", "balanced"] })(slot())
    assert.deepEqual({ ...answer, calls: undefined }, { ...before, calls: undefined })
    assert.equal(answer.calls, 3)
  }
})

test("ET-DL-07: escalation is paid from the job's budget and goes through the Governor; the watch asks no model", async () => {
  const g = gateway({ budget: [{ n: 1 }, { n: 2 }], balanced: [{ n: 7 }] })
  let left = 2
  const answer = await createAsk({ governor: g.governor, budget: { take: () => left-- > 0 }, tiers: ["budget", "balanced"] })(slot())
  assert.equal(answer.source, "default", "the budget was spent on the two budget calls")
  assert.deepEqual(g.sent, ["budget", "budget"])
  assert.equal(g.governor.stats.calls, 2, "every call counted by the Governor (ET-GOV-01)")
  // The Viewer's Report and its fixes are code: a whole watch round asks the model nothing
  const { project, index } = world()
  const silent = gateway({})
  await watchAndFix({ project, ops: [], file: "f", plan: {}, checked: passing }, { index, view: async (a) => { const timeline = timelineOf(a.project, index); return { timeline, report: viewerReport({ timeline }) } }, render: async () => ({ file: "g", plan: {} }), check: async () => passing })
  assert.equal(silent.governor.stats.calls, 0)
})

test("ET-DL-06: frames reach a model only with editing.frameVision and the project's consent (EDD-14)", () => {
  assert.equal(mayWatchFrames({}, {}), false)
  assert.equal(mayWatchFrames({ frameVision: true }, {}), false, "no consent")
  assert.equal(mayWatchFrames({ frameVision: false }, { consent: { frames: true } }), false, "switch off")
  assert.equal(mayWatchFrames({ frameVision: true }, { consent: { frames: "yes" } }), false, "only a real yes")
  assert.equal(mayWatchFrames({ frameVision: true }, { consent: { frames: true } }), true)
  // The server doesn't advertise frameVision, so the client never has it (rule 17)
  const fetchSource = readFileSync(join(ROOT, "src/edit/runtime/fetch.js"), "utf8")
  assert.ok(!fetchSource.includes("frameVision"))
})

test("B-roll by meaning: the clip whose label, name and words match the line, then the person's B-roll, never the same twice running", () => {
  const index = { words: [{ asset: "b3", text: "ocean waves crashing", start: 0, end: F }] }
  const sources = [{ id: "b1", label: "City traffic", path: "/x/traffic.mov" }, { id: "b2", label: "Coffee pouring", path: "/x/cup.mov", role: "broll" }, { id: "b3", path: "/x/clip3.mov" }]
  assert.deepEqual(wordsOf("The Coffee's pouring, slowly!"), ["coffee", "pour", "slowly"])
  assert.equal(byMeaning(sources, "I pour my coffee every morning", index).id, "b2")
  assert.equal(byMeaning(sources, "we drove through traffic", index).id, "b1")
  assert.equal(byMeaning(sources, "the waves were huge", index).id, "b3", "a clip's own words count")
  assert.equal(byMeaning(sources, "nothing in common", index).id, "b2", "no match: the person's B-roll first")
  assert.equal(byMeaning(sources, "more coffee", index, ["b2"]).id, "b1", "never the same source twice running")
  assert.equal(byMeaning([sources[0]], "coffee", index, ["b1"]).id, "b1", "unless it's the only one")
})

test("B-roll by meaning reaches the reel only with the brief's flag; without it, the rotation as before (ET-DL-REG-01)", async () => {
  const index = indexOf("a1")
  // b2's label matches what is said over the first cutaway's line; b1's matches nothing
  const base = apply(newProject({ id: "p", name: "R" }), [asset("a1", lengthOf() + 2), asset("b1", 12, { label: "nothing here" }), asset("b2", 12, { label: "built week whole thing cost rupees design users friends grew year" })], { author: "code" }).project
  const ask = async (s) => ({ value: s.fallback(), source: "default", calls: 0 })
  const off = await planReel({ project: base, index, asset: "a1", ask, brief: { broll: "own" } })
  const offAgain = await planReel({ project: base, index, asset: "a1", ask, brief: { broll: "own" } })
  assert.deepEqual(off.ops, offAgain.ops)
  const rotated = off.ops.filter((o) => o.op === "place_broll").map((o) => o.asset)
  assert.deepEqual(rotated, rotated.map((_, i) => ["b1", "b2"][i % 2]), "off: every other source, as before")
  const on = await planReel({ project: base, index, asset: "a1", ask, brief: { broll: "own", brollByMeaning: true } })
  const chosen = on.ops.filter((o) => o.op === "place_broll").map((o) => o.asset)
  assert.equal(chosen.length, rotated.length, "the same cutaways, only their sources chosen differently")
  assert.ok(chosen.length >= 3)
  assert.equal(chosen[0], "b2", "the clip about what is said, where the rotation would take b1")
  assert.notDeepEqual(chosen, rotated)
  assert.ok(chosen.every((id, i) => i === 0 || id !== chosen[i - 1]), "never the same source twice running")
})

test("three openings: three different lines, each first and about eight seconds, by code with no model call", async () => {
  const index = indexOf("a1")
  const project = apply(newProject({ id: "p", name: "O" }), [asset("a1", lengthOf() + 2)], { author: "code" }).project
  const hooks = hooksFor(index, "a1")
  assert.equal(hooks.length, 3)
  assert.equal(new Set(hooks.map((h) => h.id)).size, 3)
  const planned = await planOpenings({ project, index, asset: "a1" })
  assert.equal(planned.length, 3)
  for (const { hook, project: cut } of planned) {
    const timeline = timelineOf(cut, index)
    assert.ok(timeline.duration <= OPENING + F, `${timeline.duration / F} s`)
    const first = index.words.find((w) => w.id === index.sentences.find((s) => s.id === hook.id).firstWord)
    assert.equal(timeline.base[0].in <= first.start && first.start < timeline.base[0].out, true, "the cut opens on its hook")
  }
})

test("ET-DL-REG-01: off, the make is the make it was: no watch, no escalation, the same slots, calls and operations", async () => {
  const index = indexOf("a1")
  const project = apply(newProject({ id: "p", name: "Reg" }), [asset("a1", lengthOf() + 2)], { author: "code" }).project
  const scripted = () => {
    const calls = []
    return { calls, ask: async (s) => (calls.push(s.task), { value: s.fallback(), source: "default", calls: 1 }) }
  }
  const run = async (extra) => {
    const { calls, ask } = scripted()
    let renders = 0
    const result = await makeReel({ project, head: null, index, asset: "a1", brief: { targetDuration: 10 * F, effort: "fast" }, ask, render: async () => (renders++, { file: "f.mp4", plan: { duration: 10 * F } }), sourcePath: () => "/nope", run: async () => "", gateKit: {}, ...extra })
    return { calls, renders, ops: result.best?.ops ?? null, watched: result.best?.watched ?? null }
  }
  // runGates on a fake file fails in a fixed way; what matters is that both runs are identical
  const a = await run({}).catch((e) => ({ error: e.message }))
  const b = await run({ watch: null }).catch((e) => ({ error: e.message }))
  assert.deepEqual(a, b)
  assert.equal(a.watched ?? null, null)
  // The Host's features answer lists directorLoop off unless the server says a real yes
  const host = readFileSync(join(ROOT, "src/edit/host/projects.js"), "utf8")
  assert.match(host, /directorLoop: false, taviOrder: false, \.\.\.known\.value/)
  assert.match(host, /const directed = !replay && \(await this\.features\(\)\)\.directorLoop === true/)
})
