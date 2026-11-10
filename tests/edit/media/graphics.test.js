import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { GRAPHIC_KINDS } from "../../../src/edit/engine/graphics.js"
import { blockComposition, measureText, motionRuntime } from "../../../src/edit/engine/motion.js"
import { ensureHost, hostCall, stopHost } from "../../../src/edit/host/client.js"
import { ROOT } from "../../helpers.js"
import { startFakeKriya } from "../../fake-kriya.js"
import { indexOf } from "../script.js"
import { fakeRuntime, rawTake } from "../take.js"
import { chromeSkip, linkMotion } from "./motion-runtime.js"

// The motion kit in real Chrome, inside the sandbox: every kind and style in every frame at
// its longest, measured; then a plan's graphics and one added in chat, made through the Host
// with real FFmpeg and every gate; then the same Host with the switch off.

const FLICKS = 705_600_000
const FRAMES = [[1080, 1920], [1920, 1080], [1080, 1080], [1080, 1350]]
const LONGEST = "How we built the whole thing in under one week!!" // 48 characters
const LONGEST_SUBTITLE = "Founder and chief executive, Kri" // 32
const boxOf = (width, height) => ({ x: Math.round(width * 0.1), y: Math.round(height * 0.6), w: Math.floor(width * 0.8), h: Math.floor(height * 0.12) })

test("ET-MG-M1: every kind and style in every frame, at its longest: nothing clipped, nothing outside its box, big enough", { skip: chromeSkip(), timeout: 280_000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kh-graphics-")))
  const runtime = motionRuntime(linkMotion(home, { hyperframes: false }))
  const items = []
  const boxes = new Map()
  const shots = process.env.KRIYA_SHOTS
  for (const [width, height] of FRAMES) {
    const canvas = { width, height }
    const placement = boxOf(width, height)
    for (const [kind, shape] of Object.entries(GRAPHIC_KINDS)) {
      for (const style of shape.styles) {
        for (const [name, text, subtitle] of [["long", shape.number ? "₹1,234,567.50 crore" : LONGEST, LONGEST_SUBTITLE], ["short", shape.number ? "50%" : "Start small", "Founder"]]) {
          const id = `${width}x${height}-${kind}-${style}-${name}`
          const html = blockComposition({ blockId: "graphic", version: 1, variables: { kind, style, text, subtitle, accent: "yellow" }, placement, duration: 4 * FLICKS }, { output: canvas, canvas })
          boxes.set(id, { placement, height })
          items.push({ id, html, times: [2000] })
          if (shots && name === "short") writeFileSync(join(shots, `${id}.html`), html.replace("html,body{margin:0;background:transparent", "html,body{margin:0;background:linear-gradient(160deg,#6b7b80,#2a3437)"))
        }
      }
    }
  }
  const measured = await measureText({ items, work: join(home, "work"), runtime })
  const problems = []
  for (const [id, sets] of measured) {
    const { placement, height } = boxes.get(id)
    if (!sets[0].length) problems.push(`${id}: no text measured`)
    for (const box of sets[0]) {
      const name = `${id} "${box.text.slice(0, 20)}"`
      if (box.clipped) problems.push(`${name} clipped`)
      if (box.x < placement.x - 1 || box.y < placement.y - 1 || box.x + box.w > placement.x + placement.w + 1 || box.y + box.h > placement.y + placement.h + 1) problems.push(`${name} outside its box: ${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.w)}x${Math.round(box.h)} in ${JSON.stringify(placement)}`)
      if (box.size / height < 0.02) problems.push(`${name} too small: ${box.size}px`)
    }
    for (const [i, a] of sets[0].entries()) for (const b of sets[0].slice(i + 1)) if (a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1) problems.push(`${id}: "${a.text.slice(0, 16)}" on "${b.text.slice(0, 16)}"`)
  }
  assert.equal(measured.size, items.length)
  assert.deepEqual(problems, [])
})

async function world(prefix, features) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  const folder = join(home, "work", "reel")
  mkdirSync(folder, { recursive: true })
  const source = join(folder, "take.mov")
  rawTake(source)
  fakeRuntime(home)
  linkMotion(home, { hyperframes: false })
  const index = indexOf()
  const word = (text) => index.words.find((w) => w.text === text && !w.flags.length).id
  const tasks = []
  const graphics = [
    { kind: "intro", text: "How we built this" },
    { kind: "stat", text: "50000", subtitle: "rupees in total", at: word("fifty") },
    { kind: "title", style: "slam", text: "Guaranteed to go viral", at: word("design.") },
    { kind: "quote", text: "start small, ship fast", at: word("ship") },
    { kind: "end", text: "Thanks for watching" },
  ]
  const fake = await startFakeKriya({
    models: ["budget"],
    features,
    chat(body) {
      const task = body.response_format?.json_schema?.name
      tasks.push(task)
      if (task === "graphics") return { content: JSON.stringify({ graphics }) }
      if (task === "plan") return { content: JSON.stringify({ say: "A clean cut with graphics.", steps: ["Cut it"], settings: { captions: "clean", music: "none", cutSound: "none" } }) }
      if (task === "story") return { content: JSON.stringify({ hook: null, drop: [] }) }
      if (task === "emphasis") return { content: JSON.stringify({ emphasis: [] }) }
      if (task === "console") return { content: JSON.stringify({ ops: [{ op: "add_graphic", kind: "lower", style: "pill", text: "Ravi Kumar", subtitle: "Founder", at: { word: index.sentences[3].firstWord, edge: "start" } }], say: "Added your name." }) }
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
  const { id } = await call("POST", "/projects", { name: "Launch", folder })
  const asset = await call("POST", `/projects/${id}/assets`, { path: source })
  await until((await call("POST", `/projects/${id}/index`, { asset: asset.id })).id)
  return { home, fake, call, until, id, asset, tasks, graphics, index }
}
const drawn = async (w) => (await w.call("GET", `/projects/${w.id}/plan`)).timeline.overlays.filter((o) => o.block?.blockId === "graphic")

test("ET-MG-M2: a plan's graphics and one from chat, through the Host: real FFmpeg, Chrome and every gate; a change keeps them", { skip: chromeSkip(), timeout: 900_000 }, async () => {
  const w = await world("kh-graphics-make-", { visuals: false, playbooks: false, mediaSearch: false, motion: true, customMotion: false })
  try {
    const plan = await w.call("POST", `/projects/${w.id}/plan`, { text: "Make this a 16:9 video with clean captions and motion graphics, yellow accent colour", history: [], choices: {} })
    assert.deepEqual(plan.settings.graphics.map((g) => [g.kind, g.accent]), [["intro", "yellow"], ["stat", "yellow"], ["quote", "yellow"], ["end", "yellow"]], JSON.stringify(plan.steps))
    assert.ok(!plan.settings.graphics.some((g) => /viral/.test(g.text)), "a title the speaker never said isn't on the card")
    assert.deepEqual(plan.graphicChoices.kinds.title.styles, ["rise", "slam", "words"])

    const make = async (brief, sent = plan) => {
      const started = Date.now()
      const done = await w.until((await w.call("POST", `/projects/${w.id}/make`, { asset: w.asset.id, brief, plan: { say: sent.say, steps: sent.steps, settings: sent.settings } })).id)
      assert.equal(done.status, "done", done.error)
      const result = JSON.parse(done.output)
      console.log(`ET-MG-M2: verdict ${result.verdict} in ${Math.round((Date.now() - started) / 1000)} s\n${result.gates.map((g) => `${g.id} ${g.status}${g.message ? `: ${g.message}` : ""}`).join("\n")}\n${result.notes.join("\n")}`)
      for (const gate of ["QG-01", "QG-02", "QG-05", "QG-06", "QG-08", "QG-09", "QG-10", "QG-11", "QG-12"]) assert.equal(result.gates.find((g) => g.id === gate)?.status, "passed", `${gate}: ${JSON.stringify(result.gates.find((g) => g.id === gate))}`)
      return result
    }
    const one = await make(plan.brief)
    assert.deepEqual((await drawn(w)).map((o) => o.block.variables.kind), ["intro", "stat", "quote", "end"])
    assert.ok(one.changes.some((c) => /^Added a number "50000", "rupees in total"/.test(c)), one.changes.join(" | "))
    const video = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", one.file])).streams.find((s) => s.codec_type === "video")
    assert.deepEqual([video.width, video.height], [1920, 1080])
    // The stat's plate is in the picture: a frame while it's up differs from the same frame of a cut without it
    const stat = (await drawn(w))[1]
    const shot = process.env.KRIYA_SHOTS
    if (shot) execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", ((stat.at + stat.end) / 2 / FLICKS).toFixed(3), "-i", one.file, "-frames:v", "1", join(shot, "made-stat-frame.png")])

    // The person adds a name strap by asking; it is theirs, so a later change to the plan keeps it
    const asked = await w.call("POST", `/projects/${w.id}/ask`, { text: "add a name strap: Ravi Kumar, Founder", history: [] })
    assert.deepEqual(asked.proposal.changes.map((c) => c.replace(/ at .*/, "")), ['Added a name strap "Ravi Kumar", "Founder"'])
    await w.call("POST", `/projects/${w.id}/proposals/${asked.proposal.id}`, { accept: true })
    assert.equal((await drawn(w)).length, 5)

    const second = await w.call("POST", `/projects/${w.id}/plan`, { text: "make the whole video warmer", history: [], choices: {} })
    assert.equal(second.revises, true)
    assert.equal(second.settings.graphics.length, 4, "the plan's graphics are kept on a change that doesn't mention them")
    assert.equal(w.tasks.filter((t) => t === "graphics").length, 1, "and not asked for again")
    await make(second.brief, second)
    const after = await drawn(w)
    assert.deepEqual(after.map((o) => [o.block.variables.kind, !!o.block.variables.plan]).sort(), [["end", true], ["intro", true], ["lower", false], ["quote", true], ["stat", true]], "the plan's own once each, the chat one still there")
  } finally {
    await stopHost(w.home)
    await w.fake.close?.()
  }
})

/** The Plan Card's preview document, fetched as the Studio's frame does. */
async function fetchPreview(w, graphic) {
  return w.call("GET", `/projects/${w.id}/graphic-preview?format=16:9&graphic=${encodeURIComponent(JSON.stringify(graphic))}`)
}

test("ET-MG-REG-01 on a real Host: a server without the switch gets no graphics, no extra call, no preview, and a make drops any it's sent", { skip: chromeSkip(), timeout: 600_000 }, async () => {
  const w = await world("kh-graphics-off-", { visuals: false, playbooks: false, mediaSearch: false })
  try {
    const plan = await w.call("POST", `/projects/${w.id}/plan`, { text: "Make this with motion graphics and a lower third", history: [], choices: {} })
    assert.equal(plan.settings.graphics, undefined)
    assert.equal(plan.graphicChoices, undefined)
    assert.ok(!w.tasks.includes("graphics"), "no extra model call")
    await assert.rejects(fetchPreview(w, w.graphics[0]), /aren't on/)
    const done = await w.until((await w.call("POST", `/projects/${w.id}/make`, { asset: w.asset.id, brief: { seconds: 45, graphics: w.graphics } })).id)
    assert.equal(done.status, "done", done.error)
    assert.deepEqual(await drawn(w), [])
    // Chat can't add one either: the console's answer isn't an operation it knows
    const asked = await w.call("POST", `/projects/${w.id}/ask`, { text: "add a name strap: Ravi Kumar, Founder", history: [] })
    assert.equal(asked.proposal, null)
  } finally {
    await stopHost(w.home)
    await w.fake.close?.()
  }
})

test("ET-TR-M4: a plan's transitions through the Host: real FFmpeg, every gate, and the cut as long as without them", { skip: chromeSkip(), timeout: 900_000 }, async () => {
  const w = await world("kh-transitions-make-", { visuals: false, playbooks: false, mediaSearch: false, motion: true, customMotion: false })
  try {
    const make = async (text) => {
      const plan = await w.call("POST", `/projects/${w.id}/plan`, { text, history: [], choices: {} })
      const done = await w.until((await w.call("POST", `/projects/${w.id}/make`, { asset: w.asset.id, brief: plan.brief, plan: { say: plan.say, steps: plan.steps, settings: plan.settings } })).id)
      assert.equal(done.status, "done", done.error)
      return { plan, result: JSON.parse(done.output), compiled: await w.call("GET", `/projects/${w.id}/plan`) }
    }
    const plain = await make("Make this 16:9, no graphics, no captions")
    assert.equal(plain.plan.brief.transition, undefined)
    const dressed = await make("slide transitions on every cut, no graphics, no captions")
    assert.deepEqual([dressed.plan.brief.transition, dressed.plan.brief.transitionAll], ["slide", true])
    assert.equal(dressed.plan.revises, true)
    console.log(`ET-TR-M4: verdict ${dressed.result.verdict}\n${dressed.result.gates.map((g) => `${g.id} ${g.status}${g.message ? `: ${g.message}` : ""}`).join("\n")}\n${dressed.result.notes.join("\n")}`)
    for (const gate of ["QG-01", "QG-02", "QG-03", "QG-05", "QG-06", "QG-07", "QG-12"]) assert.equal(dressed.result.gates.find((g) => g.id === gate)?.status, "passed", `${gate}: ${JSON.stringify(dressed.result.gates.find((g) => g.id === gate))}`)
    const entered = dressed.compiled.segments.flatMap((s) => s.node.picture.filter((p) => p.enter).map((p) => ({ at: s.start + p.at, ...p.enter })))
    const cuts = dressed.compiled.timeline.picture.filter((p) => !p.hold).length - 1
    assert.ok(entered.length >= 3 && entered.length <= cuts, `${entered.length} transitions on ${cuts} cuts`)
    assert.ok(entered.every((e) => e.kind === "slide"))
    assert.equal(dressed.compiled.duration, plain.compiled.duration, "not a frame longer or shorter")
    assert.deepEqual(dressed.compiled.timeline.picture.map((p) => [p.at, p.end]), plain.compiled.timeline.picture.map((p) => [p.at, p.end]))
    assert.ok(dressed.result.changes.some((c) => /^Added a slide transition into /.test(c)), dressed.result.changes.join(" | "))
    const shot = process.env.KRIYA_SHOTS
    if (shot) execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", ((entered[1].at + entered[1].duration / 2) / FLICKS).toFixed(3), "-i", dressed.result.file, "-frames:v", "1", join(shot, "made-slide-frame.png")])
  } finally {
    await stopHost(w.home)
    await w.fake.close?.()
  }
})
