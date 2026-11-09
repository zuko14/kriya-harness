import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"

import { apply } from "../../../src/edit/core/ops.js"
import { compile, wholeSegment } from "../../../src/edit/core/plan.js"
import { segmentArgs } from "../../../src/edit/core/ffmpeg.js"
import { captionComposition } from "../../../src/edit/engine/captions.js"
import { readCapabilities } from "../../../src/edit/engine/capabilities.js"
import { confine } from "../../../src/edit/engine/confine.js"
import { createEngine } from "../../../src/edit/engine/index.js"
import { compositionFor, customComposition, measureText, motionEnv, motionRuntime, renderTile, tileDocument } from "../../../src/edit/engine/motion.js"
import { probe } from "../../../src/edit/engine/probe.js"
import { runGates } from "../../../src/edit/gates/index.js"
import { openJournal } from "../../../src/edit/graph/journal.js"
import { makeProject, ms } from "../fixture.js"
import { linkMotion, motionSkip } from "./motion-runtime.js"

// ED8 on real media: HyperFrames tiles rendered inside the macOS sandbox, layered by
// FFmpeg over the base cut, and the two text gates on what was drawn. Synthetic
// pictures only; no person, no real site.

const FLICKS = 705_600_000
const FPS = 30
const W = 540
const H = 960
const skip = motionSkip()
const dir = realpathSync(mkdtempSync(join(tmpdir(), "kh-motion-")))
const ffmpeg = (...args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args, "-y"])
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex")
let capabilities
let runtime

// Ten spoken words, 400 ms each with 100 ms gaps, from 1 s
const WORDS = ["We", "built", "the", "whole", "thing", "in", "a", "week.", "Fifty", "thousand"].map((text, i) => ({ asset: "a1", id: `a1:w${i}`, start: ms(1000 + i * 500), end: ms(1400 + i * 500), text, lang: "en", speaker: "s0", conf: 1 }))
const INDEX = { words: WORDS, sentences: [], shots: [], faces: [] }

before(async () => {
  if (skip) return
  capabilities = await readCapabilities()
  runtime = motionRuntime(linkMotion(join(dir, "home")))
  ffmpeg("-f", "lavfi", "-i", `testsrc2=s=${W}x${H}:r=${FPS}:d=8`, "-f", "lavfi", "-i", "sine=f=220:r=48000:d=8", "-c:v", "libx264", "-crf", "16", "-g", "30", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-c:a", "aac", "-shortest", join(dir, "chart.mov"))
  ffmpeg("-f", "lavfi", "-i", `color=c=white:s=${W}x${H}:r=${FPS}:d=8`, "-f", "lavfi", "-i", "sine=f=220:r=48000:d=8", "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-c:a", "aac", "-shortest", join(dir, "white.mov"))
})

async function setup(name, ops, { source = "chart.mov", index = INDEX, deliverable } = {}) {
  const root = realpathSync(mkdtempSync(join(dir, `${name}-`)))
  const file = join(dir, source)
  const { facts } = await probe(file)
  const project = structuredClone(makeProject())
  project.canvas = { ...project.canvas, width: W, height: H, fps: { n: FPS, d: 1 } }
  project.assets = [{ ...project.assets[0], id: "a1", path: file, fingerprint: sha(file), facts }]
  const all = [{ op: "keep_range", asset: "a1", from: 0, to: ms(8000) }, ...(deliverable ? [{ op: "add_deliverable", preset: "reel-9x16", size: { width: W, height: H }, fps: { n: FPS, d: 1 }, codec: "h264", audio: "aac", loudness: { lufs: -14, tp: -1 }, burnCaptions: true }] : []), ...ops]
  const applied = apply(project, all, { index })
  assert.deepEqual(applied.diagnostics, [])
  const engine = createEngine({ folder: root, roots: [root, dir], cache: join(root, "cache"), exports: join(root, "exports"), journal: openJournal(":memory:"), toolVersion: "9", capabilities, motion: () => runtime })
  engine.load(applied.project, index)
  return { engine, project: applied.project, root }
}

/** Per-frame mean squared error between two files, from FFmpeg's psnr filter. */
function mse(a, b) {
  const stats = join(dir, `psnr-${Math.random().toString(36).slice(2)}.log`)
  ffmpeg("-i", a, "-i", b, "-lavfi", `psnr=stats_file=${stats}`, "-f", "null", "-")
  return readFileSync(stats, "utf8").trim().split("\n").map((line) => Number(/mse_avg:([\d.]+)/.exec(line)[1]))
}

/** Each frame's mean alpha, 0 to 1, of a tile. */
function alphaOf(tile) {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", tile, "-vf", "alphaextract,format=gray", "-f", "rawvideo", "-"], { maxBuffer: 1 << 30 })
  const size = W * H
  const out = []
  for (let f = 0; f * size < raw.length; f++) {
    let sum = 0
    for (let i = f * size; i < (f + 1) * size; i++) sum += raw[i]
    out.push(sum / size / 255)
  }
  return out
}

const frameCount = (file) => Number(JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "json", file])).streams[0].nb_read_frames)

test("ET-ENG-08 and ET-HR-04: a HyperFrames tile lands on the base at its own frames, from its frame 0 to its last, in drafts and masters", { skip, timeout: 280_000 }, async () => {
  const title = { op: "add_title", text: "Fifty thousand", at: ms(3000), duration: ms(2000) }
  const withTile = await setup("tile", [title])
  const without = await setup("base", [])
  const started = Date.now()
  const master = await withTile.engine.render({ quality: "master" })
  console.log(`ET-ENG-08: first master with one 2 s tile in ${Date.now() - started} ms`)
  const base = await without.engine.render({ quality: "master" })
  const [tile] = master.plan.tiles
  assert.equal(tile.kind, "block")
  const tileFile = withTile.engine.tilePath(tile.key)
  const probed = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", tileFile])).streams[0]
  assert.deepEqual([probed.codec_name, probed.pix_fmt, probed.width, probed.height], ["prores", "yuva444p12le", W, H], "a transparent ProRes 4444 tile")

  // No frame dropped or added
  assert.equal(frameCount(master.file), 8 * FPS)
  assert.equal(frameCount(tileFile), 2 * FPS)

  // Frame by frame: the tile's own alpha decides which output frames change
  const alpha = alphaOf(tileFile)
  const f0 = 3 * FPS
  const diff = mse(master.file, base.file)
  assert.equal(alpha[0], 0, "the title's frame 0 is fully transparent (it springs in from nothing)")
  // Measured here: x264's own drift stays under 3 outside the window; a tile with any real alpha is over 8
  for (let f = 0; f < diff.length; f++) {
    const k = f - f0
    if (k >= 0 && k < alpha.length && alpha[k] > 0.005) assert.ok(diff[f] > 8, `frame ${f} (tile frame ${k}, alpha ${alpha[k].toFixed(4)}) shows the tile (mse ${diff[f]})`)
    if (k < 0 || k >= alpha.length) assert.ok(diff[f] < 3, `frame ${f} is the base alone (mse ${diff[f]})`)
  }
  assert.ok(diff[f0] < 3 && alpha[1] > 0 && diff[f0 + 2] > 8, "ET-HR-04: the overlay starts at frame 0 of its animation: transparent on the window's first frame, then rising")
  assert.ok(diff[f0 + alpha.length - 1] > 8, "it is there on its last frame")
  assert.ok(diff[f0 + alpha.length] < 3, "and gone on the next, not held one frame too long")

  // Against a reference made outside the compiler: the same tile overlaid on the base by hand
  const reference = join(dir, "reference.mp4")
  ffmpeg("-i", base.file, "-i", tileFile, "-filter_complex", `[1:v]setpts=PTS-STARTPTS+${f0 / FPS}/TB[t];[0:v][t]overlay=enable='gte(t,3)*lt(t,5)':eof_action=pass[v]`, "-map", "[v]", "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", reference)
  const close = mse(master.file, reference)
  const worst = Math.max(...close.slice(f0, f0 + 2 * FPS))
  console.log(`ET-ENG-08: worst in-window MSE against the hand-made reference ${worst.toFixed(2)} (a 255-level scale)`)
  assert.ok(worst < 12, `the layer-split render matches the reference within tolerance (worst MSE ${worst})`)

  // The draft: segments end at 4 s, inside the tile, and the tile carries on across the seam
  const draft = await withTile.engine.render({ quality: "draft" })
  const draftBase = await without.engine.render({ quality: "draft" })
  assert.ok(draft.plan.segments.some((s) => s.start < tile.at + FLICKS && s.end > tile.at && s.end < tile.end), "a segment edge falls inside the tile")
  assert.equal(frameCount(draft.file), 8 * FPS)
  const draftDiff = mse(draft.file, draftBase.file)
  for (let k = 1; k < alpha.length; k++) if (alpha[k] > 0.002) assert.ok(draftDiff[f0 + k] > 0.5, `draft frame ${f0 + k} shows tile frame ${k}`)
})

const pixel = (file, seconds, x, y) => {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-ss", String(seconds), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 26 })
  const i = (Math.round(y) * W + Math.round(x)) * 3
  return [raw[i], raw[i + 1], raw[i + 2]]
}

test("ET-HR-01: a caption draws over a card it overlaps, though the card starts later", { skip, timeout: 280_000 }, async () => {
  // A red-plated caption from 1 s, and a card from 2 s over the same place
  const placement = { x: 54, y: 400, w: 432, h: 140 }
  const { project } = await setup("stack", [{ op: "set_look", caption: { box: "#ff0000" } }, { op: "caption_style", look: "boxed", words: ["a1:w0", "a1:w1", "a1:w2", "a1:w3", "a1:w4", "a1:w5", "a1:w6"], placement }, { op: "add_motion", block: "card", version: 1, variables: { text: "Card" }, at: ms(2000), duration: ms(1500) }])
  const plan = compile(project, INDEX, { engineVersion: "t", runtimeVersion: "t", quality: "master" })
  const caption = plan.tiles.find((t) => t.kind === "caption")
  const card = plan.tiles.find((t) => t.kind === "block")
  assert.ok(card.at > caption.at, "the card starts after the caption")
  card.node.placement = { x: 0, y: 300, w: W, h: 340 } // under the caption, wider
  const tiles = realpathSync(mkdtempSync(join(dir, "stack-tiles-")))
  for (const tile of [caption, card]) {
    const html = compositionFor(tile, { output: plan.output, canvas: plan.canvas }, captionComposition)
    await renderTile({ html, work: join(tiles, `${tile.key}.work`), output: join(tiles, `${tile.key}.mov`), fps: plan.output.fps, runtime })
  }
  const out = join(tiles, "stack.mp4")
  execFileSync("ffmpeg", segmentArgs(plan, wholeSegment(plan), { input: () => join(dir, "chart.mov"), tile: (key) => join(tiles, `${key}.mov`), output: out, encoder: ["-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p"] }))
  const [box] = (await measureText({ items: [{ id: "c", html: compositionFor(caption, { output: plan.output, canvas: plan.canvas }, captionComposition), times: [2500 - Math.round((caption.at / FLICKS) * 1000)] }], work: realpathSync(mkdtempSync(join(dir, "stack-m-"))), runtime })).get("c")[0]
  const inPlate = pixel(out, 3, box.x + box.w / 2, box.y + 3)
  const cardOnly = pixel(out, 3, 20, 320)
  console.log(`ET-HR-01: caption plate over the card ${inPlate}, the card alone ${cardOnly}`)
  assert.ok(inPlate[0] > 190 && inPlate[1] < 70 && inPlate[2] < 70, `the caption's red plate is on top: ${inPlate}`)
  assert.ok(cardOnly[0] < 60 && cardOnly[1] < 80 && cardOnly[2] < 80, `the card is drawn where the caption isn't: ${cardOnly}`)
})

const probeHtml = (url, { csp }) => {
  const script = `<script>fetch(${JSON.stringify(url)},{mode:'no-cors'}).then(()=>{document.getElementById('n').style.background='#ff0000'}).catch(()=>{document.getElementById('n').style.background='#00ff00'})</script>`
  const page = tileDocument({ width: W, height: H, duration: 6 * FLICKS, css: "#n{position:absolute;inset:0;background:#0000ff}", body: '<div id="n"></div>', animations: [] }).replace("</body>", `${script}</body>`)
  return csp ? page : page.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
}

/** Renders a probe composition, confined or as a control with no sandbox, and reads its colour at 5.8 s (a slow network needs the time). */
async function probeRender(html, { confined }) {
  const work = realpathSync(mkdtempSync(join(dir, confined ? "sec-" : "ctl-")))
  const out = join(work, "tile.mov")
  if (confined) await renderTile({ html, work: join(work, "w"), output: out, fps: { n: FPS, d: 1 }, runtime, seconds: 6 })
  else {
    mkdirSync(join(work, "comp"))
    mkdirSync(join(work, "tmp"))
    writeFileSync(join(work, "comp", "index.html"), html)
    await new Promise((done, fail) => spawn(process.execPath, [runtime.cli, "render", join(work, "comp"), "--format", "mov", "--fps", String(FPS), "--workers", "1", "--quiet", "--no-wait", "-o", out], { env: motionEnv(work, runtime), cwd: work, stdio: "ignore" }).on("exit", (code) => (code === 0 ? done() : fail(new Error(`control render ${code}`)))))
  }
  const [r, g] = pixel(out, 5.8, 10, 10)
  return r > 200 && g < 60 ? "reached" : g > 200 && r < 60 ? "blocked" : "pending"
}

test("ET-SEC-04: the sandbox stops a composition reaching another computer (control: the same one unconfined reaches it)", { skip, timeout: 280_000 }, async (t) => {
  // EX-14's check. It needs the internet for its control, and says so when there is none
  const html = probeHtml("https://example.com/", { csp: false })
  const control = await probeRender(html, { confined: false })
  if (control !== "reached") return t.skip(`the control couldn't reach the internet (${control}), so there is nothing to prove the block against`)
  assert.equal(await probeRender(html, { confined: true }), "blocked")
})

test("ET-SEC-04: on this computer, Kriya's CSP is what stops a composition; a confined process can't read another folder", { skip, timeout: 280_000 }, async () => {
  // A probe on loopback only: the sandbox lets loopback through (the renderer needs it), so the CSP must hold
  let hits = 0
  const server = createServer((req, res) => {
    hits++
    res.writeHead(200, { "access-control-allow-origin": "*" }).end("ok")
  })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  const url = `http://127.0.0.1:${server.address().port}/probe`
  try {
    assert.equal(await probeRender(probeHtml(url, { csp: true }), { confined: true }), "blocked", "a Kriya composition's CSP refuses the request")
    assert.equal(hits, 0)
    assert.equal(await probeRender(probeHtml(url, { csp: false }), { confined: true }), "reached", "without the CSP, loopback is open: the residual risk ES-05 records")
    assert.equal(hits, 1)
    assert.throws(() => customComposition(probeHtml(url, { csp: false }), { allowed: true }), (e) => e.reason === "lint_refused", "and model-written code like it never renders")
  } finally {
    server.close()
  }

  // Files: the profile refuses a read outside the runtime and the work folder, to any program under it
  const secret = join(realpathSync(tmpdir()), `kh-secret-${process.pid}.txt`)
  writeFileSync(secret, "private")
  const work = realpathSync(mkdtempSync(join(dir, "read-")))
  const read = (wrap) => {
    const { command, args } = wrap ? confine("/bin/cat", [secret], { read: runtime.reads, write: [work] }) : { command: "/bin/cat", args: [secret] }
    try {
      return execFileSync(command, args, { stdio: ["ignore", "pipe", "ignore"] }).toString()
    } catch {
      return null
    }
  }
  assert.equal(read(false), "private")
  assert.equal(read(true), null, "a confined process can't read another folder's file")
})

test("ET-SEC-02: text with quotes, colons, newlines and % lands literally on the rendered page", { skip, timeout: 120_000 }, async () => {
  const words = [`It's`, `"50%":`, `<b>not</b>`, `a\\b;c`, `[x]`].map((text, i) => ({ text, at: (i * FLICKS) / 4, end: ((i + 1) * FLICKS) / 4, emphasis: false }))
  const html = captionComposition({ kind: "caption", words, look: "boxed", style: {}, placement: { x: 54, y: 600, w: 432, h: 140 }, duration: 2 * FLICKS }, { output: { width: W, height: H }, canvas: { width: W, height: H } })
  const [[box]] = (await measureText({ items: [{ id: "t", html, times: [1500] }], work: realpathSync(mkdtempSync(join(dir, "lit-"))), runtime })).get("t")
  assert.equal(box.text, words.map((w) => w.text).join(" "))
})

test("QG-08 and QG-09 on rendered masters: a clear karaoke page passes; yellow on white, a face and the safe zone each fail", { skip, timeout: 280_000 }, async () => {
  const page = ["a1:w0", "a1:w1", "a1:w2", "a1:w3"]
  const gates = async (name, ops, { source = "white.mov", index = INDEX } = {}) => {
    const { engine, project, root } = await setup(name, ops, { source, index, deliverable: true })
    const deliverable = project.deliverables[0].id
    const { file, plan } = await engine.render({ quality: "master", deliverable })
    const checked = await runGates({ file, plan, project, index, sourcePath: () => join(dir, source), only: ["QG-08", "QG-09"], tilePath: engine.tilePath, motion: runtime, work: join(root, "gates") })
    return Object.fromEntries(checked.gates.map((g) => [g.id, g]))
  }
  const clear = await gates("clear", [{ op: "caption_style", look: "karaoke", words: page }])
  console.log(`clear: ${JSON.stringify(clear["QG-08"].numbers)} ${JSON.stringify(clear["QG-09"].numbers)}`)
  assert.equal(clear["QG-08"].status, "passed", JSON.stringify(clear["QG-08"]))
  assert.equal(clear["QG-09"].status, "passed", JSON.stringify(clear["QG-09"]))

  const yellow = await gates("yellow", [{ op: "set_look", caption: { color: "#ffd23f", stroke: "none" } }, { op: "caption_style", look: "clean", words: page }])
  assert.equal(yellow["QG-09"].status, "failed")
  assert.equal(yellow["QG-09"].numbers.first.kind, "low_contrast", JSON.stringify(yellow["QG-09"].numbers))

  // A face where the caption is pinned, and a caption pinned under the reel's bottom margin
  const face = { ...INDEX, faces: [{ asset: "a1", shot: null, t: ms(1000), box: { x: 120, y: 300, w: 300, h: 300 } }, { asset: "a1", shot: null, t: ms(2000), box: { x: 120, y: 300, w: 300, h: 300 } }] }
  const onFace = await gates("face", [{ op: "caption_style", look: "karaoke", words: page, placement: { x: 40, y: 380, w: 420, h: 140 } }], { source: "chart.mov", index: face })
  assert.equal(onFace["QG-08"].status, "failed")
  assert.deepEqual([...new Set(onFace["QG-08"].failures.map((f) => f.kind))], ["on_face"], JSON.stringify(onFace["QG-08"].numbers))
  const low = await gates("low", [{ op: "caption_style", look: "karaoke", words: page, placement: { x: 40, y: 800, w: 420, h: 140 } }], { source: "chart.mov" })
  assert.deepEqual([...new Set(low["QG-08"].failures.map((f) => f.kind))], ["outside_safe_zone"], JSON.stringify(low["QG-08"].numbers))
})
