import assert from "node:assert/strict"
import { test } from "node:test"

import { apply } from "../src/edit/core/ops.js"
import { newProject } from "../src/edit/core/project.js"
import { solve } from "../src/edit/core/solver.js"
import { captionBand, checkDna, DNA_VERSION, paceFromDna, paceOf } from "../src/edit/engine/dna.js"
import { pictureChanges, planLongform, YOUTUBE_LONGFORM } from "../src/edit/recipes/youtube.js"
import { longTalk } from "./edit/talk.js"

// ED13 Edit DNA (EDITOR_WORKFLOWS §4, EDD-23): a reference gives numbers only. The
// shape is checked so no text, path or pixel can ride along; the pace curve carries
// into a cut of the person's own footage. The real reference video is measured in
// tests/edit/media/longform-reference.test.js.

const FLICKS = 705_600_000

const DNA = () => ({
  kind: "edit-dna",
  version: DNA_VERSION,
  seconds: 40,
  pace: { shots: 16, cutsPerMinute: 22.5, median: 4, p10: 1, p90: 4, curve: [1, 1, 4, 4, 4, 4, 4, 4, 4, 4] },
  structure: { firstCut: 1, lastShot: 4 },
  colour: { mean: [0.6, 0.01, 0.02], cov: [[0.02, 0, 0], [0, 0.001, 0], [0, 0, 0.001]], luma: Array(16).fill(1 / 16), contrast: 0.14, saturation: 0.05 },
  captions: { present: true, top: 0.8, bottom: 0.88, frames: 1 },
  sound: { lufs: -16, range: 6, truePeak: -1.2 },
})

test("EDD-23: an EditDNA is numbers only; text, a path or pixels are refused wherever they hide", () => {
  assert.doesNotThrow(() => checkDna(DNA()))
  assert.doesNotThrow(() => checkDna({ ...DNA(), colour: null, sound: null, captions: { present: false, top: null, bottom: null, frames: 0 } }))
  const sneak = [
    (d) => (d.title = "My favourite creator's video"),
    (d) => (d.pace.source = "/Users/me/ref.mp4"),
    (d) => (d.captions.text = "SUBSCRIBE NOW"),
    (d) => (d.colour.frame = [255, 0, 0, 255, 0, 0]),
    (d) => (d.colour.luma = [...d.colour.luma, 0]),
    (d) => (d.pace.median = "4"),
    (d) => (d.sound.lufs = Number.NaN),
    (d) => (d.kind = "frames"),
  ]
  for (const change of sneak) {
    const d = DNA()
    change(d)
    assert.throws(() => checkDna(d), RangeError)
  }
  assert.ok(JSON.stringify(DNA()).length < 1024, "small enough to read, too small to hold a picture")
})

test("pace: the spread of shot lengths and the median in each tenth of the running time", () => {
  const shots = [...Array(8)].map((_, i) => ({ start: i, length: 1 })).concat([...Array(8)].map((_, i) => ({ start: 8 + i * 4, length: 4 })))
  const pace = paceOf(shots, 40)
  assert.deepEqual([pace.shots, pace.median, pace.p10, pace.p90, pace.cutsPerMinute], [16, 4, 1, 4, 22.5])
  assert.deepEqual(pace.curve.slice(0, 2), [1, 1])
  assert.ok(pace.curve.slice(2).every((v) => v === 4 || v === null))
})

test("caption band: where bright, sharp text sits, as a share of the frame; nothing when there is none", () => {
  const [w, h] = [160, 90]
  const frame = (withText) => {
    const rgb = new Uint8Array(w * h * 3).fill(60)
    if (withText) for (let y = 72; y < 78; y++) for (let x = 40; x < 120; x++) if (x % 6 < 3) rgb.set([250, 250, 250], (y * w + x) * 3)
    return rgb
  }
  const frames = (n, withText) => {
    const all = new Uint8Array(w * h * 3 * n)
    for (let i = 0; i < n; i++) all.set(frame(withText), i * w * h * 3)
    return all
  }
  const band = captionBand(frames(6, true), w, h)
  assert.equal(band.present, true)
  assert.ok(Math.abs(band.top - 72 / 90) < 0.02 && Math.abs(band.bottom - 78 / 90) < 0.02, JSON.stringify(band))
  assert.deepEqual(captionBand(frames(6, false), w, h), { present: false, top: null, bottom: null, frames: 0 })
})

test("Edit DNA → a recipe's pace: the reference's median shot and its fast opening carry into a cut of the person's own talk", () => {
  const pace = paceFromDna(DNA())
  // A 1 s opening against a 4 s median is 0.25, held to the 0.3 a talk can carry
  assert.deepEqual(pace, { every: 4 * FLICKS, intro: 0.3, close: 1 })
  assert.throws(() => paceFromDna({ ...DNA(), pace: { ...DNA().pace, median: null, curve: Array(10).fill(null) } }), /too few shots/)

  const talk = longTalk(14, 5)
  const project = apply(newProject({ id: "p", name: "Talk" }), [{ op: "add_asset", id: "a1", kind: "video", fingerprint: "f", path: "/talk.mov", linked: true, rights: "own", facts: { width: 1920, height: 1080, hasAudio: true, duration: talk.duration, fps: { n: 30, d: 1 } } }], { author: "code" }).project
  const gapsOf = (recipe) => {
    const made = planLongform({ project, index: talk.index, asset: "a1", recipe })
    const timeline = solve(made.project, talk.index)
    const changes = pictureChanges(timeline)
    const gaps = changes.slice(1).map((t, i) => ({ at: changes[i], length: t - changes[i] }))
    const intro = made.chapters[1].at
    return { all: gaps.map((g) => g.length), intro: gaps.filter((g) => g.at + g.length <= intro + FLICKS).map((g) => g.length) }
  }
  const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)]
  const own = gapsOf(YOUTUBE_LONGFORM)
  const like = gapsOf({ ...YOUTUBE_LONGFORM, pace })
  // The reference holds a picture 4 s, 1 s in its opening: the new cut changes faster than the recipe's own, and faster still in the intro
  assert.ok(median(like.all) < median(own.all), `median gap ${median(like.all) / FLICKS} s, against ${median(own.all) / FLICKS} s`)
  assert.ok(Math.max(...like.all) <= 4 * FLICKS + 2 * FLICKS, `longest ${Math.max(...like.all) / FLICKS} s`)
  assert.ok(median(like.intro) < median(like.all), `intro ${median(like.intro) / FLICKS} s against ${median(like.all) / FLICKS} s`)
  assert.ok(Math.max(...like.intro) <= 1 * FLICKS + 2 * FLICKS, `intro longest ${Math.max(...like.intro) / FLICKS} s`)
})

test("ET-SEC-08: a reference asset can't be placed on a track, and QG-13 fails an output it was forced into", async () => {
  const { runGates } = await import("../src/edit/gates/index.js")
  const { compile } = await import("../src/edit/core/plan.js")
  const facts = { width: 1920, height: 1080, hasAudio: true, duration: 10 * FLICKS, fps: { n: 30, d: 1 } }
  const project = apply(newProject({ id: "p", name: "P" }), [
    { op: "add_asset", id: "a1", kind: "video", fingerprint: "f1", path: "/take.mov", linked: true, rights: "own", facts },
    { op: "add_asset", id: "r1", kind: "reference", fingerprint: "f2", path: "/theirs.mp4", linked: true, rights: "unknown", facts },
  ], { author: "code" }).project
  for (const op of [{ op: "keep_range", asset: "r1", from: 0, to: FLICKS }, { op: "place_broll", asset: "r1", at: 0, out: FLICKS }]) {
    const step = apply(project, [{ op: "keep_range", asset: "a1", from: 0, to: 2 * FLICKS }, op])
    assert.equal(step.applied, false, op.op)
  }
  // Forced past the operations (a hand-edited project file): the gate still catches it
  const forced = structuredClone(apply(project, [{ op: "keep_range", asset: "a1", from: 0, to: 2 * FLICKS }]).project)
  forced.sequences[0].clips[0].source.asset = "r1"
  const plan = compile(forced, {}, { engineVersion: "t", runtimeVersion: "t" })
  const result = await runGates({ file: "/none.mp4", plan, project: forced, index: {}, sourcePath: () => "/none", only: ["QG-13"] })
  const qg13 = result.gates.find((g) => g.id === "QG-13")
  assert.equal(qg13.status, "failed")
  assert.match(qg13.message, /reference \(r1\) is in this output/)
})

test("ET-SEC-07: no operation or pack makes a synthetic person or a cloned voice, and nothing generative exists to switch on", async () => {
  const { OPERATIONS } = await import("../src/edit/core/ops.js")
  const { PACKS } = await import("../src/edit/engine/packs.js")
  const banned = /lip|face_?swap|clone|deepfake|avatar|synth|generat|tts|narrat|voice_?over/i
  assert.deepEqual(OPERATIONS.filter((op) => banned.test(op)), [])
  assert.deepEqual(Object.entries(PACKS).filter(([id, pack]) => banned.test(id) || pack.ops.some((op) => banned.test(op))).map(([id]) => id), [])
})
