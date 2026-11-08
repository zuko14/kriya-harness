import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { apply } from "../../../src/edit/core/ops.js"
import { readCapabilities } from "../../../src/edit/engine/capabilities.js"
import { createEngine } from "../../../src/edit/engine/index.js"
import { probe } from "../../../src/edit/engine/probe.js"
import { solve } from "../../../src/edit/core/solver.js"
import { runGates } from "../../../src/edit/gates/index.js"
import { openJournal } from "../../../src/edit/graph/journal.js"
import { makeProject, ms } from "../fixture.js"
import { voice, writeWav } from "../sound.js"

// EG-4 (EVALUATION_PLAN §4), for the gates that read a file alone: QG-01, -02, -03,
// -06 and -07. One clean master; 20 clean re-encodes that stay to spec (false alarms);
// 20 seeded defects per gate at known places (detection, and at the right time).
// Limits: detection ≥ 95 %, false alarms ≤ 2 %. Seeds come from a fixed generator.

const FLICKS = 705_600_000
const dir = realpathSync(mkdtempSync(join(tmpdir(), "kh-seeded-")))
const ffmpeg = (...args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args, "-y"])
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex")
let seed = 42
const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
const pick = (from, to) => from + random() * (to - from)
const TAGS = ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"]
const SPEC = ["-c:v", "libx264", "-pix_fmt", "yuv420p", ...TAGS, "-r", "30"]

test("EG-4: the file gates detect ≥ 95 % of seeded defects at the right time, with ≤ 2 % false alarms", { timeout: 1_200_000 }, async () => {
  // The clean master, through the real Engine
  ffmpeg("-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=8", "-f", "lavfi", "-i", "sine=f=330:r=48000:d=8", "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", ...TAGS, "-c:a", "aac", "-shortest", join(dir, "src.mov"))
  const capabilities = await readCapabilities()
  const project = structuredClone(makeProject())
  project.canvas = { ...project.canvas, width: 640, height: 360, fps: { n: 30, d: 1 } }
  project.assets = [{ ...project.assets[0], id: "a1", path: join(dir, "src.mov"), fingerprint: sha(join(dir, "src.mov")), facts: (await probe(join(dir, "src.mov"))).facts }]
  const applied = apply(project, [{ op: "keep_range", asset: "a1", from: 0, to: ms(8000) }, { op: "add_deliverable", preset: "reel-9x16", size: { width: 640, height: 360 }, fps: { n: 30, d: 1 }, codec: "h264", audio: "aac", loudness: { lufs: -14, tp: -1 }, burnCaptions: false }], { index: {} })
  assert.deepEqual(applied.diagnostics, [])
  const root = realpathSync(mkdtempSync(join(dir, "p-")))
  const engine = createEngine({ folder: root, roots: [root, dir], cache: join(root, "cache"), exports: join(root, "exports"), journal: openJournal(":memory:"), toolVersion: "9", capabilities })
  engine.load(applied.project, {})
  const { file: clean, plan } = await engine.render({ quality: "master", deliverable: applied.project.deliverables[0].id })
  const gate = async (id, file) => (await runGates({ file, plan, project: applied.project, index: {}, sourcePath: () => join(dir, "src.mov"), only: [id] })).gates[0]

  // 20 clean re-encodes, still to spec: other CRFs, presets and audio bitrates
  const cleans = []
  for (let i = 0; i < 20; i++) {
    const out = join(dir, `clean-${i}.mp4`)
    ffmpeg("-i", clean, ...SPEC, "-crf", String(14 + (i % 10)), "-preset", ["veryfast", "medium", "fast", "slow"][i % 4], "-c:a", "aac", "-b:a", `${128 + 32 * (i % 3)}k`, "-movflags", "+faststart", out)
    cleans.push(out)
  }

  const seeds = {
    // QG-01: a size, rate, codec, pixel format or tag off spec
    "QG-01": (i) => {
      const video = { codec: "libx264", pixFmt: "yuv420p", rate: "30", vf: [], tags: TAGS }
      const audio = { codec: "aac" }
      const variants = [
        () => video.vf.push("scale=638:360"),
        () => video.vf.push("scale=640:358"),
        () => (video.rate = "25"),
        () => (video.rate = "24"),
        () => (video.pixFmt = "yuv444p"),
        () => (video.codec = "mpeg4"),
        // Tags go on the frames: FFmpeg keeps a frame's own tags over output flags
        () => (video.vf.push("setparams=color_primaries=bt470bg"), (video.tags = [])),
        () => (video.vf.push("setparams=color_trc=smpte170m"), (video.tags = [])),
        () => (audio.codec = "libmp3lame"),
        () => video.vf.push("scale=320:180"),
      ]
      variants[i % variants.length]()
      return { args: ["-c:v", video.codec, "-pix_fmt", video.pixFmt, ...video.tags, "-r", video.rate, ...(video.vf.length ? ["-vf", video.vf.join(",")] : []), "-c:a", audio.codec], at: null, check: true }
    },
    // QG-02: the end cut short by 2 to 21 frames
    "QG-02": (i) => ({ args: [...SPEC, "-c:a", "aac", "-t", ((8 * 30 - (2 + i)) / 30).toFixed(4)], at: null }),
    // QG-03: the sound late by 50 to 240 ms
    "QG-03": (i) => ({ pre: ["-itsoffset", (0.05 + i * 0.01).toFixed(3)], args: ["-map", "1:v", "-map", "0:a", "-c", "copy"], twice: true, at: 0 }),
    // QG-06: gain off by 0.8 to 5 dB either way
    "QG-06": (i) => {
      const db = (i % 2 ? 1 : -1) * (0.8 + (i / 19) * 4.2)
      return { args: ["-c:v", "copy", "-af", `volume=${db.toFixed(2)}dB`, "-c:a", "aac", "-b:a", "192k"], at: null }
    },
    // QG-07: a black span or a frozen one, somewhere in the middle
    "QG-07": (i) => {
      const t = pick(1, 6)
      if (i % 2 === 0) {
        const d = pick(0.2, 0.6)
        return { args: [...SPEC, "-vf", `geq=lum='if(between(T,${t.toFixed(3)},${(t + d).toFixed(3)}),16,lum(X,Y))':cb='if(between(T,${t.toFixed(3)},${(t + d).toFixed(3)}),128,cb(X,Y))':cr='if(between(T,${t.toFixed(3)},${(t + d).toFixed(3)}),128,cr(X,Y))'`, "-c:a", "aac"], at: t }
      }
      const first = Math.round(t * 30)
      return { freeze: { first, last: first + Math.round(pick(1.2, 1.8) * 30) }, at: first / 30 }
    },
  }

  const table = []
  for (const [id, make] of Object.entries(seeds)) {
    let caught = 0
    let onTime = 0
    for (let i = 0; i < 20; i++) {
      const seeded = make(i)
      const out = join(dir, `${id}-${i}.mp4`)
      if (seeded.freeze) ffmpeg("-i", clean, "-i", clean, "-filter_complex", `[0:v][1:v]freezeframes=first=${seeded.freeze.first}:last=${seeded.freeze.last}:replace=${seeded.freeze.first}[v]`, "-map", "[v]", "-map", "0:a", ...SPEC, "-c:a", "aac", out)
      else if (seeded.twice) ffmpeg(...seeded.pre, "-i", clean, "-i", clean, ...seeded.args, out)
      else ffmpeg("-i", clean, ...seeded.args, out)
      // A seed that didn't take isn't a defect: refuse it, never count it as a miss
      if (seeded.check) {
        const facts = (file) => execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height,avg_frame_rate,pix_fmt,color_primaries,color_transfer", "-of", "compact", file]).toString()
        assert.notEqual(facts(out), facts(clean), `${id} seed ${i} didn't change the file: ${seeded.args.join(" ")}`)
      }
      const result = await gate(id, out)
      if (result.status === "failed") {
        caught++
        const at = result.at ?? result.numbers?.first?.t
        if (seeded.at === null || (at !== undefined && Math.abs(at / FLICKS - seeded.at) <= 0.2)) onTime++
      } else console.log(`${id} missed seed ${i}: ${JSON.stringify(result.numbers)}`)
    }
    let alarms = 0
    for (const file of cleans) {
      const result = await gate(id, file)
      if (result.status !== "passed") {
        alarms++
        console.log(`${id} false alarm on ${file}: ${result.message} ${JSON.stringify(result.numbers)}`)
      }
    }
    table.push({ id, detection: caught / 20, onTime: onTime / 20, falseAlarms: alarms / cleans.length })
  }
  console.log(`EG-4 (file gates):\n${table.map((r) => `${r.id}: detected ${(r.detection * 100).toFixed(0)} %, at the right time ${(r.onTime * 100).toFixed(0)} %, false alarms ${(r.falseAlarms * 100).toFixed(0)} % (20 seeds, 20 clean)`).join("\n")}`)
  for (const r of table) {
    assert.ok(r.detection >= 0.95 && r.onTime >= 0.95, `${r.id} detects ${r.detection}, on time ${r.onTime}`)
    assert.ok(r.falseAlarms <= 0.02, `${r.id} false alarms ${r.falseAlarms}`)
  }
})

test("EG-4: QG-05 catches cuts inside spoken words and QG-12 a brief's misses, ≥ 95 % at the right time, ≤ 2 % false alarms", { timeout: 1_200_000 }, async () => {
  // A take of tone-burst "speech": 30 words of 0.4 s with 0.1 s gaps from 1 s, in three sentences
  const words = Array.from({ length: 30 }, (_, i) => ({ s: 1 + i * 0.5, e: 1.4 + i * 0.5 }))
  writeWav(join(dir, "talk.wav"), voice(17, words), 48_000)
  ffmpeg("-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=17", "-i", join(dir, "talk.wav"), "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", ...TAGS, "-c:a", "aac", "-b:a", "192k", "-shortest", join(dir, "talk.mov"))
  const index = {
    words: words.map((w, i) => ({ asset: "a1", id: `a1:w${i}`, start: Math.round(w.s * FLICKS), end: Math.round(w.e * FLICKS), text: `word${i}`, flags: [] })),
    sentences: [0, 1, 2].map((n) => ({ asset: "a1", id: `a1:s${n}`, start: Math.round((1 + n * 5) * FLICKS), end: Math.round((1 + n * 5 + 4.9) * FLICKS), firstWord: `a1:w${n * 10}`, lastWord: `a1:w${n * 10 + 9}` })),
    shots: [],
    faces: [],
  }
  const capabilities = await readCapabilities()
  const take = { ...structuredClone(makeProject()).assets[0], id: "a1", path: join(dir, "talk.mov"), fingerprint: sha(join(dir, "talk.mov")), facts: (await probe(join(dir, "talk.mov"))).facts }
  const build = (ops) => {
    const project = structuredClone(makeProject())
    project.canvas = { ...project.canvas, width: 640, height: 360, fps: { n: 30, d: 1 } }
    project.assets = [take]
    const applied = apply(project, ops, { index })
    assert.deepEqual(applied.diagnostics, [], JSON.stringify(ops))
    return applied.project
  }
  const engine = (() => {
    const root = realpathSync(mkdtempSync(join(dir, "talk-")))
    return createEngine({ folder: root, roots: [root, dir], cache: join(root, "cache"), exports: join(root, "exports"), journal: openJournal(":memory:"), toolVersion: "9", capabilities })
  })()
  const check = async (id, project) => {
    engine.load(project, index)
    const { file, plan } = await engine.render({ quality: "master" })
    const gate = (await runGates({ file, plan, project, index, sourcePath: () => join(dir, "talk.mov"), only: [id] })).gates[0]
    // Where the first cut really is on the output: the solver's first piece ends there (segments also split at 6 s, so not those)
    return { ...gate, firstCut: Math.min(...solve(project, index).picture.map((p) => p.end)) }
  }
  const gap = (i) => Math.round((1.45 + i * 0.5) * FLICKS) // the middle of the gap after word i
  const brief = (extra) => ({ op: "set_brief", format: "reel-talking-head", targetDuration: ms(8000), mustKeep: [], mustCut: [], effort: "best", ...extra })
  const table = []
  // QG-05: clean cuts land in the gaps; seeded ones in the middle of a word, at a known output time
  {
    let caught = 0
    let onTime = 0
    let alarms = 0
    for (let i = 0; i < 20; i++) {
      const k = 2 + (i % 12)
      const into = pick(0.12, 0.28) // seconds into word k
      const cut = Math.round((1 + k * 0.5 + into) * FLICKS)
      const seeded = build([{ op: "keep_range", asset: "a1", from: gap(0), to: cut }, { op: "keep_range", asset: "a1", from: gap(k + 2), to: gap(k + 8) }])
      const result = await check("QG-05", seeded)
      const expectedAt = result.firstCut
      if (result.status === "failed") {
        caught++
        if (result.at !== undefined && Math.abs(result.at - expectedAt) <= FLICKS / 10) onTime++
        else console.log(`QG-05 seed ${i} at ${result.at / FLICKS}, expected ${expectedAt / FLICKS}`)
      } else console.log(`QG-05 missed seed ${i}: ${JSON.stringify(result.numbers)}`)
      const clean = await check("QG-05", build([{ op: "keep_range", asset: "a1", from: gap(0), to: gap(k) }, { op: "keep_range", asset: "a1", from: gap(k + 2), to: gap(k + 8) }]))
      if (clean.status !== "passed") {
        alarms++
        console.log(`QG-05 false alarm ${i}: ${clean.message} ${JSON.stringify(clean.numbers)}`)
      }
    }
    table.push({ id: "QG-05", detection: caught / 20, onTime: onTime / 20, falseAlarms: alarms / 20 })
  }
  // QG-12: a must-keep line cut, a must-cut line kept, or the length far off the target
  {
    let caught = 0
    let alarms = 0
    for (let i = 0; i < 20; i++) {
      const kind = i % 3
      const keep = [{ op: "keep_range", asset: "a1", from: gap(-1) + Math.round(0.05 * FLICKS), to: gap(9) }, { op: "keep_range", asset: "a1", from: gap(19), to: gap(29) }]
      const seeded =
        kind === 0
          ? build([...keep, brief({ mustKeep: ["a1:s1"], targetDuration: ms(10000) })]) // the middle line was cut
          : kind === 1
            ? build([...keep, brief({ mustCut: ["a1:s2"], targetDuration: ms(10000) })]) // the last line is still there
            : build([...keep, brief({ targetDuration: Math.round(ms(10000) * (1.3 + (i / 20) * 0.6)) })]) // far over the length
      const result = await check("QG-12", seeded)
      if (result.status === "failed") caught++
      else console.log(`QG-12 missed seed ${i}: ${JSON.stringify(result.numbers)}`)
      const clean = await check("QG-12", build([...keep, brief({ mustKeep: ["a1:s0", "a1:s2"], mustCut: ["a1:s1"], targetDuration: Math.round(ms(10000) * (0.95 + (i % 5) * 0.02)) })]))
      if (clean.status !== "passed") {
        alarms++
        console.log(`QG-12 false alarm ${i}: ${clean.message} ${JSON.stringify(clean.numbers)}`)
      }
    }
    table.push({ id: "QG-12", detection: caught / 20, onTime: caught / 20, falseAlarms: alarms / 20 })
  }
  console.log(`EG-4 (cuts and brief):\n${table.map((r) => `${r.id}: detected ${(r.detection * 100).toFixed(0)} %, at the right time ${(r.onTime * 100).toFixed(0)} %, false alarms ${(r.falseAlarms * 100).toFixed(0)} % (20 seeds, 20 clean)`).join("\n")}`)
  for (const r of table) {
    assert.ok(r.detection >= 0.95 && r.onTime >= 0.95, `${r.id} detects ${r.detection}, on time ${r.onTime}`)
    assert.ok(r.falseAlarms <= 0.02, `${r.id} false alarms ${r.falseAlarms}`)
  }
})
