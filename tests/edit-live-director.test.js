import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

import { commit, createLog } from "../src/edit/core/history.js"
import { apply } from "../src/edit/core/ops.js"
import { canonical, newProject } from "../src/edit/core/project.js"
import { createJobs } from "../src/edit/host/jobs.js"
import { gateRow, lastMadeEntry, layerOf, layersOf, LAYERS, liveFeed, viewOf } from "../src/edit/host/layers.js"
import { makeReel, rebase } from "../src/edit/loop/make.js"
import { ROOT } from "./helpers.js"
import { indexOf, lengthOf } from "./edit/script.js"

// "Watch the Director edit" (editing.livePreview): the make's real state as live previews, and the
// layer replay after it. No media, no model: the Director is the recipe's own fallbacks and the
// render a stand-in, so what's checked is what each event carries and that history is never touched.
// The real Studio draws them in tests/edit/media/live-preview.test.js.

const F = 705_600_000
const facts = (seconds) => ({ width: 640, height: 360, hasAudio: true, duration: Math.round(seconds * F), vfr: false, fps: { n: 30, d: 1 }, color: { primaries: "bt709", transfer: "bt709", range: "tv", tagged: true, hdr: false } })
const raw = () => apply(newProject({ id: "p", name: "Live" }), [{ op: "add_asset", id: "a1", kind: "video", fingerprint: "f-a1", path: "a1.mov", linked: true, rights: "own", facts: facts(lengthOf() + 2) }, { op: "add_asset", id: "m1", kind: "audio", fingerprint: "f-m1", path: "m1.wav", linked: true, rights: "own", facts: { duration: 60 * F, hasAudio: true } }], { author: "code" }).project
const ask = async (s) => ({ value: s.fallback(), source: "default", calls: 1 })
// A cut, then a grade on its first clip (a grade names its clip), music and a title
function opsFor(before, index) {
  const words = index.words.filter((w) => w.asset === "a1")
  const cut = { op: "keep_range", asset: "a1", from: words[0].start, to: words.at(-1).end }
  const clip = apply(before, [cut], { index }).project.sequences[0].clips[0].id
  return [cut, { op: "grade", clip, temperature: 5200 }, { op: "set_music", asset: "m1" }, { op: "add_title", text: "Fifty thousand", at: F, duration: 2 * F }]
}
const makeOnce = (project, index, extra = {}) =>
  makeReel({ project, head: null, index, asset: "a1", brief: { effort: "fast" }, ask, render: async () => ({ file: "f.mp4", plan: { duration: 10 * F } }), sourcePath: () => "/nope", run: async () => "", gateKit: {}, ...extra })

test("ET-LD-01: a make with onLive sends its plan, render and real gate results, and comes out exactly as one without it", async () => {
  const index = indexOf("a1")
  const project = raw()
  const before = canonical(project)
  const events = []
  const off = await makeOnce(project, index).catch((e) => ({ error: e.message }))
  const on = await makeOnce(project, index, { onLive: (e) => events.push(e) }).catch((e) => ({ error: e.message }))
  const shape = (r) => (r.error ? r : { ops: r.best?.ops ?? null, calls: r.calls, stop: r.outcome.stop, notes: r.notes })
  assert.deepEqual(shape(on), shape(off), "the live hook changes nothing the make does")
  assert.equal(canonical(project), before, "the starting cut is never mutated")
  const plans = events.filter((e) => e.stage === "plan")
  assert.ok(plans.length >= 1, "each candidate's plan is sent")
  assert.equal(plans[0].before, project, "from the cut the make started on")
  assert.ok(plans[0].ops.length > 0)
  const renders = events.filter((e) => e.stage === "render")
  const checks = events.filter((e) => e.stage === "check")
  assert.ok(renders.length >= 1 && checks.length >= 1, "a render and its gates")
  assert.ok(checks.every((c) => Array.isArray(c.gates) && c.gates.every((g) => /^QG-\d\d$/.test(g.id))), "gate results are the gates' own")
  // A hook that throws is ignored: the make goes on
  const thrown = await makeOnce(project, index, { onLive: () => { throw new Error("broken view") } }).catch((e) => ({ error: e.message }))
  assert.deepEqual(shape(thrown), shape(off))
})

test("ET-LD-02: layers apply the make's own operations in order, one group at a time; the last is the whole make", () => {
  const index = indexOf("a1")
  const before = raw()
  const ops = opsFor(before, index)
  assert.deepEqual(ops.map(layerOf), ["cuts", "look", "audio", "captions"])
  const layers = layersOf(before, ops, index)
  assert.deepEqual(layers.map((l) => l.id), LAYERS.map((l) => l.id))
  assert.equal(layers[0].project, before, "raw is the cut before the make")
  assert.deepEqual(layers.map((l) => l.ops), [0, 1, 0, 1, 1, 1])
  assert.equal(layers[2].project, layers[1].project, "a layer with nothing to do shows the one before")
  const whole = apply(before, ops, { index, author: "agent" })
  assert.ok(whole.applied)
  assert.equal(canonical(layers.at(-1).project), canonical(whole.project), "the last layer is exactly the make")
  const graded = (p) => JSON.stringify(p.sequences[0].clips[0]?.effects ?? []).includes('"grade"')
  assert.deepEqual(layers.map((l) => graded(l.project)), [false, false, false, true, true, true], "the look lands at its own layer")
  // A group that can't stand on its own is said, never forced: the layer shows the one before
  const broken = layersOf(before, [{ op: "set_music", asset: "missing" }], index)
  assert.match(broken.at(-1).skipped, /./)
  assert.equal(broken.at(-1).project, before)
})

test("ET-LD-03: the live feed sends previews and timelines for each layer, and never throws", () => {
  const index = indexOf("a1")
  const before = raw()
  const ops = opsFor(before, index).slice(0, 2)
  const sent = []
  const feed = liveFeed({ index, runtimeVersion: "9", tiles: new Map(), send: (e) => sent.push(e) })
  feed({ stage: "plan", before, ops, round: 1 })
  assert.deepEqual(sent.map((e) => e.stage), ["story", "cuts", "look"])
  assert.match(sent[0].text, /2 planned changes/)
  for (const e of sent.slice(1)) {
    assert.ok(e.preview?.picture && e.timeline?.picture, `${e.stage}: a preview and a timeline to draw`)
    assert.equal(typeof e.text, "string")
  }
  assert.deepEqual(sent[2].preview, viewOf(apply(before, ops, { index }).project, index, { runtimeVersion: "9", tiles: new Map() }).preview, "the look layer is the make's cut as previewOf draws it")
  feed({ stage: "check", gates: [{ id: "QG-01", status: "passed", severity: "block", numbers: { x: 1 }, failures: [] }, { id: "QG-06", status: "failed", severity: "block", message: "Too loud." }] })
  assert.equal(sent.at(-1).text, "Checked: 1 passed, 1 failed.")
  assert.deepEqual(sent.at(-1).gates, [{ id: "QG-01", status: "passed", severity: "block" }, { id: "QG-06", status: "failed", severity: "block", message: "Too loud." }], "only id, status, severity and the gate's own message")
  feed({ stage: "repair", attempts: [{ round: 1, accepted: true, fixes: [{ why: "Brought the music down 3 dB under the speech.", kind: "music_masks_speech" }] }] })
  assert.deepEqual(sent.at(-1).attempts[0].fixes, ["Brought the music down 3 dB under the speech."], "a repair is said in the ladder's own words")
  const count = sent.length
  assert.doesNotThrow(() => liveFeed({ index, runtimeVersion: "9", send: () => { throw new Error("closed") } })({ stage: "plan", before, ops }))
  assert.doesNotThrow(() => feed({ stage: "plan", before: null, ops: null }))
  assert.equal(sent.length, count, "a broken event sends nothing")
  assert.deepEqual(gateRow({ id: "QG-02", status: "passed", severity: "block", numbers: {}, message: "" }), { id: "QG-02", status: "passed", severity: "block" })
})

test("ET-LD-04: the person's edit during a live make lands, the make rebases onto it, and the live events wrote no history", async () => {
  const index = indexOf("a1")
  const project = raw()
  let log = createLog(project)
  let entriesSeen = []
  const made = await makeOnce(project, index, { onLive: () => entriesSeen.push(log.entries.length) }).catch(() => null)
  assert.ok(entriesSeen.length > 0 && entriesSeen.every((n) => n === 0), "no live event commits anything")
  if (!made?.best) return
  // Meanwhile the person trimmed the cut: HEAD moved, and the winner is rebased onto it, theirs kept
  const words = index.words.filter((w) => w.asset === "a1")
  const theirs = commit(log, { ops: [{ op: "keep_range", asset: "a1", from: words[0].start, to: words.at(-1).end }], author: "person", at: "t" }, { index })
  assert.ok(theirs.ok)
  log = theirs.log
  const { ops, dropped } = rebase(log.current, made.best.ops, index)
  assert.equal(ops.length + dropped.length, made.best.ops.length, "each operation lands or is listed, never forced")
  const landed = commit(log, { ops, author: "agent", at: "t2" }, { index })
  assert.ok(landed.ok)
  assert.equal(landed.log.entries.length, 2, "the person's entry and the make's one entry: Cmd+Z undoes the make alone")
  assert.equal(landed.log.entries[0].author, "person")
})

test("ET-LD-05: the replay finds the newest make still in history, never a person's entry", () => {
  const index = indexOf("a1")
  let log = createLog(raw())
  const words = index.words.filter((w) => w.asset === "a1")
  const agent = commit(log, { ops: [{ op: "keep_range", asset: "a1", from: words[0].start, to: words.at(-1).end }], author: "agent", at: "a" }, { index })
  log = agent.log
  const madeHead = log.head
  const person = commit(log, { ops: [{ op: "grade", clip: log.current.sequences[0].clips[0].id, temperature: 5200 }], author: "person", at: "b" }, { index })
  assert.ok(person.ok)
  log = person.log
  const rows = [
    { id: 1, kind: "make", dispatch: JSON.stringify({ head: madeHead }) },
    { id: 2, kind: "render", dispatch: "/x.mp4" },
    { id: 3, kind: "make", dispatch: JSON.stringify({ head: log.head }) }, // a person's entry: never replayed as a make
    { id: 4, kind: "make", dispatch: "not json" },
  ]
  const found = lastMadeEntry(rows, log)
  assert.equal(found.job, 1)
  assert.equal(found.entry.id, madeHead)
  assert.deepEqual(lastMadeEntry([], log), { entry: null, job: null })
})

test("ET-LD-06: the job sends each live event as `live`, with its job and project, beside its progress", async () => {
  const sent = []
  const state = { id: "0123456789abcdef", log: { head: null }, journal: fakeJournal() }
  const projects = { make: async (_s, _r, { onLive, onStep }) => (onStep(1, 2), onLive({ stage: "story", text: "Chose the story: 3 planned changes." }), { verdict: "delivered" }), features: async () => ({}) }
  const jobs = createJobs({ projects, emit: (event, data) => sent.push([event, data]), log: () => {} })
  jobs.start(state, { kind: "make", brief: {} })
  await new Promise((done) => setTimeout(done, 20))
  const live = sent.filter(([event]) => event === "live")
  assert.deepEqual(live, [["live", { job: `${state.id}.1`, project: state.id, stage: "story", text: "Chose the story: 3 planned changes." }]])
  assert.ok(sent.some(([event, data]) => event === "job" && data.status === "done"))
})

test("ET-LD-REG-01: off, the Host's make passes no live hook and the replay route answers 404", () => {
  const host = readFileSync(join(ROOT, "src/edit/host/projects.js"), "utf8")
  assert.match(host, /const watching = onLive && !replay && \(await this\.features\(\)\)\.livePreview === true/)
  assert.match(host, /\.\.\.\(onLiveMake \? \{ onLive: onLiveMake \} : \{\}\)/, "off, makeReel gets exactly the arguments it had")
  const server = readFileSync(join(ROOT, "src/edit/host/server.js"), "utf8")
  const route = server.slice(server.indexOf('parts[2] === "layers"'), server.indexOf('parts[2] === "tile-preview"'))
  assert.match(route, /if \(!\(await livePreviewOn\(\)\)\) return refuse\(res, 404/)
  assert.doesNotMatch(route, /change\(|commit\(|persist\(/, "the replay writes nothing")
})

function fakeJournal() {
  const rows = []
  return {
    addJob: ({ kind, projectVersion, request }) => (rows.push({ id: rows.length + 1, kind, project_version: projectVersion, status: "pending", progress: 0, request: JSON.stringify(request) }), rows.length),
    setJob: (id, fields) => Object.assign(rows[id - 1], fields),
    job: (id) => ({ ...rows[id - 1] }),
    jobs: () => rows.map((r) => ({ ...r })),
  }
}
