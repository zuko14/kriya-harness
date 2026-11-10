import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"

import { apply } from "../../../src/edit/core/ops.js"
import { TRANSITIONS } from "../../../src/edit/core/transitions.js"
import { readCapabilities } from "../../../src/edit/engine/capabilities.js"
import { createEngine } from "../../../src/edit/engine/index.js"
import { probe } from "../../../src/edit/engine/probe.js"
import { judgeHealth, readHealth, healthArgs } from "../../../src/edit/gates/picture.js"
import { openJournal } from "../../../src/edit/graph/journal.js"
import { makeProject, ms } from "../fixture.js"
import { barcodeVideo, H, readBarcodes, W } from "./barcode.js"

// Transitions with the real FFmpeg on frame-barcoded footage: the cut doesn't move by a frame,
// every frame outside the transition is the frame it was, and inside it both clips are in the picture.

const FLICKS = 705_600_000
const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-transitions-")))
const source = join(dir, "barcode.mov")
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex")
// Three pieces of one take: frames 0–59, 150–194, 270–419
const CUTS = [
  { op: "keep_range", asset: "a1", from: 0, to: ms(2000) },
  { op: "keep_range", asset: "a1", from: ms(5000), to: ms(6500) },
  { op: "keep_range", asset: "a1", from: ms(9000), to: ms(14000) },
]
const WANTED = [...Array.from({ length: 60 }, (_, i) => i), ...Array.from({ length: 45 }, (_, i) => 150 + i), ...Array.from({ length: 150 }, (_, i) => 270 + i)]
const SECOND_CUT = 105 // the output frame the third piece starts on
const LENGTH = 9 // frames of a 0.3 s transition at 30 fps

let capabilities
before(async () => {
  capabilities = await readCapabilities()
  await barcodeVideo(source, { frames: 450 })
})

async function world(extra = []) {
  const root = realpathSync(mkdtempSync(join(dir, "p-")))
  const { facts } = await probe(source)
  const project = structuredClone(makeProject())
  project.canvas = { ...project.canvas, width: W, height: H }
  project.assets = [{ ...project.assets[0], id: "a1", path: source, fingerprint: sha(source), facts }]
  const cut = apply(project, CUTS)
  assert.deepEqual(cut.diagnostics, [])
  const third = cut.project.sequences[0].clips.filter((c) => c.source).at(-1).id
  const done = apply(cut.project, extra.map((op) => ({ ...op, clip: third })))
  assert.deepEqual(done.diagnostics, [])
  const log = []
  const engine = createEngine({ folder: root, roots: [root, dir], cache: join(root, "cache"), exports: join(root, "exports"), journal: openJournal(":memory:"), toolVersion: "9", capabilities, onTool: (command, args) => log.push([command, ...args]) })
  engine.load(done.project, {})
  return { engine, log, project: done.project, third }
}

/** One output frame as grey bytes, small. */
const frame = (file, n) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", `select=eq(n\\,${n}),scale=64:36,format=gray`, "-frames:v", "1", "-f", "rawvideo", "pipe:1"], { maxBuffer: 1 << 20 })
const apart = (a, b) => a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) / a.length

test("ET-TR-M1: each kind, as a draft: the same frames outside the transition, both clips inside it, not one frame longer", { timeout: 280_000 }, async () => {
  const plain = await world()
  const reference = (await plain.engine.render({ quality: "draft" })).file
  assert.deepEqual(readBarcodes(reference), WANTED)
  const held = frame(reference, SECOND_CUT - 1) // the outgoing piece's last frame
  for (const kind of Object.keys(TRANSITIONS)) {
    const w = await world([{ op: "transition", kind, duration: ms(300) }])
    const { file, plan } = await w.engine.render({ quality: "draft" })
    const read = readBarcodes(file)
    assert.equal(read.length, WANTED.length, `${kind}: the cut is as long as it was`)
    assert.deepEqual(read.slice(0, SECOND_CUT), WANTED.slice(0, SECOND_CUT), `${kind}: nothing before the cut changed`)
    assert.deepEqual(read.slice(SECOND_CUT + LENGTH), WANTED.slice(SECOND_CUT + LENGTH), `${kind}: after the transition every frame is the frame it was`)
    const middle = frame(file, SECOND_CUT + 4)
    assert.ok(apart(middle, frame(reference, SECOND_CUT + 4)) > 2, `${kind}: mid-transition isn't the plain incoming frame`)
    assert.ok(apart(middle, held) > 2, `${kind}: nor the held frame alone`)
    // And the first frame after it is the incoming clip, pixel for pixel as near as two encodes agree
    assert.ok(apart(frame(file, SECOND_CUT + LENGTH), frame(reference, SECOND_CUT + LENGTH)) < 2, `${kind}: it ends on the incoming clip`)
    assert.equal(plan.segments.filter((s) => s.node.picture.some((p) => p.enter)).length, 1, `${kind}: one segment carries it`)
    // The health gate reads the real file: a dip's black and the held frame aren't faults
    const ran = spawnSync("ffmpeg", healthArgs(file), { encoding: "utf8", maxBuffer: 1 << 26 })
    const health = readHealth(`${ran.stdout}\n${ran.stderr}`)
    assert.ok(health.luma.length >= WANTED.length - 1, `${kind}: the health pass read the file`)
    const at = (SECOND_CUT * FLICKS) / 30
    const faults = judgeHealth(health, { duration: plan.duration, fps: plan.output.fps, holds: [{ at, end: at + ms(300) }], cuts: [], transitions: [{ at, end: at + ms(300) }] }, { exposureJump: 40 }).failures
    // Frame 0 of this fixture is barcode 0, every bar dark: its own black, in the plain render too
    assert.deepEqual(faults.filter((f) => f.severity === "block" && f.t > 0), [], `${kind}: ${JSON.stringify(faults)}`)
  }
})

test("ET-TR-M2: a master draws the same transition in its one encode, from the sources", { timeout: 280_000 }, async () => {
  const w = await world([{ op: "transition", kind: "slide", duration: ms(300) }])
  const { file } = await w.engine.render({ quality: "master" })
  const read = readBarcodes(file)
  assert.equal(read.length, WANTED.length)
  assert.deepEqual(read.slice(0, SECOND_CUT), WANTED.slice(0, SECOND_CUT))
  assert.deepEqual(read.slice(SECOND_CUT + LENGTH), WANTED.slice(SECOND_CUT + LENGTH))
  assert.equal(w.log.filter(([, ...args]) => args.includes("-an") && args.includes("-filter_complex")).length, 1, "one continuous encode")
  assert.ok(w.log.some(([, ...args]) => args.some((arg) => /xfade=transition=slideleft/.test(arg))))
})

test("ET-TR-M3: only the segment a transition is in renders again", { timeout: 280_000 }, async () => {
  const w = await world()
  await w.engine.render({ quality: "draft" })
  const renders = () => w.log.filter(([, ...args]) => args.includes("-filter_complex") && args.includes("-an")).length
  const first = renders()
  w.engine.load(apply(w.project, [{ op: "transition", clip: w.third, kind: "fade", duration: ms(300) }]).project, {})
  const { file } = await w.engine.render({ quality: "draft" })
  assert.equal(renders() - first, 1, "one segment")
  assert.equal(readBarcodes(file).length, WANTED.length)
})
