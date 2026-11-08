import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { apply } from "../../../src/edit/core/ops.js"
import { newProject } from "../../../src/edit/core/project.js"
import { solve } from "../../../src/edit/core/solver.js"
import { readCapabilities } from "../../../src/edit/engine/capabilities.js"
import { createEngine } from "../../../src/edit/engine/index.js"
import { probe } from "../../../src/edit/engine/probe.js"
import { runGates } from "../../../src/edit/gates/index.js"
import { openJournal } from "../../../src/edit/graph/journal.js"
import { writeHandoff } from "../../../src/edit/host/deliver.js"
import { analyseMulticam, PODCAST_MULTICAM, planMulticam } from "../../../src/edit/recipes/multicam.js"
import { planLongform, YOUTUBE_LONGFORM } from "../../../src/edit/recipes/youtube.js"
import { prng } from "../fixture.js"
import { longTalk } from "../talk.js"

// ED12 on the real FFmpeg. A six-minute synthetic talk becomes a chaptered 16:9 YouTube
// cut that passes the gates, and its handoff package is read back by OTIO's own parser
// and xmllint (EG-6 as the ED12 brief sets it). Three synthetic cameras of one
// conversation, started at different times, are synced by their sound and switched;
// a bar that moves with real time is burned into every camera, so the output's picture
// proves the sync to the frame. "Speech" is tone and noise, never a real voice (EB-11).

const FLICKS = 705_600_000
const RATE = 48_000
const FRAME = FLICKS / 30
const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-longform-")))
const ffmpeg = (...args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 })
async function sha(file) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}
const X264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-g", "30", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"]

function writePcm(file, samples) {
  const pcm = Buffer.alloc(samples.length * 2)
  samples.forEach((v, i) => pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2))
  writeFileSync(file, pcm)
}

async function engineFor(project, index) {
  const root = realpathSync(mkdtempSync(join(dir, "p-")))
  const engine = createEngine({ folder: root, roots: [root, dir], cache: join(root, "cache"), exports: join(root, "exports"), journal: openJournal(":memory:"), toolVersion: "9", capabilities: await readCapabilities() })
  engine.load(project, index)
  return { engine, root }
}

async function assetOp(file, id, extra = {}) {
  const { facts } = await probe(file)
  return { op: "add_asset", id, kind: "video", fingerprint: await sha(file), path: file, linked: true, rights: "own", facts, ...extra }
}

// With no verified recogniser (EB-11) QG-04 and QG-14 say not_checked: "Checked, with notes"
function onlyExpectedNotes(result) {
  for (const g of result.gates) {
    if (g.status === "passed" || g.status === "not_applicable") continue
    assert.ok(["QG-04", "QG-14"].includes(g.id) && g.status === "not_checked", `${g.id} ${g.status}: ${g.message}`)
  }
  assert.equal(result.verdict, "delivered_with_notes")
}

const frameCount = (file) => Number(JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_packets", "-select_streams", "v:0", "-show_entries", "stream=nb_read_packets,width,height", "-print_format", "json", file], { encoding: "utf8" })).streams[0].nb_read_packets)

// OTIO's own parser (opentimelineio 0.18.1, Apache-2.0) from uv's cache; offline, so nothing is fetched here
const OTIO_READ = `
import json, os, sys
import opentimelineio as otio
path = sys.argv[1]
t = otio.adapters.read_from_file(path)
f = lambda rt: round(rt.rescaled_to(30).value, 6)
out = {"duration": f(t.duration()), "markers": [[m.name, f(m.marked_range.start_time)] for m in t.tracks.markers], "tracks": []}
for track in t.tracks:
    clips = []
    for item in track:
        if isinstance(item, otio.schema.Clip):
            url = item.media_reference.target_url
            clips.append({"at": f(item.range_in_parent().start_time), "start": f(item.source_range.start_time), "duration": f(item.source_range.duration), "url": url, "exists": os.path.exists(os.path.join(os.path.dirname(path), url))})
    out["tracks"].append({"name": track.name, "kind": track.kind, "clips": clips})
print(json.dumps(out))
`
function readOtio(file) {
  const found = spawnSync("uv", ["run", "--offline", "--no-project", "--python", "3.12", "--with", "opentimelineio==0.18.1", "python", "-c", OTIO_READ, file], { encoding: "utf8", timeout: 120_000 })
  return found.status === 0 ? JSON.parse(found.stdout) : { missing: (found.stderr || found.error?.message || "uv failed").trim().split("\n").at(-1) }
}

test("youtube-longform: a six-minute talk becomes a chaptered 16:9 cut that passes the gates; its handoff package reads back exactly (EG-6)", { timeout: 1_200_000 }, async () => {
  const talk = longTalk(6, 12, { width: 1280, w: 140 })
  const seconds = talk.duration / FLICKS
  const source = join(dir, "talk.mov")
  const random = prng(5)
  const spans = talk.index.words.map((w) => [w.start / FLICKS, w.end / FLICKS])
  const voice = new Float64Array(Math.ceil(seconds * RATE))
  for (let i = 0, w = 0; i < voice.length; i++) {
    const t = i / RATE
    while (w < spans.length && t >= spans[w][1]) w++
    const voiced = w < spans.length && t >= spans[w][0]
    voice[i] = (voiced ? 0.35 * Math.sin(2 * Math.PI * 170 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 5 * t)) : 0) + (random() - 0.5) * 0.004
  }
  writePcm(`${source}.pcm`, voice)
  // The speaker: a skin-toned box drifting over a noisy wall (overlay moves with t; drawbox doesn't, in FFmpeg 9)
  // A speaker who moves (QG-07 must see a live picture) over light noise: heavy noise made the 1080p master take 19 minutes
  ffmpeg("-f", "lavfi", "-i", `color=c=0x3c3c3c:s=640x360:r=30:d=${seconds.toFixed(3)}`, "-f", "s16le", "-ar", String(RATE), "-ac", "1", "-i", `${source}.pcm`, "-filter_complex", "[0:v]noise=alls=4:allf=t[bg];color=c=0xDCB48C:s=70x90:r=30[face];[bg][face]overlay=x='320+115*sin(t/3)-35':y='100+20*sin(t/2)':shortest=1[v]", "-map", "[v]", "-map", "1:a", ...X264, "-c:a", "aac", "-b:a", "192k", "-shortest", source)
  const broll = join(dir, "broll.mov")
  ffmpeg("-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=10", ...X264, broll)

  const project = apply(newProject({ id: "yt", name: "Long talk" }), [await assetOp(source, "a1"), await assetOp(broll, "b1", { role: "broll" })], { author: "code" }).project
  const made = planLongform({ project, index: talk.index, asset: "a1", broll: ["b1"] })
  assert.ok(made.chapters.length >= 3, made.chapterList)
  const { engine, root } = await engineFor(made.project, talk.index)
  const deliverable = made.project.deliverables[0]
  const started = Date.now()
  const { file, plan } = await engine.render({ quality: "master", deliverable: deliverable.id })
  const sourcePath = (id) => ({ a1: source, b1: broll })[id]
  const result = await runGates({ file, plan, project: made.project, index: talk.index, sourcePath, thresholds: YOUTUBE_LONGFORM.thresholds, only: deliverable.gates, tilePath: engine.tilePath })
  console.log(`ED12 youtube-longform: ${(plan.duration / FLICKS / 60).toFixed(2)} min from a ${(seconds / 60).toFixed(1)}-minute talk, rendered and gated in ${Math.round((Date.now() - started) / 1000)} s, verdict ${result.verdict}\n${result.gates.map((g) => `${g.id} ${g.status}${g.message ? `: ${g.message}` : ""}`).join("\n")}\n${made.chapterList}\n${made.notes.join("\n")}`)
  onlyExpectedNotes(result)
  const info = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", file], { encoding: "utf8" }))
  assert.deepEqual([info.streams[0].width, info.streams[0].height], [1920, 1080])
  const frames = frameCount(file)
  assert.equal(frames, plan.duration / FRAME, "the master has every frame of the plan")

  // The handoff package
  const timeline = solve(made.project, talk.index)
  const out = writeHandoff({ project: made.project, index: talk.index, exportsDir: join(root, "exports"), sourcePath })
  const fcpxml = join(out.folder, "Long-talk.fcpxml")
  execFileSync("xmllint", ["--noout", fcpxml])
  const otio = readOtio(join(out.folder, "Long-talk.otio"))
  assert.ok(!otio.missing, `OTIO's parser: ${otio.missing}`)
  assert.equal(otio.duration, frames, "the OTIO timeline is as long as the master, to the frame")
  const base = otio.tracks.find((t) => t.name === "base")
  assert.equal(base.clips.length, timeline.picture.length, "no clip missing")
  base.clips.forEach((clip, i) => {
    const piece = timeline.picture[i]
    assert.deepEqual([clip.at, clip.start, clip.duration], [piece.at / FRAME, piece.in / FRAME, (piece.end - piece.at) / FRAME], `clip ${i}: exact timecodes`)
  })
  assert.equal(otio.tracks.find((t) => t.name === "broll").clips.length, timeline.overlays.filter((o) => o.asset === "b1").length)
  assert.ok(otio.tracks.every((t) => t.clips.every((c) => c.exists)), "every clip's media is where the package says")
  assert.deepEqual(otio.tracks.filter((t) => t.kind === "Audio").map((t) => t.name), ["dialogue"])
  assert.deepEqual(otio.markers.map(([name]) => name), made.chapters.map((c) => c.title))
  otio.markers.forEach(([, at], i) => assert.ok(Math.abs(at - made.chapters[i].at / FRAME) <= 1))
  // The EDL: one event per piece, source and record lengths equal
  const events = readFileSync(join(out.folder, "Long-talk.edl"), "utf8").split("\n").filter((l) => /^\d{3} /.test(l))
  assert.equal(events.length, timeline.picture.length)
  const frameOf = (tc) => tc.split(":").reduce((n, part, i) => (i < 3 ? (n + Number(part)) * (i < 2 ? 60 : 30) : n + Number(part)), 0)
  for (const line of events) {
    const [sIn, sOut, rIn, rOut] = line.trim().split(/\s+/).slice(-4).map(frameOf)
    assert.equal(sOut - sIn, rOut - rIn, line)
  }
  const cues = readFileSync(join(out.folder, "Long-talk.srt"), "utf8").trim().split("\n\n")
  assert.equal(cues.length, timeline.captions.length)
})

// ---------------------------------------------------------------- podcast-multicam

// The conversation in real time (seconds); B laughs over A at 48 s
const SCRIPT = [
  [0.5, 14, "A"],
  [14, 15, "B"],
  [15, 24, "A"],
  [24, 36, "B"],
  [36, 40, "AB"],
  [40, 58, "A"],
  [48, 48.6, "B"],
]
const CAMERAS = {
  w: { start: 0, seconds: 60, a: 1, b: 1, picture: "color=c=0x505050:s=1280x720:r=30:d=60,drawbox=x=120:y=200:w=300:h=400:color=0xB43C3C:t=fill,drawbox=x=860:y=200:w=300:h=400:color=0x3C50B4:t=fill" },
  ca: { start: 1.37, seconds: 60, a: 1, b: 0.25, picture: "color=c=0xB43C3C:s=1280x720:r=30:d=60" },
  cb: { start: -0.83, seconds: 61, a: 0.25, b: 1, picture: "color=c=0x3C50B4:s=1280x720:r=30:d=61" },
}
// A white bar that moves with real time: x = (world seconds × 240) mod 1200, in the source's pixels
const bar = (start) => `noise=alls=8:allf=t[bg];color=c=white:s=24x720:r=30[bar];[bg][bar]overlay=x='mod((t+${start})*240,1200)':y=0:shortest=1[v]`

function voices() {
  const random = prng(21)
  const seconds = 63
  const at = (s) => Math.round((s + 1) * RATE) // world time −1 s is sample 0
  const [a, b] = [new Float64Array(seconds * RATE), new Float64Array(seconds * RATE)]
  for (const [from, to, who] of SCRIPT) {
    for (let i = at(from); i < at(to); i++) {
      const t = i / RATE - 1
      if ((t - from) % 0.5 > 0.4) continue // words of 0.4 s
      const breath = (random() - 0.5) * 0.15
      if (who.includes("A")) a[i] = 0.3 * Math.sin(2 * Math.PI * 170 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 5 * t)) + breath
      if (who.includes("B")) b[i] = 0.3 * Math.sin(2 * Math.PI * 240 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t)) + breath
    }
  }
  return { a, b, at }
}

test("podcast-multicam: three cameras started at different times sync by sound to the frame, switch on who speaks, and pass the gates (ET-IDX-07)", { timeout: 600_000 }, async () => {
  const { a, b, at } = voices()
  const files = {}
  for (const [id, cam] of Object.entries(CAMERAS)) {
    const random = prng(id.length * 7 + 3)
    const sound = new Float64Array(cam.seconds * RATE)
    for (let i = 0; i < sound.length; i++) {
      const j = at(cam.start) + i
      sound[i] = (j >= 0 && j < a.length ? cam.a * a[j] + cam.b * b[j] : 0) + (random() - 0.5) * 0.006
    }
    files[id] = join(dir, `${id}.mov`)
    writePcm(`${files[id]}.pcm`, sound)
    ffmpeg("-f", "lavfi", "-i", cam.picture, "-f", "s16le", "-ar", String(RATE), "-ac", "1", "-i", `${files[id]}.pcm`, "-filter_complex", `[0:v]${bar(cam.start)}`, "-map", "[v]", "-map", "1:a", ...X264, "-c:a", "aac", "-b:a", "192k", "-shortest", files[id])
  }
  const project = apply(newProject({ id: "pod", name: "Podcast" }), await Promise.all(Object.entries(files).map(([id, file]) => assetOp(file, id))), { author: "code" }).project
  const facts = (id) => project.assets.find((x) => x.id === id).facts
  const analysis = await analyseMulticam({ master: { asset: "w", file: files.w, duration: facts("w").duration }, angles: [{ asset: "ca", file: files.ca, speaker: 0 }, { asset: "cb", file: files.cb, speaker: 1 }] })
  // Truth: camera A began 1.37 s after the master, camera B 0.83 s before; both sounds went through AAC
  assert.ok(Math.abs(analysis.sync.ca.offset / FLICKS + 1.37) < 0.002, `ca ${analysis.sync.ca.offset / FLICKS} s`)
  assert.ok(Math.abs(analysis.sync.cb.offset / FLICKS - 0.83) < 0.002, `cb ${analysis.sync.cb.offset / FLICKS} s`)
  assert.ok(Math.abs(analysis.sync.ca.drift) < 2e-5 && Math.abs(analysis.sync.cb.drift) < 2e-5)

  const index = { words: [], sentences: [], takes: [], shots: [], faces: [], silences: [], timestamps: {} }
  const made = planMulticam({ project, index, master: "w", angles: [{ asset: "ca", speaker: 0 }, { asset: "cb", speaker: 1 }], analysis })
  const { engine } = await engineFor(made.project, index)
  const deliverable = made.project.deliverables[0]
  const { file, plan } = await engine.render({ quality: "master", deliverable: deliverable.id })
  const result = await runGates({ file, plan, project: made.project, index, sourcePath: (id) => files[id], thresholds: PODCAST_MULTICAM.thresholds, only: deliverable.gates, tilePath: engine.tilePath })
  console.log(`ED12 podcast-multicam: ${made.shots.length} shots\n${made.shots.map((s) => `${(s.at / FLICKS).toFixed(1)}–${(s.end / FLICKS).toFixed(1)} ${s.asset} (${s.why})`).join("\n")}\n${made.notes.join("\n")}\n${result.gates.map((g) => `${g.id} ${g.status}${g.message ? `: ${g.message}` : ""}`).join("\n")}`)
  onlyExpectedNotes(result)
  for (const shot of made.shots) assert.ok(shot.end - shot.at >= PODCAST_MULTICAM.minShot - FRAME || shot.end === plan.duration, "no shot under 2.5 s")

  // The picture: whose camera is on screen, and the moving bar says what real time it shows
  const [w, h] = [480, 270]
  const look = (t) => {
    const rgb = ffmpeg("-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-vf", `scale=${w}:${h}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-")
    const pixel = (x, y) => [0, 1, 2].map((c) => rgb[(y * w + x) * 3 + c])
    // The middle of the frame, away from the bar: red is camera A, blue camera B, grey the wide
    const [r, g, bl] = pixel(w / 2 + 40, h - 30).map((v, i) => v + pixel(w / 2 - 40, h - 30)[i])
    const camera = r > bl + 60 ? "ca" : bl > r + 60 ? "cb" : Math.abs(r - bl) < 40 && Math.abs(r - g) < 40 ? "w" : "?"
    let [sum, count] = [0, 0]
    for (let x = 0; x < w; x++) if (pixel(x, 10).every((v) => v > 225)) (sum += x), count++
    const x = count ? sum / count : null
    return { camera, world: x === null ? null : ((x * (1280 / w) - 12) / 240) % 5 }
  }
  const expected = (t) => made.shots.find((s) => s.at <= t * FLICKS && t * FLICKS < s.end).asset
  let checked = 0
  for (let t = 1.2; t < 59; t += 1.7) {
    const shot = made.shots.find((s) => s.at <= t * FLICKS && t * FLICKS < s.end)
    if (t * FLICKS - shot.at < FLICKS / 4 || shot.end - t * FLICKS < FLICKS / 4) continue // not on a cut
    const seen = look(t)
    assert.equal(seen.camera, expected(t), `at ${t.toFixed(1)} s`)
    assert.ok(seen.world !== null, `the bar at ${t.toFixed(1)} s`)
    // In sync to the frame: the bar shows the master's time, whichever camera is on (period 5 s)
    const error = Math.abs(((seen.world - (t % 5) + 7.5) % 5) - 2.5)
    assert.ok(error <= 1.5 / 30, `${seen.camera} at ${t.toFixed(2)} s shows real time ${seen.world.toFixed(3)} (mod 5), ${(error * 1000).toFixed(0)} ms off`)
    checked++
  }
  assert.ok(checked >= 20, `${checked} frames checked`)
  // Switching follows who speaks
  const on = (from, to, asset) => made.shots.filter((s) => s.asset === asset).reduce((sum, s) => sum + Math.max(0, Math.min(s.end, to * FLICKS) - Math.max(s.at, from * FLICKS)), 0) / ((to - from) * FLICKS)
  assert.ok(on(2, 14, "ca") > 0.7, "camera A while A talks")
  assert.ok(on(25, 36, "cb") > 0.8, "camera B while B talks")
  assert.ok(on(36.5, 40, "w") > 0.8, "the wide while they talk over each other")
  assert.ok(on(14, 15, "ca") > 0.9, "no cut for B's one-second reply")
  // In A's long answer, the look at the listener lands on B's laugh (EDITOR_WORKFLOWS §9)
  assert.ok(made.shots.some((s) => s.why === "the listener's reaction" && s.asset === "cb" && Math.abs(s.at / FLICKS - 48) < 0.6), "a look at B when B laughs")
  assert.ok(existsSync(file))
})
