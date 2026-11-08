import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { apply } from "../../../src/edit/core/ops.js"
import { newProject } from "../../../src/edit/core/project.js"
import { readCapabilities } from "../../../src/edit/engine/capabilities.js"
import { createEngine } from "../../../src/edit/engine/index.js"
import { probe } from "../../../src/edit/engine/probe.js"
import { runGates } from "../../../src/edit/gates/index.js"
import { openJournal } from "../../../src/edit/graph/journal.js"
import { readScreenFrames, screenTrack } from "../../../src/edit/index/layers/screen.js"
import { planShort, SHORT_FROM_LONG } from "../../../src/edit/recipes/short-from-long.js"
import { findActions, planTutorial, TUTORIAL } from "../../../src/edit/recipes/tutorial.js"
import { longTalk } from "../talk.js"

// ED11 on the real FFmpeg: a long synthetic talk becomes a gated 9:16 short that keeps
// the drawn face whole, and a synthetic screencast becomes a tutorial that zooms on the
// typing and cuts the wait. "Speech" is tone bursts at the script's word times; the
// script stands in for the recogniser (EB-11), so QG-04 and QG-14 say not_checked.

const FLICKS = 705_600_000
const RATE = 48_000
const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-recipes-")))
const ffmpeg = (...args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 })
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex")

/** Tone-burst speech at the words' times over a quiet room, as 16-bit mono PCM. */
function speech(file, seconds, words) {
  const pcm = Buffer.alloc(Math.ceil(seconds * RATE) * 2)
  const spans = words.map((w) => [w.start / FLICKS, w.end / FLICKS]).sort((a, b) => a[0] - b[0])
  let seed = 7
  for (let i = 0, w = 0; i < pcm.length / 2; i++) {
    const t = i / RATE
    while (w < spans.length && t >= spans[w][1]) w++
    seed = (seed * 1103515245 + 12345) % 2147483648
    const voiced = w < spans.length && t >= spans[w][0]
    const value = (voiced ? 0.35 * Math.sin(2 * Math.PI * 170 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 5 * t)) : 0) + (seed / 2147483648 - 0.5) * 0.004
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), i * 2)
  }
  writeFileSync(file, pcm)
}

/** Encodes a lavfi picture graph with the PCM as sound. */
function encode(file, seconds, graph, pcm) {
  ffmpeg("-f", "lavfi", "-i", `color=c=0x3c3c3c:s=1280x720:r=30:d=${seconds.toFixed(3)}`, "-f", "s16le", "-ar", String(RATE), "-ac", "1", "-i", pcm, "-filter_complex", graph, "-map", "[v]", "-map", "1:a", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-g", "30", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-c:a", "aac", "-b:a", "192k", "-shortest", file)
}

async function projectFor(file, name) {
  const { facts } = await probe(file)
  return apply(newProject({ id: name, name }), [{ op: "add_asset", id: "a1", kind: "video", fingerprint: sha(file), path: file, linked: true, rights: "own", facts }], { author: "code" }).project
}

async function engineFor(project, index) {
  const root = realpathSync(mkdtempSync(join(dir, "p-")))
  const engine = createEngine({ folder: root, roots: [root, dir], cache: join(root, "cache"), exports: join(root, "exports"), journal: openJournal(":memory:"), toolVersion: "9", capabilities: await readCapabilities() })
  engine.load(project, index)
  return engine
}

/** One output frame at `seconds`, shrunk to w × h RGB. */
function frameAt(file, seconds, w, h) {
  return ffmpeg("-ss", seconds.toFixed(3), "-i", file, "-frames:v", "1", "-vf", `scale=${w}:${h}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-")
}

/** The bounding box of pixels matching `is` in an RGB frame, or null. */
function boxOf(rgb, w, is) {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -1, -1]
  for (let i = 0; i < rgb.length / 3; i++) {
    if (!is(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2])) continue
    const [x, y] = [i % w, Math.floor(i / w)]
    ;[x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)]
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 }
}

// With no verified recogniser (EB-11) QG-04 and QG-14 say not_checked: "Checked, with notes"
function onlyExpectedNotes(result) {
  for (const g of result.gates) {
    if (g.status === "passed" || g.status === "not_applicable") continue
    assert.ok(["QG-04", "QG-14"].includes(g.id) && g.status === "not_checked", `${g.id} ${g.status}: ${g.message}`)
  }
  assert.equal(result.verdict, "delivered_with_notes")
}

test("short-from-long: a long talk becomes a 30–60 s 9:16 short that passes every gate and keeps the face whole (ET-SOL-03)", { timeout: 280_000 }, async () => {
  const FACE = { w: 140, h: 180, y: 200 }
  const talk = longTalk(2, 1, { width: 1280, w: FACE.w }) // four minutes; the three-way tournament is in the unit suite's 40-minute talk
  const seconds = talk.duration / FLICKS
  const index = { ...talk.index, faces: talk.index.subjects.a1.map((s) => ({ asset: "a1", shot: "a1:sh0", t: s.t, box: { x: s.x - FACE.w / 2, y: FACE.y, w: FACE.w, h: FACE.h }, identity: 0 })) }
  const source = join(dir, "talk.mov")
  speech(`${source}.pcm`, seconds, index.words)
  // The speaker: a skin-toned box drifting as faceX says, over a noisy wall
  encode(source, seconds, `[0:v]noise=alls=10:allf=t[bg];color=c=0xDCB48C:s=${FACE.w}x${FACE.h}:r=30[face];[bg][face]overlay=x='640+230.4*sin(t/20)-${FACE.w / 2}':y=${FACE.y}:shortest=1[v]`, `${source}.pcm`)

  const project = await projectFor(source, "Talk")
  const made = planShort({ project, index, asset: "a1" })
  assert.ok(made.candidates.length >= 2, "the tournament had stories to compare")
  assert.deepEqual(made.candidates.map((c) => c.rank), made.candidates.map((_, i) => i + 1))
  const engine = await engineFor(made.project, index)
  const deliverable = made.project.deliverables[0]
  const started = Date.now()
  const { file, plan } = await engine.render({ quality: "master", deliverable: deliverable.id })
  const result = await runGates({ file, plan, project: made.project, index, sourcePath: () => source, thresholds: SHORT_FROM_LONG.thresholds, only: deliverable.gates, tilePath: engine.tilePath })
  console.log(`ED11 short: ${(plan.duration / FLICKS).toFixed(1)} s from a ${(seconds / 60).toFixed(1)}-minute talk, rendered and gated in ${Math.round((Date.now() - started) / 1000)} s, verdict ${result.verdict}\n${result.gates.map((g) => `${g.id} ${g.status}${g.message ? `: ${g.message}` : ""}`).join("\n")}\ncandidates ${JSON.stringify(made.candidates)}`)
  onlyExpectedNotes(result)
  const info = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], { encoding: "utf8" }))
  const video = info.streams.find((s) => s.codec_type === "video")
  assert.deepEqual([video.width, video.height], [1080, 1920])
  const length = Number(info.format.duration)
  assert.ok(length >= 30 && length <= 60, `${length} s`)

  // ET-SOL-03 on the picture itself: the drawn face is found whole, never cut by the frame edge, in every sampled frame
  const [w, h] = [270, 480]
  const skin = (r, g, b) => r > 170 && g > 130 && g < 215 && b > 90 && b < 175 && r - b > 40
  const centres = []
  for (let k = 0; k < 12; k++) {
    const at = 0.5 + (k * (length - 1)) / 11
    const face = boxOf(frameAt(file, at, w, h), w, skin)
    assert.ok(face, `a face at ${at.toFixed(1)} s`)
    assert.ok(face.x0 >= 1 && face.x1 <= w - 2, `the face is whole at ${at.toFixed(1)} s: x ${face.x0}–${face.x1} of ${w}`)
    centres.push((face.x0 + face.x1) / 2)
  }
  // No whip: in half a second the crop never moves more than its own width allows (one crop width a second)
  for (let k = 0; k < 10; k++) {
    const at = 1 + (k * (length - 3)) / 9
    const [a, b] = [boxOf(frameAt(file, at, w, h), w, skin), boxOf(frameAt(file, at + 0.2, w, h), w, skin)]
    assert.ok(Math.abs((a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2) <= w * 0.25, `no jump of the face between ${at.toFixed(1)} and ${(at + 0.2).toFixed(1)} s`)
  }
})

test("tutorial: a screencast zooms smoothly onto the typing, cuts the long wait, and passes every gate", { timeout: 280_000 }, async () => {
  const seconds = 20
  const say = (from, n) => Array.from({ length: n }, (_, i) => ({ start: Math.round((from + i * 0.5) * FLICKS), end: Math.round((from + i * 0.5 + 0.4) * FLICKS) }))
  const words = [...say(0.5, 4), ...say(14, 6)].map((w, n) => ({ id: `a1:w${n}`, asset: "a1", text: "word", conf: 0.95, flags: [], ...w }))
  const source = join(dir, "screen.mov")
  speech(`${source}.pcm`, seconds, words)
  // A cursor glides at 0.4–1.6 s; at 3 s someone types a line, 15 px every 0.2 s, at (1000, 100); then nothing moves until 14 s
  const typing = Array.from({ length: 10 }, (_, k) => `drawbox=x=${1000 + 15 * k}:y=100:w=15:h=50:color=0xF0F0F0:t=fill:enable='gte(t,${(3 + 0.2 * k).toFixed(1)})'`).join(",")
  encode(source, seconds, `[0:v]noise=alls=6:allf=t,${typing}[bg];color=c=white:s=12x18:r=30[cursor];[bg][cursor]overlay=x='if(lt(t,0.4),200,if(lt(t,1.6),200+(t-0.4)*250,500))':y=600:shortest=1[v]`, `${source}.pcm`)

  // L9 on the real frames: one action, where the typing is; the cursor's glide isn't one
  const track = screenTrack(await readScreenFrames(source), { sourceWidth: 1280, sourceHeight: 720 })
  const actions = findActions(track, { width: 1280, height: 720 })
  assert.equal(actions.length, 1, JSON.stringify(actions))
  const { box } = actions[0]
  assert.ok(box.x <= 1000 && box.x + box.w >= 1150 && box.y <= 100 && box.y + box.h >= 150 && box.w <= 240, JSON.stringify(box))

  const index = { words, sentences: [], takes: [], shots: [], faces: [], silences: [], timestamps: {}, subjects: {} }
  const project = await projectFor(source, "Tutorial")
  const made = planTutorial({ project, index, asset: "a1", track })
  assert.equal(made.zooms.length, 1)
  const engine = await engineFor(made.project, index)
  const deliverable = made.project.deliverables[0]
  const { file, plan } = await engine.render({ quality: "master", deliverable: deliverable.id })
  const result = await runGates({ file, plan, project: made.project, index, sourcePath: () => source, thresholds: TUTORIAL.thresholds, only: deliverable.gates, tilePath: engine.tilePath })
  console.log(`ED11 tutorial: ${seconds} s became ${(plan.duration / FLICKS).toFixed(1)} s, zoom ${JSON.stringify(made.zooms[0])}, verdict ${result.verdict}\n${result.gates.map((g) => `${g.id} ${g.status}${g.message ? `: ${g.message}` : ""}`).join("\n")}`)
  onlyExpectedNotes(result)
  const info = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], { encoding: "utf8" }))
  assert.deepEqual([info.streams.find((s) => s.codec_type === "video").width, info.streams.find((s) => s.codec_type === "video").height], [1920, 1080])
  assert.ok(Number(info.format.duration) < 13, `the wait is cut: ${info.format.duration} s`)

  // The zoom on the picture: once the line is typed, it is twice as wide as unzoomed, whole, and right of centre where it was typed
  const zoom = plan.segments.flatMap((s) => s.node.picture.filter((p) => p.zoom).map((p) => ({ at: s.start + p.at, end: s.start + p.end, zoom: p.zoom })))
  assert.ok(zoom.length > 0 && zoom.every((z) => z.zoom.ease === "smooth"))
  const [w, h] = [480, 270]
  const light = (r, g, b) => r > 200 && g > 200 && b > 200
  const typed = Math.max(...zoom.map((z) => z.end)) / FLICKS - 0.4 // after the last key, before the ease out
  const zoomed = boxOf(frameAt(file, typed, w, h), w, light)
  const plainWidth = (150 / 1280) * w
  assert.ok(zoomed, "the typed line is on screen in the zoom")
  assert.ok(zoomed.x1 - zoomed.x0 + 1 >= plainWidth * 1.8, `${zoomed.x1 - zoomed.x0 + 1} px wide, unzoomed ${plainWidth.toFixed(0)}`)
  assert.ok(zoomed.x0 > w / 2 && zoomed.x1 <= w - 1 && zoomed.y0 >= 0, JSON.stringify(zoomed))
  // Before the typing, nothing light is zoomed (only the small cursor can show)
  const early = boxOf(frameAt(file, 0.3, w, h), w, light)
  assert.ok(!early || early.x1 - early.x0 < 10, JSON.stringify(early))
})
