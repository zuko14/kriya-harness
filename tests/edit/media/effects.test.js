import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"

import { EFFECTS, gateOf } from "../../../src/edit/core/effects.js"
import { apply } from "../../../src/edit/core/ops.js"
import { readCapabilities } from "../../../src/edit/engine/capabilities.js"
import { createEngine } from "../../../src/edit/engine/index.js"
import { probe } from "../../../src/edit/engine/probe.js"
import { healthArgs, judgeHealth, readHealth } from "../../../src/edit/gates/picture.js"
import { openJournal } from "../../../src/edit/graph/journal.js"
import { makeProject, ms } from "../fixture.js"
import { barcodeVideo, H, readBarcodes, W } from "./barcode.js"

// ET-FX-M1 (CRAFT_UPGRADE §3.6): every registry row over one second of a three-second cut, with the
// real FFmpeg on frame-barcoded footage: the same number of frames; every frame outside it the frame
// it was; frames inside it changed; the same decoded frames twice; the health gate quiet. Then a clip's
// own effect, a keyframed one, a named move and the stabilize every older project may hold.

const FLICKS = 705_600_000
const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-fx-")))
const grey = join(dir, "barcode.mov")
// The barcode in colour, so a colour effect has colour to change: bright bars orange (still read as 1), dark ones near black
const source = join(dir, "colour.mov")
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex")
const WANTED = Array.from({ length: 90 }, (_, i) => i)
const [FROM, TO] = [30, 60] // the effect's frames
let capabilities

before(async () => {
  capabilities = await readCapabilities()
  await barcodeVideo(grey, { frames: 120 })
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", grey, "-vf", "format=rgb24,lutrgb=r=val:g=val*0.7:b=val*0.3,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv", "-c:v", "libx264", "-crf", "12", "-g", "15", "-c:a", "copy", "-y", source])
})

async function render(ops) {
  const root = realpathSync(mkdtempSync(join(dir, "p-")))
  const { facts } = await probe(source)
  const project = structuredClone(makeProject())
  project.canvas = { ...project.canvas, width: W, height: H }
  project.assets = [{ ...project.assets[0], id: "a1", path: source, fingerprint: sha(source), facts }]
  const made = apply(project, [{ op: "keep_range", asset: "a1", from: 0, to: ms(3000) }, ...ops], { author: "person" })
  assert.deepEqual(made.diagnostics, [])
  const engine = createEngine({ folder: root, roots: [root, dir], cache: join(root, "cache"), exports: join(root, "exports"), journal: openJournal(":memory:"), toolVersion: "9", capabilities })
  engine.load(made.project, {})
  return engine.render({ quality: "draft" })
}
// A frame at full size, RGB: an edge-only effect (sharpen) is invisible in a thumbnail, a colour one in grey
const full = (file, n) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", `select=eq(n\\,${n}),format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "pipe:1"], { maxBuffer: 1 << 24 })
const meanApart = (a, b) => a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) / a.length
// The share of pixels moved by more than 8 levels (an encode alone moves under 4)
const moved = (a, b) => a.reduce((sum, value, i) => sum + (Math.abs(value - b[i]) > 8 ? 1 : 0), 0) / a.length
const frames = (file) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-map", "0:v", "-f", "framemd5", "-"], { maxBuffer: 1 << 26 }).toString().split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").at(-1).trim())
const count = (file) => Number(JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "json", file])).streams[0].nb_read_frames)

test("ET-FX-M1: every registry row: frame count, untouched outside, changed inside, the same frames twice, the health gate quiet", { timeout: 280_000 }, async () => {
  const plain = (await render([])).file
  assert.deepEqual(readBarcodes(plain), WANTED)
  const results = []
  for (const id of Object.keys(EFFECTS)) {
    // TP9: a row that acts only round a drawn region (mask) is given one, the frame's left half
    const ops = [{ op: "add_adjustment", at: ms(1000), duration: ms(1000), effect: id, ...(EFFECTS[id].needsRegion ? { region: { x: 0, y: 0, w: 500, h: 1000 } } : {}) }]
    const { file, plan } = await render(ops)
    const again = (await render(ops)).file
    assert.equal(count(file), WANTED.length, `${id}: frame count`)
    const read = readBarcodes(file)
    assert.deepEqual([...read.slice(0, FROM), ...read.slice(TO)], [...WANTED.slice(0, FROM), ...WANTED.slice(TO)], `${id}: every frame outside it is the frame it was`)
    // Where the effect is fully on (a flash is at its start), against the encode's own noise on an untouched frame:
    // an edge effect moves few pixels a lot (sharpen), a texture many a little (grain); either far beyond the noise
    const probe = id === "flash" ? FROM + 1 : FROM + 15
    const [a, b, c, d] = [full(file, probe), full(plain, probe), full(file, 80), full(plain, 80)]
    const [share, noise] = [moved(a, b), moved(c, d)]
    const [mad, quiet] = [meanApart(a, b), meanApart(c, d)]
    assert.ok(share > Math.max(0.005, 5 * noise) || mad > Math.max(0.5, 3 * quiet), `${id}: frame ${probe} changed (${(share * 100).toFixed(2)} % of pixels, ${mad.toFixed(2)} levels on average; ${(noise * 100).toFixed(2)} %, ${quiet.toFixed(2)} on an untouched frame)`)
    const changed = `${(share * 100).toFixed(1)}%/${mad.toFixed(1)}`
    assert.deepEqual(frames(again), frames(file), `${id}: the same decoded frames twice`)
    const ran = spawnSync("ffmpeg", healthArgs(file), { encoding: "utf8", maxBuffer: 1 << 26 })
    const window = { at: ms(1000), end: ms(2000) }
    const faults = judgeHealth(readHealth(`${ran.stdout}\n${ran.stderr}`), { duration: plan.duration, fps: plan.output.fps, holds: [], cuts: [], transitions: gateOf(id) === "flash" ? [window] : [] }, { exposureJump: 40 }).failures
    // Frame 0 of this fixture is barcode 0, every bar dark: its own black, in the plain render too
    assert.deepEqual(faults.filter((f) => f.severity === "block" && f.t > 0), [], `${id}: ${JSON.stringify(faults)}`)
    results.push(`${id} ${changed}`)
  }
  console.log(`ET-FX-M1 pixels moved at a frame inside the effect: ${results.join(", ")}`)
})

test("ET-FX-M1: a clip's own effect, a keyframed one, a named move and a stored stabilize all render whole", { timeout: 280_000 }, async () => {
  const clip = "c1"
  for (const ops of [
    [{ op: "add_effect", clip, effect: "grain" }],
    [{ op: "add_effect", clip, effect: "vignette", keys: [{ param: "strength", points: [{ at: 0, value: 0, ease: "inOut" }, { at: ms(3000), value: 1 }] }] }],
    [{ op: "add_effect", clip, effect: "blackWhite", move: "drain" }],
    [{ op: "stabilize", clip }],
  ]) {
    const { file, plan } = await render(ops)
    assert.equal(count(file), WANTED.length, JSON.stringify(ops))
    assert.equal(plan.issues.some((i) => i.code === "effect_unavailable"), false)
  }
})
