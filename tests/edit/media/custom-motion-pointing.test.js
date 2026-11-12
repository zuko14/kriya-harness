import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { createServer, request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"

import { chromium } from "playwright-core"

import { browserTarget } from "../../../src/browser.js"
import { apply } from "../../../src/edit/core/ops.js"
import { expandMark } from "../../../src/edit/director/revise.js"
import { readCapabilities } from "../../../src/edit/engine/capabilities.js"
import { confine } from "../../../src/edit/engine/confine.js"
import { CUSTOM_BLOCK, CUSTOM_VERSION, customVariables } from "../../../src/edit/engine/custom.js"
import { createEngine } from "../../../src/edit/engine/index.js"
import { customDocument, measureText, motionRuntime, renderTile } from "../../../src/edit/engine/motion.js"
import { probe } from "../../../src/edit/engine/probe.js"
import { runGates } from "../../../src/edit/gates/index.js"
import { gateCustomTile } from "../../../src/edit/gates/tile.js"
import { openJournal } from "../../../src/edit/graph/journal.js"
import { ensureHost, hostCall, stopHost } from "../../../src/edit/host/client.js"
import { hostHeaders, socketPath } from "../../../src/edit/host/paths.js"
import { buildStudio } from "../../../studio/build.js"
import { ROOT } from "../../helpers.js"
import { startFakeKriya } from "../../fake-kriya.js"
import { makeProject, ms } from "../fixture.js"
import { barcodeVideo } from "./barcode.js"
import { chromeSkip, linkMotion } from "./motion-runtime.js"

// TP9 on real media (TOP_TIER_PLAN §4 TP9): a model-written custom animation rendered in the runtime's
// Chrome inside the OS sandbox and judged by QG-08…11, its probes blocked (ET-SEC-04) and its words
// literal (ET-SEC-02), refused when editing.customMotion is off; a drawn box reaching a callout, a
// region blur, a mask and a zoom as typed data, checked on the rendered pixels; and the Studio's drawing
// tool and the custom animation's card through a real Host and a fake Kriya, at 360 and 1280 px, light
// and dark. The "model" is a script: no paid call (EB-07), no `balanced` model chosen yet (EB-06).

const F = 705_600_000
const FPS = 30
const W = 540
const H = 960
const skip = chromeSkip()
const dir = realpathSync(mkdtempSync(join(tmpdir(), "kh-tp9-")))
const ffmpeg = (...args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args, "-y"])
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex")
const CONFINED = { kind: "sandbox-exec" }
let capabilities
let runtime

// "We built the whole thing in a week" from 1 s, 500 ms a word
const WORDS = ["We", "built", "the", "whole", "thing", "in", "a", "week.", "Fifty", "thousand"].map((text, i) => ({ asset: "a1", id: `a1:w${i}`, start: ms(1000 + i * 500), end: ms(1400 + i * 500), text, lang: "en", speaker: "s0", conf: 1 }))
const INDEX = { words: WORDS, sentences: [], shots: [], faces: [] }

/** A spinning badge with one line of words on its own plate, designed for a canvas; what the scripted model sends. */
export function badge({ width, height }, texts = ["We built the whole thing"]) {
  const u = (n) => Math.round((n * Math.min(width, height)) / 540)
  return {
    name: "Spinning badge",
    css: `#badge{position:absolute;left:${Math.round(width / 2 - u(75))}px;top:${Math.round(height * 0.18)}px;width:${u(150)}px;height:${u(150)}px}#plate{position:absolute;left:${Math.round(width * 0.12)}px;top:${Math.round(height * 0.44)}px;width:${Math.round(width * 0.76)}px;box-sizing:border-box;padding:${u(10)}px ${u(16)}px;background:#13292b;border-radius:${u(12)}px;text-align:center}#line{display:block;color:#f2eadf;font:800 ${u(30)}px/1.2 Helvetica,Arial,sans-serif;background:#13292b}${texts.length > 1 ? `#plate2{position:absolute;left:${Math.round(width * 0.12)}px;top:${Math.round(height * 0.56)}px;width:${Math.round(width * 0.76)}px;box-sizing:border-box;padding:${u(10)}px;background:#13292b;text-align:center}#line2{display:block;color:#f2eadf;font:700 ${u(22)}px/1.25 Helvetica,Arial,sans-serif;background:#13292b;white-space:pre-line}` : ""}`,
    body: `<svg id="badge" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="none" stroke="#ffb347" stroke-width="8"/><path d="M50 6 L50 26" stroke="#4fd1c5" stroke-width="10"/></svg><div id="plate"><span id="line" data-slot="0"></span></div>${texts.length > 1 ? '<div id="plate2"><span id="line2" data-slot="1"></span></div>' : ""}`,
    animations: [
      { id: "badge", keyframes: [{ transform: "rotate(0deg) scale(0.6)", opacity: 0 }, { transform: "rotate(180deg) scale(1)", opacity: 1, offset: 0.3 }, { transform: "rotate(720deg) scale(1)", opacity: 1 }], options: { duration: 3000, easing: "linear", fill: "both" } },
      { id: "plate", keyframes: [{ opacity: 0, transform: "translateY(30px)" }, { opacity: 1, transform: "translateY(0px)" }], options: { duration: 500, delay: 200, fill: "both" } },
    ],
    texts,
  }
}

before(async () => {
  if (skip) return
  capabilities = await readCapabilities()
  runtime = motionRuntime(linkMotion(join(dir, "home"), { hyperframes: false }))
  ffmpeg("-f", "lavfi", "-i", `testsrc2=s=${W}x${H}:r=${FPS}:d=8`, "-f", "lavfi", "-i", "sine=f=220:r=48000:d=8", "-c:v", "libx264", "-crf", "16", "-g", "30", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-c:a", "aac", "-shortest", join(dir, "chart.mov"))
})

async function setup(name, ops, { customMotion = true } = {}) {
  const root = realpathSync(mkdtempSync(join(dir, `${name}-`)))
  const file = join(dir, "chart.mov")
  const { facts } = await probe(file)
  const project = structuredClone(makeProject())
  project.canvas = { ...project.canvas, width: W, height: H, fps: { n: FPS, d: 1 } }
  project.assets = [{ ...project.assets[0], id: "a1", path: file, fingerprint: sha(file), facts }]
  const applied = apply(project, [{ op: "keep_range", asset: "a1", from: 0, to: ms(8000) }, ...ops], { index: INDEX, author: "agent" })
  assert.deepEqual(applied.diagnostics, [])
  const engine = createEngine({ folder: root, roots: [root, dir], cache: join(root, "cache"), exports: join(root, "exports"), journal: openJournal(":memory:"), toolVersion: "9", capabilities, motion: () => runtime, customMotion: () => customMotion })
  engine.load(applied.project, INDEX)
  return { engine, project: applied.project, root }
}

/** One frame as raw RGB. */
const frameAt = (file, seconds) => execFileSync("ffmpeg", ["-v", "error", "-ss", seconds.toFixed(3), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 26 })
/** Mean of each channel over a box of a frame. */
function meanOf(frame, { x, y, w, h }) {
  const sum = [0, 0, 0]
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) for (let c = 0; c < 3; c++) sum[c] += frame[(j * W + i) * 3 + c]
  return sum.map((v) => v / (w * h))
}
/**
 * Mean absolute difference of two frames over a box, and each one's hard edges there: steps of more than 40
 * between neighbours (a blur keeps a bar's total change but spreads it, so it is the hard steps that go)
 */
function compare(a, b, { x, y, w, h }) {
  let diff = 0
  let edgesA = 0
  let edgesB = 0
  for (let j = y; j < y + h; j++) {
    for (let i = x; i < x + w; i++) {
      for (let c = 0; c < 3; c++) {
        const k = (j * W + i) * 3 + c
        diff += Math.abs(a[k] - b[k])
        if (i > x) ((edgesA += Math.abs(a[k] - a[k - 3]) > 40 ? 1 : 0), (edgesB += Math.abs(b[k] - b[k - 3]) > 40 ? 1 : 0))
      }
    }
  }
  return { diff: diff / (w * h * 3), edgesA, edgesB }
}
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b

test("MG2 on real media: a custom animation renders confined, passes QG-08…11 on its own tile and in the film, and is left out with a note when the switch is off", { skip, timeout: 280_000 }, async () => {
  const variables = customVariables(badge({ width: W, height: H }))
  assert.ok(variables)
  const node = { blockId: CUSTOM_BLOCK, version: CUSTOM_VERSION, variables, duration: 4 * F }
  // The tile's own check, as the Host runs it before a proposal
  const started = Date.now()
  const own = await gateCustomTile({ node, output: { width: W, height: H, fps: { n: FPS, d: 1 } }, canvas: { width: W, height: H }, safe: { top: 0, right: 0, bottom: 0, left: 0 }, runtime, work: join(dir, "own-gate"), binDir: join(dir, "bin") })
  console.log(`MG2 tile check in ${Date.now() - started} ms: ${own.results.map((r) => `${r.id} ${r.status}`).join(", ")}`)
  assert.ok(own.passed, JSON.stringify(own.results))
  for (const id of ["QG-08", "QG-09", "QG-11"]) assert.equal(own.results.find((r) => r.id === id).status, "passed", id)
  assert.ok(["passed", "not_checked"].includes(own.results.find((r) => r.id === "QG-10").status))

  // In a film: the master with the block, and the gates on it
  const op = { op: "add_motion", block: CUSTOM_BLOCK, version: CUSTOM_VERSION, variables, at: ms(1000), duration: 4 * F }
  const on = await setup("mg2-on", [op])
  const base = await setup("mg2-base", [])
  const master = await on.engine.render({ quality: "master" })
  const plain = await base.engine.render({ quality: "master" })
  const tile = master.plan.tiles.find((t) => t.node.blockId === CUSTOM_BLOCK)
  assert.ok(tile, "the custom tile is in the film's plan")
  const checked = await runGates({ file: master.file, plan: master.plan, project: on.project, index: INDEX, sourcePath: () => join(dir, "chart.mov"), only: ["QG-08", "QG-09", "QG-10", "QG-11"], tilePath: on.engine.tilePath, motion: runtime, work: join(on.root, "gates"), binDir: join(dir, "bin") })
  const gates = Object.fromEntries(checked.gates.map((g) => [g.id, g]))
  console.log(`MG2 film gates: ${checked.gates.map((g) => `${g.id} ${g.status}`).join(", ")}`)
  for (const id of ["QG-08", "QG-09", "QG-11"]) assert.equal(gates[id].status, "passed", `${id}: ${JSON.stringify(gates[id])}`)
  assert.ok(["passed", "not_checked"].includes(gates["QG-10"].status), JSON.stringify(gates["QG-10"]))
  // The badge is drawn where it was designed, in its window only
  const plate = { x: Math.round(W * 0.2), y: Math.round(H * 0.45), w: Math.round(W * 0.6), h: 10 }
  const inside = meanOf(frameAt(master.file, 3), plate)
  console.log(`MG2 plate pixels ${inside.map(Math.round)}`)
  assert.ok(Math.abs(inside[0] - 0x13) < 25 && Math.abs(inside[1] - 0x29) < 25 && Math.abs(inside[2] - 0x2b) < 25, `the plate is drawn: ${inside}`)
  assert.ok(compare(frameAt(master.file, 6), frameAt(plain.file, 6), { x: 0, y: 0, w: W, h: H }).diff < 2, "after its window the film is the film without it")

  // Off: the block stays in the project, the film is drawn without it, and the plan says so
  const off = await setup("mg2-off", [op], { customMotion: false })
  const offMaster = await off.engine.render({ quality: "master" })
  assert.equal(offMaster.plan.tiles.some((t) => t.node.blockId === CUSTOM_BLOCK), false)
  assert.ok(offMaster.plan.issues.some((i) => i.code === "custom_motion_off"))
  assert.ok(compare(frameAt(offMaster.file, 3), frameAt(plain.file, 3), { x: 0, y: 0, w: W, h: H }).diff < 2, "off, nothing of it is drawn")
})

test("ET-SEC-04 and ET-SEC-02 on the new caller: a probe slipped into a custom document is stopped by Kriya's CSP under confinement; adversarial words land literally", { skip, timeout: 280_000 }, async () => {
  let hits = 0
  const server = createServer((req, res) => {
    hits++
    res.writeHead(200, { "access-control-allow-origin": "*" }).end("ok")
  })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  const url = `http://127.0.0.1:${server.address().port}/probe`
  try {
    const html = customDocument({ blockId: CUSTOM_BLOCK, version: CUSTOM_VERSION, variables: customVariables(badge({ width: W, height: H })), duration: 3 * F }, { output: { width: W, height: H }, canvas: { width: W, height: H } }, { allowed: true, which: CONFINED })
    // What a lint bypass would look like: a script after Kriya's checks, as if the parts had let one through
    const probe = html.replace("</body>", `<script>fetch(${JSON.stringify(url)},{mode:'no-cors'}).then(()=>{document.getElementById('mg').style.background='#ff0000'}).catch(()=>{document.getElementById('mg').style.background='#00ff00'})</script></body>`)
    const out = join(dir, "probe.mov")
    await renderTile({ html: probe, work: join(dir, "probe-work"), output: out, fps: { n: FPS, d: 1 }, runtime, seconds: 3 })
    const raw = execFileSync("ffmpeg", ["-v", "error", "-ss", "2.8", "-i", out, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 1 << 26 })
    const [r, g] = [raw[(10 * W + 10) * 4], raw[(10 * W + 10) * 4 + 1]]
    console.log(`ET-SEC-04: probe pixel ${r},${g}; loopback hits ${hits}`)
    assert.equal(hits, 0, "the request never left the page")
    assert.ok(g > 200 && r < 60, "the page saw the request refused")
  } finally {
    server.close()
  }
  // Files: the profile Chrome runs under refuses a read outside the runtime and the work folder
  const secret = join(realpathSync(tmpdir()), `kh-tp9-secret-${process.pid}.txt`)
  writeFileSync(secret, "private")
  const { command, args } = confine("/bin/cat", [secret], { read: runtime.reads, write: [dir] })
  assert.throws(() => execFileSync(command, args, { stdio: ["ignore", "pipe", "ignore"] }), "a confined process can't read another folder's file")

  // ET-SEC-02: quotes, colons, a newline and % in a slot, measured on the rendered page
  const said = `It's "50%": a&b\nc <b>x</b>`
  const html = customDocument({ blockId: CUSTOM_BLOCK, version: CUSTOM_VERSION, variables: customVariables(badge({ width: W, height: H }, ["We built", said])), duration: 3 * F }, { output: { width: W, height: H }, canvas: { width: W, height: H } }, { allowed: true, which: CONFINED })
  const [boxes] = (await measureText({ items: [{ id: "t", html, times: [1500] }], work: realpathSync(mkdtempSync(join(dir, "lit-"))), runtime })).get("t")
  assert.deepEqual(boxes.map((b) => b.text), ["We built", said])
})

test("a drawn box on real media: a callout round it, a blur and a mask inside it, a zoom centred on it; checked on the pixels and by the gates", { skip, timeout: 280_000 }, async () => {
  const project = (await setup("point-plan", [])).project
  const mark = (kind, x, y, w, h, at) => ({ kind, x, y, w, h, at: ms(at) })
  const blur = expandMark([{ op: "use_mark", use: "blur", duration: ms(1500) }], { mark: mark("box", 100, 100, 400, 300, 1000), project, index: INDEX, person: "blur this" })
  const mask = expandMark([{ op: "use_mark", use: "mask", duration: ms(1500) }], { mark: mark("box", 100, 100, 400, 300, 3000), project, index: INDEX, person: "mask this" })
  const callout = expandMark([{ op: "use_mark", use: "callout", duration: ms(1500) }], { mark: mark("ring", 550, 400, 300, 200, 5000), project, index: INDEX, person: "callout this" })
  const zoom = expandMark([{ op: "use_mark", use: "zoom", duration: ms(1000) }], { mark: mark("box", 200, 150, 200, 200, 6800), project, index: INDEX, person: "zoom here" })
  for (const made of [blur, mask, callout, zoom]) assert.deepEqual(made.problems, [])
  const ops = [...blur.ops, ...mask.ops, ...callout.ops, ...zoom.ops]
  const pointed = await setup("point", ops)
  const base = await setup("point-base", [])
  const film = await pointed.engine.render({ quality: "master" })
  const plain = await base.engine.render({ quality: "master" })
  const px = (t) => [frameAt(film.file, t), frameAt(plain.file, t)]
  const region = { x: 54, y: 96, w: 216, h: 288 } // 100,100,400,300 thousandths of 540×960, in even pixels
  const inner = { x: region.x + 12, y: region.y + 12, w: region.w - 24, h: region.h - 24 }
  const away = { x: 470, y: 430, w: 60, h: 120 } // a flat bar, clear of every drawn box and of testsrc2's moving parts

  // Blur, 1.0 to 2.5 s: inside softer, outside untouched; before it, nothing
  const [b1, b0] = px(1.8)
  const blurIn = compare(b1, b0, inner)
  const blurOut = compare(b1, b0, away)
  console.log(`blur: inside diff ${blurIn.diff.toFixed(2)}, hard edges ${blurIn.edgesA} against ${blurIn.edgesB}; outside diff ${blurOut.diff.toFixed(2)}`)
  assert.ok(blurIn.edgesB > 300 && blurIn.edgesA < blurIn.edgesB * 0.1, "the drawn region is blurred: its bars' hard edges are gone")
  assert.ok(blurOut.diff < 2, "outside the region the picture is untouched")
  const [e1, e0] = px(0.5)
  assert.ok(compare(e1, e0, { x: 0, y: 0, w: W, h: H }).diff < 2, "before the blur's time, the frame is untouched")

  // Mask, 3.0 to 4.5 s: outside darker, inside as it was
  const [m1, m0] = px(3.8)
  const darker = luma(meanOf(m0, away)) - luma(meanOf(m1, away))
  const maskIn = compare(m1, m0, inner)
  console.log(`mask: outside ${darker.toFixed(1)} luma darker, inside diff ${maskIn.diff.toFixed(2)}`)
  assert.ok(darker > 20, "everything outside the drawn region is darkened")
  assert.ok(maskIn.diff < 3, "inside it, the picture as it was")

  // Callout, 5.0 to 6.5 s: a teal ring on the drawn box's edge, the box's middle as it was
  const box = { x: 297, y: 384, w: 162, h: 192 } // 550,400,300,200 thousandths
  const [c1, c0] = px(5.9)
  const edge = meanOf(c1, { x: box.x + 1, y: box.y + box.h / 2 - 2, w: 3, h: 4 })
  const middle = compare(c1, c0, { x: box.x + 50, y: box.y + 70, w: 60, h: 50 })
  console.log(`callout: ring edge ${edge.map(Math.round)}, middle diff ${middle.diff.toFixed(2)}`)
  assert.ok(Math.abs(edge[0] - 0x4f) < 45 && Math.abs(edge[1] - 0xd1) < 45 && Math.abs(edge[2] - 0xc5) < 45, `the ring is on the drawn edge: ${edge}`)
  assert.ok(middle.diff < 3, "the ring is round the box, not over what it marks")

  // Zoom, 6.8 to 7.8 s: at full zoom the frame's middle is the drawn box's middle
  const [z1, z0] = px(7.3)
  const shown = meanOf(z1, { x: W / 2 - 3, y: H / 2 - 3, w: 6, h: 6 })
  const drawnMiddle = meanOf(z0, { x: Math.round(0.3 * W) - 1, y: Math.round(0.25 * H) - 1, w: 2, h: 2 })
  console.log(`zoom ${zoom.ops[0].scale}×: frame middle ${shown.map(Math.round)}, drawn middle ${drawnMiddle.map(Math.round)}`)
  assert.ok(shown.every((v, c) => Math.abs(v - drawnMiddle[c]) < 40), "the zoom is centred on the drawn box")
  assert.ok(compare(z1, z0, { x: 0, y: 0, w: W, h: H }).diff > 10, "and the frame is zoomed")

  const checked = await runGates({ file: film.file, plan: film.plan, project: pointed.project, index: INDEX, sourcePath: () => join(dir, "chart.mov"), only: ["QG-02", "QG-07", "QG-08", "QG-11"], tilePath: pointed.engine.tilePath, motion: runtime, work: join(pointed.root, "gates") })
  console.log(`pointing film gates: ${checked.gates.map((g) => `${g.id} ${g.status}`).join(", ")}`)
  for (const g of checked.gates) assert.ok(["passed", "not_applicable"].includes(g.status), `${g.id}: ${JSON.stringify(g)}`)
})

/* The Studio, a real Host, a fake Kriya with a scripted model, the runtime's Chrome */

const target = browserTarget()
const STUDIO_WORDS = [["We", "1.000", "1.300"], ["built", "1.300", "1.700"], ["this", "1.700", "2.000"], ["in", "2.100", "2.300"], ["a", "2.300", "2.400"], ["week.", "2.400", "2.900"], ["Our", "4.000", "4.300"], ["users", "4.300", "4.700"], ["loved", "4.700", "5.100"], ["it.", "5.100", "5.500"]]
function fakeRecogniser(home) {
  const media = join(home, "media", "9.9.9")
  mkdirSync(join(media, "python", "bin"), { recursive: true })
  mkdirSync(join(media, "models", "whisper-large-v3-turbo"), { recursive: true })
  const python = join(media, "python", "bin", "python")
  writeFileSync(python, `#!/bin/sh\ncat <<'EOF'\n${STUDIO_WORDS.map(([w, s, e]) => JSON.stringify({ w, s, e, p: 0.95 })).join("\n")}\nEOF\n`)
  chmodSync(python, 0o755)
}
const until = async (check, limit = 120_000) => {
  const end = Date.now() + limit
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((wake) => setTimeout(wake, 250))
  }
}

test("the Studio: draw a box, ring or arrow on the monitor and send it; the custom animation's card plays sandboxed with Approve, Restyle and Remove; 360 and 1280 px, light and dark, clean console", { skip: skip || (target ? false : "no Chrome on this computer"), timeout: 280_000 }, async () => {
  await buildStudio()
  const models = []
  const canvas = { width: 640, height: 360 }
  const fake = await startFakeKriya({
    models: ["budget", "balanced"],
    features: { visuals: false, playbooks: false, mediaSearch: false, motion: true, customMotion: true, assembly: false, livePreview: false, intent: false, craft: false },
    chat(body) {
      models.push(body.model)
      const task = body.response_format?.json_schema?.name
      // The person's own words in this message only: the chat's earlier turns are in the request too
      const asked = /The person asks \(their own words, trusted\): (".*")/.exec(body.messages.find((m) => m.role === "user")?.content ?? "")
      const said = asked ? JSON.parse(asked[1]) : ""
      if (task === "motion") return { content: JSON.stringify(badge(canvas, ["We built this"])) }
      if (task === "console" && /blur this/.test(said)) return { content: JSON.stringify({ ops: [{ op: "use_mark", use: "blur" }], say: "Blurred what you drew." }) }
      if (task === "console" && /callout this/.test(said)) return { content: JSON.stringify({ ops: [{ op: "use_mark", use: "callout" }], say: "Marked it." }) }
      if (task === "console") return { content: JSON.stringify({ ops: [{ op: "custom_motion", text: "a spinning badge that says we built this", at: 0 }], say: "Here's a spinning badge." }) }
      return { content: "{}" }
    },
  })
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kh-")))
  const login = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "login", "--url", fake.url, "--no-browser"], { env: { ...process.env, KRIYA_HOME: home }, stdio: "ignore" })
  assert.equal(await new Promise((done) => login.on("exit", done)), 0)
  linkMotion(home, { hyperframes: false })
  fakeRecogniser(home)
  const folder = join(home, "work", "film")
  mkdirSync(folder, { recursive: true })
  await barcodeVideo(join(folder, "take.mov"), { frames: 240 })
  const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: join(home, "work"), KRIYA_EDIT_IDLE_MS: "600000" }
  const host = await ensureHost({ env, home })
  const call = (method, path, body) => hostCall(home, method, path, body)
  const browser = await chromium.launch({ ...target, headless: true })
  const problems = []
  const shots = process.env.KRIYA_SHOTS
  if (shots) mkdirSync(shots, { recursive: true })
  try {
    const { id } = await call("POST", "/projects", { name: "Film", folder })
    const asset = await call("POST", `/projects/${id}/assets`, { path: join(folder, "take.mov") })
    const job = await call("POST", `/projects/${id}/index`, { asset: asset.id })
    await until(async () => (await call("GET", "/jobs")).jobs.find((j) => j.id === job.id && j.status === "done"))
    await call("PATCH", `/projects/${id}`, { ops: [{ op: "set_format", width: canvas.width, height: canvas.height }, { op: "keep_range", asset: asset.id, from: 0, to: 7 * F }] })
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
    page.on("pageerror", (error) => problems.push(String(error)))
    page.on("console", (message) => message.type() === "error" && problems.push(message.text()))
    const { url } = await call("POST", "/internal/launch")
    await page.goto(url)
    await page.waitForURL(`http://127.0.0.1:${host.port}/`)
    await page.getByRole("link", { name: "Film" }).click()
    await page.waitForFunction(() => window.__studio?.pieces?.length >= 1)
    const tools = page.getByRole("group", { name: "Draw on the frame" })
    await tools.waitFor()

    // Draw a ring on the paused monitor: the drag in screen pixels, the mark in thousandths of the frame
    const drawOn = async (kind, from, to) => {
      await tools.getByRole("button", { name: kind, exact: true }).click()
      const area = await page.locator(".draw-layer").boundingBox()
      await page.mouse.move(area.x + area.width * from[0], area.y + area.height * from[1])
      await page.mouse.down()
      await page.mouse.move(area.x + area.width * to[0], area.y + area.height * to[1], { steps: 6 })
      await page.mouse.up()
    }
    await drawOn("Ring", [0.6, 0.2], [0.85, 0.6])
    assert.equal(await page.locator(".draw-layer ellipse").count(), 1, "the ring is shown on the monitor")
    if (shots) await page.screenshot({ path: join(shots, "drawn-ring-1280-light.png") })
    // The note that says what was drawn reads on the monitor's grey surround (WCAG 4.5:1)
    const noteContrast = await page.evaluate(() => {
      const lum = (c) => (c.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map((v) => Number(v) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
      const [a, b] = [lum(getComputedStyle(document.querySelector(".draw-note")).color), lum(getComputedStyle(document.querySelector(".area-monitor")).backgroundColor)]
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    })
    assert.ok(noteContrast >= 4.5, `the drawing's note reads at ${noteContrast.toFixed(2)}:1`)
    // What the browser sends is caught on its way, so the test reads it exactly
    const sent = []
    page.on("request", (r) => r.method() === "POST" && /\/ask$/.test(r.url()) && sent.push(JSON.parse(r.postData())))
    await page.locator("#prompt").fill("blur this")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    const proposal = page.locator(".proposal").last()
    await proposal.getByText("Blurred what you drew", { exact: false }).waitFor({ timeout: 30_000 })
    assert.deepEqual(sent[0].mark, { kind: "ring", x: 600, y: 200, w: 250, h: 400, at: sent[0].mark.at })
    assert.ok(Number.isSafeInteger(sent[0].mark.at))
    assert.equal(await page.locator(".draw-layer ellipse").count(), 0, "the drawing goes with one message")
    if (shots) await page.screenshot({ path: join(shots, "blur-proposal-1280-light.png") })
    await proposal.getByRole("button", { name: "Accept", exact: true }).click()
    await page.getByText("Applied.", { exact: true }).waitFor()

    // An arrow, then a custom animation's card
    await drawOn("Arrow", [0.2, 0.3], [0.4, 0.55])
    assert.equal(await page.locator(".draw-layer polyline").count(), 1, "the arrow is shown")
    await tools.getByRole("button", { name: "Clear", exact: true }).click()
    assert.equal(await page.locator(".draw-layer *").count(), 0)
    await page.locator("#prompt").fill("add a spinning badge that says we built this")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    const card = page.locator(".custom-motion").last()
    await card.waitFor({ timeout: 120_000 })
    assert.equal(await card.locator("iframe").getAttribute("sandbox"), "allow-scripts")
    await page.frameLocator(".custom-motion iframe >> nth=-1").getByText("We built this").waitFor({ timeout: 20_000 })
    assert.match(await card.innerText(), /QG-08 passed.*QG-09 passed.*QG-11 passed/s)
    assert.doesNotMatch(await page.locator(".proposal").last().innerText(), /\bnull\b|undefined/, "no stray value in the card")
    assert.deepEqual([...new Set(models)].sort(), ["balanced", "budget"])
    for (const name of ["Approve", "Restyle", "Remove", "Play again"]) assert.ok(await card.getByRole("button", { name, exact: true }).isVisible(), name)

    for (const [width, height] of [[1280, 860], [360, 800]]) {
      await page.setViewportSize({ width, height })
      for (const colorScheme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme })
        // What runs past the right edge, by tag and class, so a failure names its element
        const wide = await page.evaluate(() => [...document.querySelectorAll("body *")].filter((el) => el.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(el).position !== "fixed").map((el) => `${el.tagName.toLowerCase()}.${el.getAttribute("class") ?? ""} ${Math.round(el.getBoundingClientRect().right)}`).slice(0, 8))
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width} ${colorScheme}: no sideways scroll; past the edge: ${wide.join(", ")}`)
        for (const control of [...(await card.locator("button").all()), ...(await tools.getByRole("button").all())]) {
          await control.scrollIntoViewIfNeeded()
          const box = await control.boundingBox()
          assert.ok(box.height >= 44 && box.width >= 44, `${width}: a ${Math.round(box.width)}×${Math.round(box.height)} px control`)
        }
        if (shots) {
          await card.scrollIntoViewIfNeeded()
          await page.screenshot({ path: join(shots, `custom-motion-card-${width}-${colorScheme}.png`) })
          await tools.scrollIntoViewIfNeeded()
          await page.screenshot({ path: join(shots, `draw-tools-${width}-${colorScheme}.png`) })
        }
      }
    }
    await page.setViewportSize({ width: 1280, height: 860 })
    await card.getByRole("button", { name: "Approve", exact: true }).click()
    await page.getByText("Applied.", { exact: true }).last().waitFor()
    const after = await call("GET", `/projects/${id}`)
    const saved = after.project.sequences.flatMap((q) => q.clips).filter((c) => c.effects.some((e) => e.type === "block" && e.blockId === CUSTOM_BLOCK))
    assert.equal(saved.length, 1, "the custom animation is in the project only after Approve")
    // The preview route answers its own sandboxed document
    const preview = await new Promise((done, fail) => {
      const req = request({ socketPath: socketPath(home), method: "GET", path: `/projects/${id}/custom-preview?proposal=nope&op=0`, headers: { ...hostHeaders(home) } }, (res) => (res.resume(), res.on("end", () => done(res.statusCode))))
      req.on("error", fail)
      req.end()
    })
    assert.equal(preview, 404, "a proposal that's gone has no preview")
    assert.deepEqual(problems, [], "console clean")
  } finally {
    await browser.close()
    await stopHost(home)
    await fake.close()
  }
})
