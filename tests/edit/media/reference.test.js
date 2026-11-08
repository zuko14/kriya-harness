import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { apply } from "../../../src/edit/core/ops.js"
import { newProject } from "../../../src/edit/core/project.js"
import { solve } from "../../../src/edit/core/solver.js"
import { readCapabilities } from "../../../src/edit/engine/capabilities.js"
import { balanceOps, cubeText, measureColour, offAgainst } from "../../../src/edit/engine/color.js"
import { checkDna, extractDna, paceFromDna } from "../../../src/edit/engine/dna.js"
import { createEngine } from "../../../src/edit/engine/index.js"
import { probe } from "../../../src/edit/engine/probe.js"
import { openJournal } from "../../../src/edit/graph/journal.js"
import { ensureHost, hostCall, stopHost } from "../../../src/edit/host/client.js"
import { pictureChanges, planLongform, YOUTUBE_LONGFORM } from "../../../src/edit/recipes/youtube.js"
import { longTalk } from "../talk.js"

// ED13 on the real FFmpeg. A synthetic reference (fast cuts first, a caption band, a
// tone) is measured into an EditDNA of numbers only, and its pace carried into a cut
// of another talk. Two takes of one scene, one dark and warm, are matched through a
// master render until the eye can't tell them apart; a LUT colours a master; the Host
// takes a .cube as a LUT and refuses a broken one. No real footage.

const FLICKS = 705_600_000
const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-reference-")))
const ffmpeg = (...args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 })
const X264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"]
async function sha(file) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}
async function videoOp(file, id) {
  const { facts } = await probe(file)
  return { op: "add_asset", id, kind: "video", fingerprint: await sha(file), path: file, linked: true, rights: "own", facts }
}
async function engineFor(project, index = {}) {
  const root = realpathSync(mkdtempSync(join(dir, "p-")))
  const engine = createEngine({ folder: root, roots: [root, dir], cache: join(root, "cache"), exports: join(root, "exports"), journal: openJournal(":memory:"), toolVersion: "9", capabilities: await readCapabilities() })
  engine.load(project, index)
  return engine
}

// Shots of clearly different brightness, so FFmpeg's scene detector (L6) sees every cut
const SHADES = ["0xF0F0F0", "0x202020", "0xD04020", "0x103060", "0xF0E060", "0x302010", "0x80C0F0", "0x400040"]

test("Edit DNA: a real reference becomes numbers only, and its pace carries into a cut of the person's own talk (EDD-23)", { timeout: 280_000 }, async () => {
  const lengths = [...Array(8).fill(1), ...Array(8).fill(4)]
  const reference = join(dir, "reference.mp4")
  const letters = Array.from({ length: 16 }, (_, k) => `drawbox=x=${150 + k * 22}:y=294:w=14:h=20:color=white:t=fill`).join(",")
  ffmpeg(
    ...lengths.flatMap((d, i) => ["-f", "lavfi", "-i", `color=c=${SHADES[i % 8]}:s=640x360:r=30:d=${d}`]),
    "-f", "lavfi", "-i", "sine=f=220:d=40",
    "-filter_complex", `${lengths.map((_, i) => `[${i}:v]noise=alls=6:allf=t,drawbox=x=130:y=286:w=380:h=36:color=black:t=fill,${letters}[v${i}]`).join(";")};${lengths.map((_, i) => `[v${i}]`).join("")}concat=n=${lengths.length}:v=1:a=0[v]`,
    "-map", "[v]", "-map", `${lengths.length}:a`, ...X264, "-c:a", "aac", "-shortest", reference,
  )
  const dna = await extractDna(reference)
  console.log(`ED13 Edit DNA (${JSON.stringify(dna).length} bytes): ${JSON.stringify({ pace: dna.pace, structure: dna.structure, captions: dna.captions, sound: dna.sound })}`)
  assert.equal(checkDna(dna), dna)
  assert.ok(JSON.stringify(dna).length < 1024)
  assert.doesNotMatch(JSON.stringify(dna), /reference|\.mp4|\//, "no name or path of the reference")
  assert.ok(dna.pace.shots >= 14 && dna.pace.shots <= 16, `${dna.pace.shots} shots`)
  assert.equal(dna.pace.median, 4)
  assert.ok(dna.pace.curve[0] <= 1.5 && dna.pace.curve[9] >= 3, JSON.stringify(dna.pace.curve))
  assert.ok(Math.abs(dna.seconds - 40) < 0.2)
  assert.deepEqual([dna.captions.present, dna.captions.top >= 0.78 && dna.captions.bottom <= 0.92], [true, true], JSON.stringify(dna.captions))
  assert.ok(dna.sound.lufs < -10 && dna.sound.lufs > -40, `${dna.sound.lufs} LUFS`)

  // The pace, carried into a 14-minute talk: faster than the recipe's own, and fastest at the start
  const pace = paceFromDna(dna)
  const talk = longTalk(14, 5)
  const project = apply(newProject({ id: "p", name: "Talk" }), [{ op: "add_asset", id: "a1", kind: "video", fingerprint: "f", path: "/talk.mov", linked: true, rights: "own", facts: { width: 1920, height: 1080, hasAudio: true, duration: talk.duration, fps: { n: 30, d: 1 } } }], { author: "code" }).project
  const gaps = (recipe) => {
    const made = planLongform({ project, index: talk.index, asset: "a1", recipe })
    const changes = pictureChanges(solve(made.project, talk.index))
    return changes.slice(1).map((t, i) => t - changes[i]).sort((a, b) => a - b)
  }
  const [own, like] = [gaps(YOUTUBE_LONGFORM), gaps({ ...YOUTUBE_LONGFORM, pace })]
  const median = (list) => list[Math.floor(list.length / 2)]
  console.log(`ED13 pace carried over: every ${(pace.every / FLICKS).toFixed(1)} s, intro ×${pace.intro}; median gap ${(median(like) / FLICKS).toFixed(1)} s against the recipe's ${(median(own) / FLICKS).toFixed(1)} s`)
  assert.ok(median(like) < median(own))
  assert.ok(like.at(-1) <= pace.every + 2 * FLICKS, `longest ${(like.at(-1) / FLICKS).toFixed(1)} s`)
})

/** One scene: a grey ramp with coloured patches and a moving box, over light noise. */
function scene(file, seconds, grade = null) {
  const patches = [["0xC83C3C", 80], ["0x3CB43C", 260], ["0x3C50C8", 440], ["0xDCB48C", 620]].map(([c, x]) => `drawbox=x=${x}:y=420:w=140:h=120:color=${c}:t=fill`).join(",")
  const graph = `[0:v]geq=lum='40+180*X/W':cb=128:cr=128,format=yuv420p,noise=alls=3:allf=t,${patches}[s];color=c=white:s=60x60:r=30[b];[s][b]overlay=x='100+500*abs(sin(t/2))':y=120:shortest=1${grade ? `,${grade}` : ""}[v]`
  ffmpeg("-f", "lavfi", "-i", `color=c=black:s=960x540:r=30:d=${seconds}`, "-filter_complex", graph, "-map", "[v]", ...X264, file)
}

test("colour match: a dark, warm take of the same scene is matched through a master render until it is no longer off (EDITOR_WORKFLOWS §6)", { timeout: 280_000 }, async () => {
  const [good, warm] = [join(dir, "good.mov"), join(dir, "warm.mov")]
  scene(good, 6)
  scene(warm, 6, "eq=brightness=-0.10:gamma=0.85,colorbalance=rm=0.12:gm=0.02:bm=-0.12:rh=0.08:bh=-0.08")
  const assets = [await videoOp(good, "a1"), await videoOp(warm, "a2")]
  const cut = apply(newProject({ id: "c", name: "Colour", width: 960, height: 540 }), [...assets, { op: "keep_range", asset: "a1", from: 0, to: 4 * FLICKS }, { op: "keep_range", asset: "a2", from: 0, to: 4 * FLICKS }, { op: "add_deliverable", preset: "check", size: { width: 960, height: 540 }, fps: { n: 30, d: 1 }, codec: "h264", audio: "aac", loudness: { lufs: -14, tp: -1 }, burnCaptions: false, gates: [] }], { author: "code" }).project
  const [c1, c2] = cut.sequences[0].clips.map((c) => c.id)

  // Per-shot balance finds the off shot from the sources
  const stats = await Promise.all([[good, c1], [warm, c2]].map(async ([file, clip]) => ({ clip, stats: await measureColour(file, { from: 0, to: 4 }) })))
  const proposed = balanceOps(stats)
  assert.deepEqual(proposed, [{ op: "match_color", clip: c2, reference: c1 }])

  const halves = async (project) => {
    const engine = await engineFor(project)
    const { file } = await engine.render({ quality: "master", deliverable: project.deliverables[0].id })
    return Promise.all([[0.4, 3.6], [4.4, 7.6]].map(([from, to]) => measureColour(file, { from, to })))
  }
  const [before1, before2] = await halves(cut)
  const [after1, after2] = await halves(apply(cut, proposed).project)
  const show = (s) => s.mean.map((v) => v.toFixed(3)).join(", ")
  console.log(`ED13 colour match: before ${show(before1)} | ${show(before2)}; after ${show(after1)} | ${show(after2)}`)
  assert.ok(offAgainst(before2, before1), "the takes start visibly apart")
  assert.equal(offAgainst(after2, after1), false, "matched: no longer off in exposure or white balance")
  assert.ok(Math.abs(after2.mean[0] - after1.mean[0]) < Math.abs(before2.mean[0] - before1.mean[0]) / 3, "exposure gap closed by two thirds or more")
  assert.ok(Math.hypot(after2.mean[1] - after1.mean[1], after2.mean[2] - after1.mean[2]) < Math.hypot(before2.mean[1] - before1.mean[1], before2.mean[2] - before1.mean[2]) / 3, "colour cast closed by two thirds or more")
  assert.ok(Math.abs(after1.mean[0] - before1.mean[0]) < 0.005, "the reference shot itself is untouched")
})

test("a LUT colours a master (its .cube reaches FFmpeg), and the Host takes a .cube as a LUT and refuses a broken one", { timeout: 280_000 }, async () => {
  const take = join(dir, "lut-take.mov")
  scene(take, 3)
  // Warmer: red up, blue down
  const size = 9
  const table = new Float32Array(size ** 3 * 3)
  for (let i = 0; i < size ** 3; i++) {
    const [r, g, b] = [i % size, Math.floor(i / size) % size, Math.floor(i / size ** 2)].map((v) => v / (size - 1))
    table.set([Math.min(1, r * 1.12), g, b * 0.82], i * 3)
  }
  const cube = join(dir, "warm.cube")
  writeFileSync(cube, cubeText({ size, table, title: "Warm" }))
  const base = apply(newProject({ id: "l", name: "Lut", width: 960, height: 540 }), [await videoOp(take, "a1"), { op: "add_asset", id: "l1", kind: "lut", fingerprint: await sha(cube), path: cube, linked: true, rights: "own", facts: {} }, { op: "keep_range", asset: "a1", from: 0, to: 2 * FLICKS }, { op: "add_deliverable", preset: "check", size: { width: 960, height: 540 }, fps: { n: 30, d: 1 }, codec: "h264", audio: "aac", loudness: { lufs: -14, tp: -1 }, burnCaptions: false, gates: [] }], { author: "code" }).project
  const lut = apply(base, [{ op: "apply_lut", clip: base.sequences[0].clips[0].id, asset: "l1" }]).project
  const measure = async (project) => {
    const { file } = await (await engineFor(project)).render({ quality: "master", deliverable: project.deliverables[0].id })
    return measureColour(file, { from: 0.2, to: 1.8 })
  }
  const [plain, warmed] = [await measure(base), await measure(lut)]
  console.log(`ED13 LUT on a master: OKLab b ${plain.mean[2].toFixed(4)} → ${warmed.mean[2].toFixed(4)}`)
  assert.ok(warmed.mean[2] - plain.mean[2] > 0.01, "the master went warmer through the .cube")

  // The Host: a .cube comes in as a LUT, checked; a broken one is refused in words
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kh-")))
  const folder = join(home, "work", "film")
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, "look.cube"), readFileSync(cube))
  writeFileSync(join(folder, "broken.cube"), "LUT_3D_SIZE 9\n0 0 0\n")
  await ensureHost({ env: { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: join(home, "work"), KRIYA_EDIT_IDLE_MS: "600000" }, home })
  try {
    const call = (method, path, body) => hostCall(home, method, path, body)
    const { id } = await call("POST", "/projects", { name: "Film", folder })
    const added = await call("POST", `/projects/${id}/assets`, { path: join(folder, "look.cube") })
    assert.deepEqual([added.kind, added.facts], ["lut", {}])
    await assert.rejects(call("POST", `/projects/${id}/assets`, { path: join(folder, "broken.cube") }), /This LUT can't be used: it has 1 rows, not 729/)
  } finally {
    await stopHost(home)
  }
})
