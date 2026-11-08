import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"

import { apply } from "../../../src/edit/core/ops.js"
import { readCapabilities } from "../../../src/edit/engine/capabilities.js"
import { createEngine } from "../../../src/edit/engine/index.js"
import { probe } from "../../../src/edit/engine/probe.js"
import { EngineFailure } from "../../../src/edit/engine/tool.js"
import { openJournal } from "../../../src/edit/graph/journal.js"
import { createScheduler } from "../../../src/edit/graph/scheduler.js"
import { makeProject, ms } from "../fixture.js"
import { barcodeVideo, readBarcodes } from "./barcode.js"

// ET-ENG-*: the real FFmpeg on synthetic fixtures. Run with:
//   node --test tests/edit/media/*.test.js

const FLICKS = 705_600_000
const frameFlicks = FLICKS / 30
const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-media-")))
const source = join(dir, "barcode.mov")
const ffmpeg = (...args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "pipe", "pipe"] })
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex")
const info = (file) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], { encoding: "utf8" }))

let capabilities

before(async () => {
  capabilities = await readCapabilities()
  await barcodeVideo(source, { frames: 450 })
})

async function setup({ ops, over = {}, facts = {}, name = "barcode.mov", journal = openJournal(":memory:"), scheduler } = {}) {
  const root = realpathSync(mkdtempSync(join(dir, "p-")))
  const { facts: probed } = await probe(join(dir, name))
  const project = structuredClone(makeProject())
  project.canvas = { ...project.canvas, width: 640, height: 360 }
  project.assets = [{ ...project.assets[0], path: join(dir, name), fingerprint: sha(join(dir, name)), facts: { ...probed, ...facts } }]
  project.assets[0].id = "a1"
  const applied = apply(project, ops ?? [{ op: "keep_range", asset: "a1", from: 0, to: ms(4000) }])
  assert.deepEqual(applied.diagnostics, [])
  const log = []
  const engine = createEngine({ folder: root, roots: [root, dir], cache: join(root, "cache"), exports: join(root, "exports"), journal, toolVersion: "9", capabilities, scheduler, onTool: (command, args) => log.push([command, ...args]), ...over })
  engine.load(applied.project, {})
  return { engine, log, root, journal, project: applied.project }
}

test("ET-ENG-01: probe reads a plain file exactly", async () => {
  const { facts } = await probe(source)
  assert.deepEqual(facts.fps, { n: 30, d: 1 })
  assert.equal(facts.vfr, false)
  assert.deepEqual([facts.width, facts.height, facts.rotation], [640, 360, 0])
  assert.equal(facts.duration, 15 * FLICKS)
  assert.ok(Number.isSafeInteger(facts.duration))
  assert.deepEqual([facts.hasAudio, facts.sampleRate], [true, 48000])
  assert.deepEqual(facts.color, { primaries: "bt709", transfer: "bt709", range: "tv", tagged: true, hdr: false })
})

test("ET-ENG-01: VFR keeps its real timestamps", async () => {
  const file = join(dir, "vfr.mp4")
  ffmpeg("-f", "lavfi", "-i", "testsrc=s=320x180:r=30:d=4", "-vf", "select='lt(n,30)+not(mod(n,3))'", "-fps_mode", "vfr", "-c:v", "libx264", file)
  const { facts, timestamps } = await probe(file)
  assert.equal(facts.vfr, true)
  assert.equal(facts.fps, null)
  assert.equal(timestamps.length, 60)
  assert.ok(timestamps.every(Number.isSafeInteger))
  const gaps = timestamps.slice(1).map((t, i) => t - timestamps[i])
  assert.ok(Math.max(...gaps) > Math.min(...gaps) * 2)
})

test("ET-ENG-01: rotation, odd channels and no audio", async () => {
  const rotated = join(dir, "rotated.mp4")
  ffmpeg("-display_rotation", "90", "-i", source, "-c", "copy", rotated)
  const turned = (await probe(rotated)).facts
  assert.equal(turned.rotation, 90)
  assert.deepEqual([turned.width, turned.height], [360, 640], "as it displays")

  const surround = join(dir, "surround.mka")
  ffmpeg("-f", "lavfi", "-i", "sine=d=1", "-af", "pan=5.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0", "-c:a", "flac", surround)
  const sound = (await probe(surround)).facts
  assert.equal(sound.channels, 6)
  assert.equal(sound.width, undefined)

  const silent = join(dir, "silent.mp4")
  ffmpeg("-f", "lavfi", "-i", "testsrc=s=320x180:r=25:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", silent)
  const mute = (await probe(silent)).facts
  assert.equal(mute.hasAudio, false)
  assert.deepEqual(mute.fps, { n: 25, d: 1 })
  assert.equal(mute.color.tagged, false, "untagged is flagged, so the plan assigns tags first")
})

test("ET-ENG-01: HDR tags, and an unreadable file is a typed input failure", async () => {
  const hdr = join(dir, "hdr.mp4")
  ffmpeg("-f", "lavfi", "-i", "testsrc=s=320x180:r=30:d=1", "-vf", "format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc:range=tv", "-c:v", "libx265", "-x265-params", "log-level=none", "-tag:v", "hvc1", hdr)
  const { facts } = await probe(hdr)
  assert.equal(facts.color.hdr, true)
  assert.equal(facts.color.transfer, "smpte2084")

  const junk = join(dir, "junk.mp4")
  writeFileSync(junk, "this is not a video")
  await assert.rejects(probe(junk), (error) => error instanceof EngineFailure && error.kind === "input")
})

test("ET-ENG-02: the proxy is small, seekable and frame-accurate against the burned-in counter", async () => {
  const { engine, journal } = await setup()
  const proxy = await engine.proxy("a1")
  const stream = info(proxy).streams.find((s) => s.codec_type === "video")
  assert.ok(stream.width <= 960 && stream.height <= 540)
  assert.equal(stream.has_b_frames, 0, "no B-frames")
  assert.equal(stream.color_transfer, "bt709")
  assert.ok(info(proxy).streams.some((s) => s.codec_type === "audio"), "audio kept")

  let wrong = 0
  for (const frame of [0, 1, 29, 30, 31, 137, 200, 299, 300, 449]) {
    // A seek returns the first frame at or after the time, so aim just before it
    const [seen] = readBarcodes(proxy, { ss: (Math.max(0, frame - 0.25) / 30).toFixed(6), count: 1 })
    if (seen !== frame) wrong++
  }
  assert.equal(wrong, 0)
  assert.deepEqual(readBarcodes(proxy), Array.from({ length: 450 }, (_, i) => i), "every frame, in order")

  const before = statSync(proxy).mtimeMs
  assert.equal(await engine.proxy("a1"), proxy)
  assert.equal(statSync(proxy).mtimeMs, before, "a second ask does no work")
  assert.ok(journal.steps().some((s) => s.kind === "proxy"))
})

test("ET-ENG-02: peaks at several zoom levels, and a thumbnail sheet", async () => {
  const { engine } = await setup()
  const peaks = JSON.parse(readFileSync(await engine.peaks("a1"), "utf8"))
  assert.deepEqual(peaks.levels.map((l) => l.perSecond), [100, 10, 1])
  assert.ok(Math.abs(peaks.levels[0].peaks.length - 1500) <= 2)
  assert.equal(peaks.levels[2].peaks.length, 15)
  assert.ok(peaks.levels[0].peaks.slice(10, -10).every((p) => p > 0), "a steady tone has a level everywhere")
  const thumbs = await engine.thumbs("a1")
  assert.ok(statSync(thumbs).size > 1000)
  assert.match(info(thumbs).streams[0].codec_name, /jpeg|png/)
})

const CUTS = [
  { op: "keep_range", asset: "a1", from: 0, to: ms(2000) },
  { op: "keep_range", asset: "a1", from: ms(5000), to: ms(6500) },
  { op: "keep_range", asset: "a1", from: ms(9000), to: ms(14000) },
]
const WANTED = [...Array.from({ length: 60 }, (_, i) => i), ...Array.from({ length: 45 }, (_, i) => 150 + i), ...Array.from({ length: 150 }, (_, i) => 270 + i)]

test("ET-ENG-10, ET-ENG-04: a draft joins with no duplicate or missing frame, no audio gap, and sources untouched", async () => {
  const before = sha(source)
  const { engine } = await setup({ ops: CUTS })
  const { file, plan } = await engine.render({ quality: "draft" })
  assert.ok(plan.segments.length >= 3, "more than one segment, so a real join")
  assert.deepEqual(readBarcodes(file), WANTED)

  const { streams, format } = info(file)
  assert.ok(Math.abs(Number(format.duration) - 255 / 30) < 0.05, format.duration)
  assert.equal(streams.find((s) => s.codec_type === "audio").codec_name, "aac")
  assert.equal(streams.find((s) => s.codec_type === "audio").sample_rate, "48000")

  const silence = spawnSync("ffmpeg", ["-hide_banner", "-i", file, "-af", "silencedetect=noise=-50dB:d=0.03", "-f", "null", "-"], { encoding: "utf8" }).stderr
  assert.doesNotMatch(silence, /silence_start/, "the 15 ms fades at each cut leave no gap")
  assert.equal(sha(source), before, "ES-02: the source is byte-identical")
})

test("ET-CMP-04 for real: a change re-renders only the segment it touches", async () => {
  const { engine, log, project } = await setup({ ops: CUTS })
  await engine.render({ quality: "draft" })
  const count = () => log.filter(([, ...args]) => args.includes("-filter_complex") && args.includes("-an")).length
  const first = count()
  assert.ok(first >= 3)
  await engine.render({ quality: "draft" })
  assert.equal(count(), first, "nothing changed, nothing rendered")

  const trimmed = apply(project, [{ op: "trim", clip: project.sequences[0].clips.at(-1).id, out: ms(13000) }]).project
  engine.load(trimmed, {})
  const { file } = await engine.render({ quality: "draft" })
  assert.ok(count() - first < first, `only what changed: ${count() - first} of ${first}`)
  assert.deepEqual(readBarcodes(file), WANTED.slice(0, -30))
})

test("ET-ENG-11: a master comes from sources: no proxy in its inputs, one encode, same frames", async () => {
  const { engine, log } = await setup({ ops: CUTS })
  const { file } = await engine.render({ quality: "master" })
  const inputs = log.flatMap(([, ...args]) => args.flatMap((arg, i) => (args[i - 1] === "-i" ? [arg] : [])))
  assert.ok(inputs.includes(source))
  assert.equal(inputs.some((path) => path.includes("/proxy/")), false)
  assert.equal(log.filter(([, ...args]) => args.includes("-an")).length, 1, "one continuous encode")
  assert.deepEqual(readBarcodes(file), WANTED)
})

test("ET-ENG-06: two jobs share slots; neither starves", async () => {
  const scheduler = createScheduler({ encoder: 1, cpu: 2, disk: 1 })
  const one = await setup({ ops: CUTS, scheduler })
  const two = await setup({ ops: CUTS, scheduler })
  const order = []
  const [a, b] = await Promise.all([one.engine.render({ quality: "draft", onStep: () => order.push("one") }), two.engine.render({ quality: "draft", onStep: () => order.push("two") })])
  assert.deepEqual(readBarcodes(a.file), WANTED)
  assert.deepEqual(readBarcodes(b.file), WANTED)
  const firstOfTwo = order.indexOf("two")
  const lastOfOne = order.lastIndexOf("one")
  assert.ok(firstOfTwo < lastOfOne, `interleaved: ${order.join(" ")}`)
  assert.equal(scheduler.busy("encoder"), 0)
})

// A chart of known patches, written as 10-bit 4:4:4 values
function pq(nits) {
  const [m1, m2, c1, c2, c3] = [0.1593017578125, 78.84375, 0.8359375, 18.8515625, 18.6875]
  const y = (nits / 10_000) ** m1
  return ((c1 + c2 * y) / (1 + c3 * y)) ** m2
}

function grey(file, { size = 160 } = {}) {
  return execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-frames:v", "1", "-vf", `scale=${size}:90:flags=neighbor,format=gray`, "-f", "rawvideo", "pipe:1"], { maxBuffer: 1 << 26 })
}

test("ET-ENG-12: an SDR chart keeps its tags and its values", async () => {
  const chart = join(dir, "sdr-chart.mov")
  ffmpeg("-f", "lavfi", "-i", "color=c=0x808080:s=640x360:r=30:d=2", "-vf", "format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv", "-c:v", "libx264", "-crf", "10", chart)
  const { engine } = await setup({ name: "sdr-chart.mov", ops: [{ op: "keep_range", asset: "a1", from: 0, to: ms(1000) }] })
  const { file } = await engine.render({ quality: "master" })
  const video = info(file).streams.find((s) => s.codec_type === "video")
  assert.deepEqual([video.color_primaries, video.color_transfer, video.color_space, video.color_range], ["bt709", "bt709", "bt709", "tv"])
  const [value, original] = [grey(file)[90 * 80], grey(chart)[90 * 80]]
  assert.ok(Math.abs(value - original) <= 2, `grey went in as ${original} and came out ${value}`)
})

test("ET-ENG-12: an untagged source gets BT.709 tags before anything reads it", async () => {
  const chart = join(dir, "untagged.mov")
  ffmpeg("-f", "lavfi", "-i", "color=c=0x808080:s=640x360:r=30:d=2", "-c:v", "libx264", "-crf", "10", "-pix_fmt", "yuv420p", chart)
  const { engine, project } = await setup({ name: "untagged.mov", ops: [{ op: "keep_range", asset: "a1", from: 0, to: ms(1000) }] })
  assert.equal(project.assets[0].facts.color.tagged, false)
  const video = info((await engine.render({ quality: "master" })).file).streams.find((s) => s.codec_type === "video")
  assert.deepEqual([video.color_primaries, video.color_transfer, video.color_space], ["bt709", "bt709", "bt709"])
})

test("ET-ENG-12: HDR maps to BT.709: correct tags, darker stays darker, nothing clips, in draft and master", async () => {
  const chart = join(dir, "hdr-chart.mov")
  const raw = join(dir, "hdr.yuv")
  // Four neutral patches at known PQ levels, as Y'CbCr 4:4:4 10-bit limited range
  const nits = [1, 20, 203, 1000]
  const [w, h] = [640, 360]
  const plane = Buffer.alloc(w * h * 2)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) plane.writeUInt16LE(Math.round(64 + 876 * pq(nits[Math.floor((x * 4) / w)])), (y * w + x) * 2)
  const neutral = Buffer.alloc(w * h * 2)
  for (let i = 0; i < w * h; i++) neutral.writeUInt16LE(512, i * 2)
  const frames = []
  for (let f = 0; f < 30; f++) frames.push(plane, neutral, neutral)
  writeFileSync(raw, Buffer.concat(frames))
  ffmpeg("-f", "rawvideo", "-pix_fmt", "yuv444p10le", "-s", `${w}x${h}`, "-r", "30", "-i", raw, "-vf", "setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc:range=tv", "-c:v", "libx265", "-x265-params", "log-level=none:lossless=1", "-tag:v", "hvc1", chart)

  for (const quality of ["master", "draft"]) {
    const { engine, project } = await setup({ name: "hdr-chart.mov", ops: [{ op: "keep_range", asset: "a1", from: 0, to: ms(500) }] })
    assert.equal(project.assets[0].facts.color.hdr, true)
    const { file } = await engine.render({ quality })
    const video = info(file).streams.find((s) => s.codec_type === "video")
    assert.deepEqual([video.color_primaries, video.color_transfer, video.color_space], ["bt709", "bt709", "bt709"], quality)
    const row = grey(file).subarray(45 * 160, 46 * 160)
    const levels = [20, 60, 100, 140].map((x) => row[x])
    assert.deepEqual([...levels].sort((a, b) => a - b), levels, `${quality}: ${levels}`)
    assert.ok(levels[0] < 60, `${quality}: 1 nit stays dark: ${levels}`)
    assert.ok(levels[2] > 150 && levels[2] < 235, `${quality}: reference white is bright, not clipped: ${levels}`)
    assert.ok(levels[3] > levels[2] && levels[3] < 250, `${quality}: highlights keep detail: ${levels}`)
  }
})

test("a job can be cancelled, and leaves no half file in the cache", async () => {
  const { engine, root } = await setup({ ops: CUTS })
  const stop = new AbortController()
  const running = engine.render({ quality: "master", signal: stop.signal })
  setTimeout(() => stop.abort(new Error("cancelled")), 50)
  await assert.rejects(running)
  assert.equal(existsSync(join(root, "cache", "out")) && execFileSync("ls", [join(root, "cache", "out")], { encoding: "utf8" }).includes(".part"), false)
})
