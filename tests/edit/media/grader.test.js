import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { blindPackage } from "../../../bench/edit/blind.js"
import { checkTask, defects, facts } from "../../../bench/edit/grade/index.js"

// EVALUATION_PLAN §7: the grader, against hand labels. Each file below has a defect made at a
// known time, so its label is what was done to it. Real ffmpeg and ffprobe; synthetic
// pictures and tones, so this says the grader reads files correctly, not how it fares on
// real footage.

const dir = realpathSync(mkdtempSync(join(tmpdir(), "kb-grade-")))
const ffmpeg = (...args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args, "-y"])
const CODE = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"]
const VIDEO = (d, size = "640x360") => ["-f", "lavfi", "-i", `testsrc2=s=${size}:r=30:d=${d}`]
// A tone at about -14 LUFS (lavfi's sine starts at -18 dBFS), so a clean file is clean on loudness too
const TONE = (d, volume = "7.8dB") => ["-f", "lavfi", "-i", `sine=f=440:r=48000:d=${d},volume=${volume}`]

function clean(name = "clean.mp4", d = 12) {
  const file = join(dir, name)
  ffmpeg(...VIDEO(d), ...TONE(d), ...CODE, file)
  return file
}

test("§7: the grader finds each labelled defect at its time, and nothing on clean files", { timeout: 120_000 }, async () => {
  const out = (name) => join(dir, name)
  const labelled = {
    black: () => (ffmpeg("-i", clean(), "-vf", "drawbox=enable='between(t,4,6)':color=black:t=fill", "-c:a", "copy", "-c:v", "libx264", "-pix_fmt", "yuv420p", out("black.mp4")), out("black.mp4")),
    frozen: () => (ffmpeg("-i", clean(), "-vf", "loop=loop=120:size=1:start=120,setpts=N/30/TB,trim=duration=12", "-c:a", "copy", "-c:v", "libx264", "-pix_fmt", "yuv420p", out("frozen.mp4")), out("frozen.mp4")),
    silent: () => (ffmpeg("-i", clean(), "-af", "volume=enable='between(t,4,8)':volume=0", "-c:v", "copy", "-c:a", "aac", out("silent.mp4")), out("silent.mp4")),
    clipping: () => (ffmpeg("-i", clean(), "-af", "volume=18dB", "-c:v", "copy", "-c:a", "pcm_s16le", out("loud.mov")), out("loud.mov")),
    loudness: () => (ffmpeg("-i", clean(), "-af", "volume=-15dB", "-c:v", "copy", "-c:a", "aac", out("quiet.mp4")), out("quiet.mp4")),
  }
  const rows = []
  for (const [kind, make] of Object.entries(labelled)) {
    const graded = await defects(make())
    const hit = graded.defects.find((d) => d.kind === kind)
    rows.push(`${kind}: ${hit ? "found" : "MISSED"} ${JSON.stringify(graded.defects)}`)
    assert.ok(hit, `${kind}: ${JSON.stringify(graded.defects)}`)
    if (hit.at !== undefined) assert.ok(Math.abs(hit.at - 4) < 0.4, `${kind} at ${hit.at}`)
  }
  console.log(`Grader against labels:\n${rows.join("\n")}`)

  // False alarms: clean files at other lengths and sizes
  for (const [name, d, size] of [["c1.mp4", 6, "640x360"], ["c2.mp4", 20, "1080x1920"], ["c3.mp4", 12, "1920x1080"]]) {
    const file = join(dir, name)
    ffmpeg(...VIDEO(d, size), ...TONE(d), ...CODE, file)
    const graded = await defects(file)
    assert.deepEqual(graded.defects, [], `${name}: ${JSON.stringify(graded.defects)}`)
  }
  const about = await facts(clean())
  assert.deepEqual([about.width, about.height, about.video, about.audio], [640, 360, "h264", "aac"])
  assert.ok(Math.abs(about.duration - 12) < 0.1)
})

test("§3: an audited list passes an oracle, and fails an empty edit and a lazy one", { timeout: 60_000 }, async () => {
  const list = { width: 640, height: 360, seconds: 12, mustKeep: ["We built the whole thing in a week"], mustCut: ["Sorry let me try that again"] }
  const oracle = await defects(clean("oracle.mp4"))
  const heard = { oracle: "We built the whole thing in a week. It cost fifty thousand.", lazy: "We built the whole thing in a. Sorry, let me try that again. We built the whole thing in a week." }
  assert.equal(checkTask(oracle, list, heard.oracle).pass, true, "the oracle passes")

  const lazyFile = join(dir, "lazy.mp4")
  ffmpeg(...VIDEO(12), ...TONE(12), ...CODE, lazyFile)
  assert.equal(checkTask(await defects(lazyFile), list, heard.lazy).pass, false, "trim only fails: the retake is still there")

  const shortFile = join(dir, "tiny.mp4")
  ffmpeg(...VIDEO(0.2), ...TONE(0.2), ...CODE, shortFile)
  const empty = checkTask(await defects(shortFile), list, "")
  assert.equal(empty.pass, false, "an empty edit fails")
  assert.ok(empty.misses.some((m) => /length/.test(m)) && empty.misses.some((m) => /must keep/.test(m)))
})

test("§6: a blind package carries no arm, tool or title, and the same pictures", { timeout: 60_000 }, async () => {
  const source = join(dir, "arm.mp4")
  ffmpeg(...VIDEO(3), ...TONE(3), ...CODE, "-metadata", "title=Kriya Harness A1", "-metadata", "encoder=kriya", "-metadata", "comment=opus", source)
  const out = join(dir, "package")
  const shown = await blindPackage([{ task: "t1", arm: "A1", file: source }], { out, secret: "s" })
  assert.equal(shown.length, 1)
  assert.doesNotMatch(shown[0].blind, /A1|kriya/i)
  const seen = execFileSync("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-print_format", "json", join(out, "raters", shown[0].blind)]).toString()
  const parsed = JSON.parse(seen)
  assert.doesNotMatch(JSON.stringify([parsed.format.tags, parsed.streams.map((s) => s.tags)]), /Kriya|opus/i)
  assert.equal(parsed.format.tags?.title, undefined)
  assert.equal(parsed.format.tags?.comment, undefined)
  assert.ok(Math.abs(Number(parsed.format.duration) - 3) < 0.1, "the same length: a stream copy")
})
