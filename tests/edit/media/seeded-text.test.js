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
import { motionRuntime, renderTile, tileDocument } from "../../../src/edit/engine/motion.js"
import { probe } from "../../../src/edit/engine/probe.js"
import { runGates } from "../../../src/edit/gates/index.js"
import { judgeMotion, tileFrames } from "../../../src/edit/gates/picture.js"
import { openJournal } from "../../../src/edit/graph/journal.js"
import { runTool } from "../../../src/edit/engine/tool.js"
import { makeProject, ms } from "../fixture.js"
import { linkMotion, motionSkip } from "./motion-runtime.js"

// EG-4 for the text and motion gates, at a smaller scale than the file gates because
// each case is a real HyperFrames render: 10 seeds per gate against 10 clean masters
// (QG-08, -09, -10), and 10 still against 10 moving tiles (QG-11). Synthetic only.

const FLICKS = 705_600_000
const W = 540
const H = 960
const skip = motionSkip()
const dir = realpathSync(mkdtempSync(join(tmpdir(), "kh-seeded-text-")))
const ffmpeg = (...args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args, "-y"])
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex")
const NAMES = ["Asha", "Ravi", "Meera", "Kiran", "Divya", "Arjun", "Leela", "Vikram", "Nisha", "Rohan"]

test("EG-4 for QG-08, -09, -10 and -11 on real renders: every seed caught at its time, no false alarm", { skip, timeout: 1_800_000 }, async () => {
  const runtime = motionRuntime(linkMotion(join(dir, "home")))
  ffmpeg("-f", "lavfi", "-i", `testsrc2=s=${W}x${H}:r=30:d=4`, "-f", "lavfi", "-i", "sine=f=220:r=48000:d=4", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-c:a", "aac", "-shortest", join(dir, "chart.mov"))
  ffmpeg("-f", "lavfi", "-i", `color=c=white:s=${W}x${H}:r=30:d=4`, "-f", "lavfi", "-i", "sine=f=220:r=48000:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-c:a", "aac", "-shortest", join(dir, "white.mov"))
  const capabilities = await readCapabilities()
  const facts = { chart: (await probe(join(dir, "chart.mov"))).facts, white: (await probe(join(dir, "white.mov"))).facts }
  const index = (name, faces = []) => ({ words: ["It", "cost", name, "fifty"].map((text, i) => ({ asset: "a1", id: `a1:w${i}`, start: ms(500 + i * 600), end: ms(1000 + i * 600), text })), sentences: [], shots: [], faces })
  const run = async (name, i, ops, { source = "chart", faces = [], edit } = {}) => {
    const root = realpathSync(mkdtempSync(join(dir, `${name}-${i}-`)))
    const project = structuredClone(makeProject())
    project.canvas = { ...project.canvas, width: W, height: H, fps: { n: 30, d: 1 } }
    project.assets = [{ ...project.assets[0], id: "a1", path: join(dir, `${source}.mov`), fingerprint: sha(join(dir, `${source}.mov`)), facts: facts[source] }]
    const idx = index(NAMES[i], faces)
    const applied = apply(project, [{ op: "keep_range", asset: "a1", from: 0, to: ms(4000) }, { op: "add_deliverable", preset: "reel-9x16", size: { width: W, height: H }, fps: { n: 30, d: 1 }, codec: "h264", audio: "aac", loudness: { lufs: -14, tp: -1 }, burnCaptions: true }, ...ops], { index: idx })
    assert.deepEqual(applied.diagnostics, [])
    // A person's edit of the caption's text, on the caption the solver placed
    if (edit) {
      const clip = applied.project.sequences[0].clips.find((c) => c.effects.some((e) => e.type === "caption")).id
      const edited = apply(applied.project, [{ op: "caption_edit", caption: clip, text: edit }], { index: idx })
      assert.deepEqual(edited.diagnostics, [])
      applied.project = edited.project
    }
    const engine = createEngine({ folder: root, roots: [root, dir], cache: join(root, "cache"), exports: join(root, "exports"), journal: openJournal(":memory:"), toolVersion: "9", capabilities, motion: () => runtime })
    engine.load(applied.project, idx)
    const { file, plan } = await engine.render({ quality: "master", deliverable: applied.project.deliverables[0].id })
    const checked = await runGates({ file, plan, project: applied.project, index: idx, sourcePath: () => join(dir, `${source}.mov`), only: ["QG-08", "QG-09", "QG-10"], tilePath: engine.tilePath, motion: runtime, work: join(root, "gates"), binDir: join(dir, "bin") })
    return { gates: Object.fromEntries(checked.gates.map((g) => [g.id, g])), caption: plan.tiles.find((t) => t.kind === "caption") }
  }
  const page = ["a1:w0", "a1:w1", "a1:w2", "a1:w3"]
  const rows = []
  const tally = (id, outcomes) => rows.push({ id, ...outcomes })

  // The clean set: karaoke over the chart, placed by the solver
  const clean = []
  for (let i = 0; i < 10; i++) clean.push(await run("clean", i, [{ op: "caption_style", look: "karaoke", words: page }]))

  // QG-08: a caption pinned on a face, or under the reel's bottom margin
  {
    let caught = 0
    let onTime = 0
    for (let i = 0; i < 10; i++) {
      const y = 300 + i * 20
      const faces = i % 2 ? [] : [{ asset: "a1", shot: null, t: ms(1000), box: { x: 100, y, w: 300, h: 260 } }, { asset: "a1", shot: null, t: ms(2000), box: { x: 100, y, w: 300, h: 260 } }]
      const placement = i % 2 ? { x: 40, y: 760 + i * 4, w: 420, h: 140 } : { x: 40, y: y + 40, w: 420, h: 140 }
      const { gates, caption } = await run("qg08", i, [{ op: "caption_style", look: "karaoke", words: page, placement }], { faces })
      if (gates["QG-08"].status === "failed") {
        caught++
        if (Math.abs(gates["QG-08"].numbers.first.t - caption.at) <= FLICKS) onTime++
      } else console.log(`QG-08 missed ${i}: ${JSON.stringify(gates["QG-08"].numbers)}`)
    }
    tally("QG-08", { caught, onTime, alarms: clean.filter((c) => c.gates["QG-08"].status !== "passed").length })
  }
  // QG-09: light text with no plate over white
  {
    let caught = 0
    const colours = ["#ffd23f", "#ffe680", "#f5f5f5", "#ffcc99", "#ccffcc", "#e0e0ff", "#fff0b3", "#ffb3b3", "#d9f2ff", "#eeeeee"]
    for (let i = 0; i < 10; i++) {
      const { gates } = await run("qg09", i, [{ op: "set_look", caption: { color: colours[i], stroke: "none" } }, { op: "caption_style", look: "clean", words: page }], { source: "white" })
      if (gates["QG-09"].status === "failed" && gates["QG-09"].numbers.first.kind === "low_contrast") caught++
      else console.log(`QG-09 missed ${i}: ${JSON.stringify(gates["QG-09"].numbers)}`)
    }
    tally("QG-09", { caught, onTime: caught, alarms: clean.filter((c) => c.gates["QG-09"].status !== "passed").length })
  }
  // QG-10: the name on screen isn't the name that was said (a misspelling in the caption's text)
  {
    let caught = 0
    let onTime = 0
    for (let i = 0; i < 10; i++) {
      const wrong = `${NAMES[i].slice(0, -1)}${NAMES[i].endsWith("a") ? "i" : "a"}`
      const { gates, caption } = await run("qg10", i, [{ op: "caption_style", look: "karaoke", words: page }], { edit: `It cost ${wrong} fifty` })
      const name = (gates["QG-10"].failures ?? []).find((f) => f.kind === "name_mismatch")
      if (name) {
        caught++
        if (Math.abs(name.t - (caption.at + ms(1200))) <= FLICKS / 2) onTime++
      } else console.log(`QG-10 missed ${i}: ${JSON.stringify(gates["QG-10"])}`)
    }
    tally("QG-10", { caught, onTime, alarms: clean.filter((c) => c.gates["QG-10"].status !== "passed").length })
  }
  // QG-11: a still card against a moving one, at the tile
  {
    let caught = 0
    let alarms = 0
    for (let i = 0; i < 10; i++) {
      for (const moving of [false, true]) {
        const animations = moving ? [{ id: "c", keyframes: [{ opacity: 0, transform: "translateY(120px)" }, { opacity: 1, transform: "translateY(0)" }], options: { duration: 600, fill: "both" } }] : []
        const html = tileDocument({ width: W, height: H, duration: 2 * FLICKS, css: `#c{position:absolute;left:60px;top:${300 + i * 10}px;width:420px;height:160px;background:#13292b}`, body: '<div id="c"></div>', animations })
        const out = join(dir, `qg11-${i}-${moving}.mov`)
        await renderTile({ html, work: join(dir, `qg11-${i}-${moving}.work`), output: out, fps: { n: 30, d: 1 }, runtime, seconds: 2 })
        const judged = judgeMotion([{ tile: { at: 0 }, frames: await tileFrames(out, runTool), expected: 60 }], { minMotion: 0.5 })
        if (!moving && judged.failures.some((f) => f.kind === "no_motion")) caught++
        if (moving && judged.failures.length) alarms++
      }
    }
    tally("QG-11", { caught, onTime: caught, alarms })
  }
  console.log(`EG-4 (text and motion gates):\n${rows.map((r) => `${r.id}: detected ${r.caught}/10, at the right time ${r.onTime}/10, false alarms ${r.alarms}/10`).join("\n")}`)
  for (const r of rows) {
    assert.equal(r.caught, 10, `${r.id} caught ${r.caught}/10`)
    assert.equal(r.onTime, 10, `${r.id} on time ${r.onTime}/10`)
    assert.equal(r.alarms, 0, `${r.id} false alarms ${r.alarms}/10`)
  }
})
