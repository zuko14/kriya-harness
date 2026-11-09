import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { sceneFrame } from "../../../src/edit/core/layout.js"
import { ensureHost, hostCall, stopHost } from "../../../src/edit/host/client.js"
import { blockComposition, measureText, motionRuntime } from "../../../src/edit/engine/motion.js"
import { SCENE_KINDS } from "../../../src/edit/engine/scenes.js"
import { ROOT } from "../../helpers.js"
import { startFakeKriya } from "../../fake-kriya.js"
import { indexOf } from "../script.js"
import { fakeRuntime, rawTake } from "../take.js"
import { chromeSkip, linkMotion } from "./motion-runtime.js"

// Visual scenes in real Chrome, inside the sandbox: every kind in every frame, the longest
// labels, measured; then a whole make through the Host, with real FFmpeg and every gate.

const FLICKS = 705_600_000
const FRAMES = [[1080, 1920, { top: 231, right: 152, bottom: 423, left: 65 }], [1920, 1080, {}], [1080, 1080, {}], [1080, 1350, {}]]
const LONG = "the pancreas releases insulin".slice(0, 32)
const sampleOf = (kind) => {
  const shape = SCENE_KINDS[kind]
  return { kind, theme: "paper", title: "Without insulin glucose floods the whole bloodstream", mode: "floods", items: Array.from({ length: shape.max }, (_, i) => ({ text: `${LONG}`.slice(0, 32 - i), ...(shape.values || kind === "compare" ? { value: String(1200 * (i + 1)), unit: "%" } : {}) })) }
}

test("ET-VS-M1: every kind in every frame, longest labels: nothing clipped, nothing outside, no text on text, big enough", { skip: chromeSkip(), timeout: 280_000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kh-scenes-")))
  const runtime = motionRuntime(linkMotion(home, { hyperframes: false }))
  const items = []
  const areas = new Map()
  for (const [width, height, safe] of FRAMES) {
    const canvas = { width, height }
    const { content } = sceneFrame(canvas, safe, { w: Math.floor(width * 0.8), h: Math.floor(height * 0.12) })
    for (const kind of Object.keys(SCENE_KINDS)) {
      const id = `${width}x${height}-${kind}`
      areas.set(id, { content, height })
      items.push({ id, html: blockComposition({ blockId: "scene", version: 1, variables: sampleOf(kind), placement: content, duration: 8 * FLICKS }, { output: canvas, canvas }), times: [7600] })
    }
  }
  // A definition, at its longest, in its box
  for (const [width, height] of FRAMES) {
    const canvas = { width, height }
    const box = { x: Math.round(width * 0.08), y: Math.round(height * 0.4), w: Math.round(width * 0.78), h: Math.floor(height * 0.18) }
    const id = `${width}x${height}-term`
    areas.set(id, { content: box, height })
    items.push({ id, html: blockComposition({ blockId: "term", version: 1, variables: { text: "type 1 diabetes mellitus", quote: `${"long word ".repeat(10).trim()}…`, source: "Wikipedia" }, placement: box, duration: 6 * FLICKS }, { output: canvas, canvas }), times: [5000] })
  }
  const measured = await measureText({ items, work: join(home, "work"), runtime })
  const problems = []
  for (const [id, sets] of measured) {
    const { content, height } = areas.get(id)
    const boxes = sets[0]
    if (!boxes.length) problems.push(`${id}: no text measured`)
    for (const box of boxes) {
      const name = `${id} "${box.text.slice(0, 24)}"`
      if (box.clipped) problems.push(`${name} clipped`)
      if (box.x < content.x - 1 || box.y < content.y - 1 || box.x + box.w > content.x + content.w + 1 || box.y + box.h > content.y + content.h + 1) problems.push(`${name} outside its box: ${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.w)}x${Math.round(box.h)}`)
      if (box.size / height < 0.02) problems.push(`${name} too small: ${box.size}px`)
    }
    for (const [i, a] of boxes.entries()) for (const b of boxes.slice(i + 1)) if (a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1) problems.push(`${id}: "${a.text.slice(0, 16)}" on "${b.text.slice(0, 16)}"`)
  }
  assert.deepEqual(problems, [])
})

test("ET-VS-M2: a plan's scenes through the Host: real FFmpeg, Chrome and every gate", { skip: chromeSkip(), timeout: 900_000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kh-scenes-make-")))
  const folder = join(home, "work", "reel")
  mkdirSync(folder, { recursive: true })
  const source = join(folder, "take.mov")
  rawTake(source)
  fakeRuntime(home)
  linkMotion(home, { hyperframes: false })
  const index = indexOf()
  const sentence = (start) => index.sentences.find((s) => index.words.find((w) => w.id === s.firstWord).text === start && !index.takes.some((t) => t.sentence === s.id && t.rank !== 1)).id
  const scenes = [
    { from: sentence("It"), to: sentence("It"), kind: "stat", title: "", items: [{ text: "in total", value: "50000", unit: "₹" }] },
    { from: sentence("Our"), to: sentence("Our"), kind: "flow", title: "", mode: "flows", items: [{ text: "users" }, { text: "friends" }] },
    { from: sentence("Start"), to: sentence("Start"), kind: "process", title: "Start small", items: [{ text: "start small" }, { text: "ship fast" }, { text: "listen to your users" }] },
    { from: sentence("It"), to: sentence("It"), kind: "stat", title: "An invented 1,000", items: [{ text: "in total", value: "1000" }] },
  ]
  const fake = await startFakeKriya({
    models: ["budget", "balanced"],
    features: { visuals: true },
    chat(body) {
      const task = body.response_format?.json_schema?.name
      if (task === "scenes") return { content: JSON.stringify({ contentType: "explainer", theme: "paper", scenes }) }
      if (task === "plan") return { content: JSON.stringify({ say: "A clean cut with scenes.", steps: ["Cut it"], settings: { captions: "clean" } }) }
      if (task === "story") return { content: JSON.stringify({ hook: null, drop: [] }) }
      if (task === "emphasis") return { content: JSON.stringify({ emphasis: [] }) }
      return { content: "{}" }
    },
  })
  const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: join(home, "work"), KRIYA_EDIT_IDLE_MS: "600000" }
  const login = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "login", "--url", fake.url, "--no-browser"], { env, stdio: "ignore" })
  assert.equal(await new Promise((done) => login.on("exit", done)), 0)
  await ensureHost({ env, home })
  const call = (method, path, body) => hostCall(home, method, path, body)
  const until = async (id) => {
    for (;;) {
      const row = (await call("GET", "/jobs")).jobs.find((j) => j.id === id)
      if (["done", "failed"].includes(row.status)) return row
      await new Promise((done) => setTimeout(done, 300))
    }
  }
  try {
    const { id } = await call("POST", "/projects", { name: "Explainer", folder })
    const asset = await call("POST", `/projects/${id}/assets`, { path: source })
    await until((await call("POST", `/projects/${id}/index`, { asset: asset.id })).id)
    const plan = await call("POST", `/projects/${id}/plan`, { text: "Make this a 16:9 explainer with clean captions and diagrams", history: [], choices: {} })
    assert.equal(plan.settings.scenes.length, 3, JSON.stringify(plan.steps))
    assert.ok(plan.settings.scenes.every((s) => s.theme === "paper" && /:w\d+$/.test(s.from) && /:w\d+$/.test(s.to)))
    assert.deepEqual(plan.sceneChoices.swaps[0], ["stat"])
    assert.ok(plan.sceneChoices.swaps[2].includes("cycle"))
    assert.equal(plan.brief.format, "16:9")
    assert.equal(plan.brief.scenes.length, 3)

    // Approved, with one swapped on the card
    const approved = { ...plan.brief, scenes: plan.brief.scenes.map((s, i) => (i === 2 ? { ...s, kind: "cycle" } : s)) }
    const started = Date.now()
    const job = await call("POST", `/projects/${id}/make`, { asset: asset.id, brief: approved })
    const done = await until(job.id)
    assert.equal(done.status, "done", done.error)
    const result = JSON.parse(done.output)
    console.log(`ET-VS-M2: verdict ${result.verdict} in ${Math.round((Date.now() - started) / 1000)} s\n${result.gates.map((g) => `${g.id} ${g.status}${g.message ? `: ${g.message}` : ""}`).join("\n")}\n${result.notes.join("\n")}\n${result.changes.filter((c) => /scene/.test(c)).join("\n")}`)
    for (const gate of ["QG-01", "QG-02", "QG-05", "QG-06", "QG-08", "QG-09", "QG-10", "QG-11", "QG-12", "QG-13"]) assert.equal(result.gates.find((g) => g.id === gate)?.status, "passed", `${gate}: ${JSON.stringify(result.gates.find((g) => g.id === gate))}`)
    const timeline = (await call("GET", `/projects/${id}/plan`)).timeline
    const drawn = timeline.overlays.filter((o) => o.block?.blockId === "scene")
    assert.deepEqual(drawn.map((o) => o.block.variables.kind), ["stat", "flow", "cycle"])
    const video = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", result.file])).streams.find((s) => s.codec_type === "video")
    assert.deepEqual([video.width, video.height], [1920, 1080])
    // The frame under a scene isn't the speaker's: the scene's flat paper colour fills a corner
    const seconds = (drawn[1].at + drawn[1].end) / 2 / FLICKS
    const raw = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", seconds.toFixed(3), "-i", result.file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: 16 * 1024 * 1024 })
    const corner = [raw[0], raw[1], raw[2]]
    assert.ok(corner.every((c) => c > 200), `corner ${corner}`)
  } finally {
    await stopHost(home)
    await fake.close?.()
  }
})

test("ET-VS-REG-01 on a real Host: a server with no such switch gets no scenes, no extra call, no preview, and a make drops any it's sent", { skip: chromeSkip(), timeout: 600_000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kh-scenes-off-")))
  const folder = join(home, "work", "reel")
  mkdirSync(folder, { recursive: true })
  const source = join(folder, "take.mov")
  rawTake(source)
  fakeRuntime(home)
  linkMotion(home, { hyperframes: false })
  const tasks = []
  const fake = await startFakeKriya({
    models: ["budget", "balanced"],
    chat(body) {
      const task = body.response_format?.json_schema?.name
      tasks.push(task)
      return { content: JSON.stringify(task === "plan" ? { say: "A cut.", steps: [], settings: {} } : {}) }
    },
  })
  const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: join(home, "work"), KRIYA_EDIT_IDLE_MS: "600000" }
  const login = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "login", "--url", fake.url, "--no-browser"], { env, stdio: "ignore" })
  assert.equal(await new Promise((done) => login.on("exit", done)), 0)
  await ensureHost({ env, home })
  const call = (method, path, body) => hostCall(home, method, path, body)
  try {
    const { id } = await call("POST", "/projects", { name: "Off", folder })
    const asset = await call("POST", `/projects/${id}/assets`, { path: source })
    const indexing = await call("POST", `/projects/${id}/index`, { asset: asset.id })
    for (;;) {
      const row = (await call("GET", "/jobs")).jobs.find((j) => j.id === indexing.id)
      if (["done", "failed"].includes(row.status)) break
      await new Promise((done) => setTimeout(done, 200))
    }
    const plan = await call("POST", `/projects/${id}/plan`, { text: "Add animations and make a cut", history: [], choices: {} })
    assert.deepEqual(tasks, ["plan"], "no scenes slot")
    assert.equal(plan.settings.scenes, undefined)
    assert.equal(plan.sceneChoices, undefined)
    const refused = await call("GET", `/projects/${id}/scene-preview?scene=${encodeURIComponent(JSON.stringify({ kind: "stat", from: "a1:w0", to: "a1:w9", items: [{ text: "x", value: "1" }] }))}`).then(() => null, (error) => error)
    assert.match(refused?.message ?? "", /aren't on/)
    const job = await call("POST", `/projects/${id}/make`, { asset: asset.id, brief: { seconds: 45, scenes: [{ kind: "stat", from: "a1:w0", to: "a1:w9", items: [{ text: "x", value: "1" }] }] } })
    for (;;) {
      const row = (await call("GET", "/jobs")).jobs.find((j) => j.id === job.id)
      if (["done", "failed"].includes(row.status)) break
      await new Promise((done) => setTimeout(done, 300))
    }
    const { timeline } = await call("GET", `/projects/${id}/plan`)
    assert.deepEqual(timeline.overlays.filter((o) => o.block?.blockId === "scene"), [], "dropped at the route")
  } finally {
    await stopHost(home)
    await fake.close?.()
  }
})
