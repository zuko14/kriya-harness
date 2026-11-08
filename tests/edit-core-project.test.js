import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { hashProject, migrate, parseProject, SCHEMA, serialize, SHAPES, validateProject } from "../src/edit/core/project.js"
import { makeProject, ms } from "./edit/fixture.js"

const clip = (over = {}) => ({
  id: "c1",
  track: "t-base",
  source: { asset: "a1", in: 0, out: ms(1000) },
  at: null,
  effects: [],
  speed: { n: 1, d: 1 },
  createdBy: "agent",
  ...over,
})

const refused = (change, pattern) => {
  const project = makeProject()
  change(project)
  const errors = validateProject(project)
  assert.ok(errors.length > 0, "should have been refused")
  assert.match(errors.map((e) => `${e.path}: ${e.reason}`).join("\n"), pattern)
}

test("ET-CORE-03: a valid project passes and survives serialization", () => {
  const project = makeProject()
  project.sequences[0].clips.push(clip())
  project.sequences[0].markers.push({ id: "m1", name: "hook", at: { word: "a1:w3", edge: "start" } })
  project.brief = { format: "reel", targetDuration: ms(30000), mustKeep: [], mustCut: [], effort: "fast" }
  project.deliverables.push({ id: "d1", preset: "reel", size: { width: 1080, height: 1920 }, fps: { n: 30, d: 1 }, codec: "h264", audio: "aac", loudness: { lufs: -14, tp: -1 }, burnCaptions: true, gates: [] })
  assert.deepEqual(validateProject(project), [])
  const parsed = parseProject(serialize(project))
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.project, project)
})

test("ET-CORE-03: each invalid shape is refused with a reason", () => {
  refused((p) => delete p.id, /id: is required/)
  refused((p) => (p.extra = 1), /extra: is not a field/)
  refused((p) => (p.canvas.width = -1), /canvas\.width: /)
  refused((p) => (p.canvas.fps = 29.97), /canvas\.fps: .*rational/)
  refused((p) => (p.canvas.fps = { n: 30, d: 0 }), /canvas\.fps: /)
  refused((p) => (p.assets[0].kind = "hologram"), /assets\[0\]\.kind: must be one of/)
  refused((p) => (p.assets[0].rights = "probably"), /rights/)
  refused((p) => (p.active = "nope"), /active: no sequence/)
  refused((p) => p.assets.push({ ...p.assets[0] }), /duplicate id "a1"/)
  refused((p) => p.sequences[0].tracks.push({ ...p.sequences[0].tracks[0], role: "drums", id: "t2" }), /role/)
  refused((p) => p.sequences[0].clips.push(clip({ track: "nope" })), /no track "nope"/)
  refused((p) => p.sequences[0].clips.push(clip({ source: { asset: "nope", in: 0, out: 1 } })), /no asset "nope"/)
  refused((p) => p.sequences[0].clips.push(clip({ at: { song: "x" } })), /anchor/)
  refused((p) => p.sequences[0].clips.push(clip({ effects: [{ type: "sparkle" }] })), /effect/)
  refused((p) => p.sequences[0].clips.push(clip({ effects: [{ type: "zoom", scale: 1.1, ease: "snap", shell: "rm" }] })), /shell: is not a field/)
  refused((p) => (p.nextId = 0), /nextId/)
})

test("ET-CORE-01: a float time is refused everywhere a time can sit", () => {
  refused((p) => (p.assets[0].facts.duration = 1.5), /facts\.duration: .*whole flicks/)
  refused((p) => p.sequences[0].clips.push(clip({ source: { asset: "a1", in: 0.25, out: ms(1000) } })), /source\.in: .*whole flicks/)
  refused((p) => p.sequences[0].clips.push(clip({ at: 2.5 })), /\.at: .*whole flicks/)
  refused((p) => p.sequences[0].clips.push(clip({ duration: 0.5 })), /duration/)
  refused((p) => p.sequences[0].clips.push(clip({ at: { clip: "c0", edge: "end", offset: 0.1 } })), /offset/)
  refused((p) => p.sequences[0].markers.push({ id: "m", name: "x", at: 1.25 }), /at/)
  refused((p) => (p.brief = { format: "reel", targetDuration: 30.5, mustKeep: [], mustCut: [], effort: "fast" }), /targetDuration/)
})

test("ET-CORE-01: no field the schema calls a time is typed as a decimal", () => {
  const TIME = /^(at|in|out|until|duration|offset|start|end|peak|targetDuration|attack|release|audioLead|audioLag)\??$/
  const walk = (spec, path) => {
    if (spec === "num") return [path]
    if (typeof spec !== "object" || spec === null) return []
    if (spec.list) return walk(spec.list, path)
    if (spec.nullable) return walk(spec.nullable, path)
    if (spec.enum) return []
    return Object.entries(spec).flatMap(([k, v]) => (TIME.test(k) ? walk(v, `${path}.${k}`) : []))
  }
  assert.deepEqual(Object.entries(SHAPES).flatMap(([k, v]) => walk(v, k)), [])
})

test("ET-CORE-03: a newer schema is refused whole, with a plain message", () => {
  const text = JSON.stringify({ ...makeProject(), schema: SCHEMA + 1 })
  const result = parseProject(text)
  assert.equal(result.ok, false)
  assert.equal(result.project, undefined, "never partly read")
  assert.match(result.errors[0].reason, /newer version of Kriya/)
})

test("ET-CORE-03: text that isn't JSON or isn't a project is refused", () => {
  assert.equal(parseProject("{").ok, false)
  assert.equal(parseProject("[]").ok, false)
  assert.equal(parseProject("null").ok, false)
  assert.equal(parseProject('{"schema":"1"}').ok, false)
})

test("serialize is canonical: key order can't change bytes or hash", () => {
  const a = makeProject()
  const b = JSON.parse(JSON.stringify(a), (_, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v))
  assert.equal(serialize(a), serialize(b))
  assert.equal(hashProject(a), hashProject(b))
  assert.match(hashProject(a), /^[0-9a-f]{64}$/)
})

test("the hash covers decisions, not where HEAD happens to be", () => {
  const a = makeProject()
  const moved = { ...a, head: "v9", history: [{ id: "v9", parent: null, author: "code", opsRange: [0, 0], hash: "x", at: "2026-11-07T00:00:00Z" }] }
  assert.deepEqual(validateProject(moved), [])
  assert.equal(hashProject(a), hashProject(moved))
  assert.notEqual(hashProject(a), hashProject({ ...a, name: "Other" }))
})

test("ET-CORE-04: the v1 golden file loads unchanged; a migration runs in order and is pure", () => {
  const golden = readFileSync(new URL("./edit/project-v1.golden.json", import.meta.url), "utf8")
  const result = parseProject(golden)
  assert.deepEqual(result.errors, [])
  assert.equal(serialize(result.project), golden)

  // Schema 1 is the first, so no real migration exists yet: this pins the mechanism
  const steps = { 0: (doc) => ({ ...doc, schema: 1, name: doc.title, title: undefined }) }
  const old = Object.freeze({ schema: 0, title: "Old" })
  assert.deepEqual(migrate(old, steps), { schema: 1, name: "Old", title: undefined })
  assert.equal(old.title, "Old")
  assert.throws(() => migrate({ schema: -1 }, steps), /no migration/)
})
