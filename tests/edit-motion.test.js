import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { mapBox, outputFaces } from "../src/edit/core/faces.js"
import { matteMask, segmentArgs } from "../src/edit/core/ffmpeg.js"
import { safeZoneFor, SAFE_ZONES } from "../src/edit/core/layout.js"
import { apply } from "../src/edit/core/ops.js"
import { compile, wholeSegment } from "../src/edit/core/plan.js"
import { captionComposition, escapeText, lookOf, LOOKS, pages, READING_LIMITS, scriptOf } from "../src/edit/engine/captions.js"
import { confine, confinement, sandboxProfile } from "../src/edit/engine/confine.js"
import { blockComposition, customComposition, lintComposition, motionRuntime, springCurve, springKeyframes, tileDocument, tileSeconds } from "../src/edit/engine/motion.js"
import { beatsOf, boxContrast, contrast, judgeLayout, judgeLegibility, luminance } from "../src/edit/gates/text.js"
import { deliverableFor } from "../src/edit/recipes/reel.js"
import { makeIndex, makeProject, ms } from "./edit/fixture.js"

// ED8: captions, the motion layer and its confinement, the matte, QG-08 and QG-09,
// without Chrome or FFmpeg. The real renders are in tests/edit/media/motion.test.js.

const FLICKS = 705_600_000
const VERSIONS = { engineVersion: "t", runtimeVersion: "t" }
const index = makeIndex()

function project(ops) {
  const result = apply(makeProject(), [{ op: "keep_range", asset: "a1", from: ms(1000), to: ms(9000) }, ...ops], { index })
  assert.deepEqual(result.diagnostics, [])
  return result.project
}

/* ─────────────────────────────── springs and documents ─────────────────────────────── */

test("springs are computed in code: they overshoot, then land exactly", () => {
  const curve = springCurve({ damping: 0.45, frequency: 11, ms: 1200 })
  assert.equal(curve[0], 0)
  assert.equal(curve.at(-1), 1)
  assert.ok(Math.max(...curve) > 1, "an underdamped spring overshoots")
  const frames = springKeyframes({ damping: 0.5, frequency: 12, ms: 600, from: { y: 300, opacity: 0 }, to: { y: 0, opacity: 1 } })
  assert.equal(frames[0].offset, 0)
  assert.equal(frames.at(-1).offset, 1)
  assert.equal(frames.at(-1).transform, "translateY(0.00px)")
  assert.ok(frames.every((f, i) => i === 0 || f.offset > frames[i - 1].offset), "offsets rise")
  assert.throws(() => springCurve({ damping: 1.2, frequency: 1, ms: 10 }), RangeError)
})

test("EX-01: a tile is HyperFrames' non-GSAP composition: no timeline, no network, its script can't be closed", () => {
  const html = tileDocument({ width: 1080, height: 1920, duration: 2 * FLICKS, css: "", body: "<div id='a'></div>", animations: [{ id: "a", keyframes: [{ x: "</script><script>alert(1)</script>" }], options: {} }] })
  assert.match(html, /data-no-timeline/)
  assert.match(html, /data-composition-id="kriya"/)
  assert.match(html, /data-duration="2\.000000"/)
  assert.match(html, /connect-src 'none'/)
  assert.match(html, /default-src 'none'/)
  assert.equal(html.match(/<\/script>/g).length, 1, "data can't end the script")
  assert.doesNotMatch(html, /gsap|remotion/i)
  assert.equal(tileSeconds(FLICKS / 2 + 1, { n: 30, d: 1 }), 16 / 30, "a tile covers its last partial frame")
})

/* ─────────────────────────────── captions ─────────────────────────────── */

const W = (texts) => texts.map((text, i) => ({ id: `w${i}`, text }))

test("phrase breaks: 2 to 5 words a page, at clause ends, no orphan, a number kept whole", () => {
  assert.deepEqual(pages(W(["We", "built", "it", "in", "a", "week.", "It", "cost", "us"])), [["w0", "w1", "w2", "w3", "w4"], ["w5", "w6", "w7", "w8"]])
  assert.deepEqual(pages(W(["Hello", "there,", "my", "friends", "who", "came."])), [["w0", "w1"], ["w2", "w3", "w4", "w5"]])
  const orphan = pages(W(["One", "two", "three", "four", "five", "six"]))
  assert.ok(orphan.every((p) => p.length >= 2), JSON.stringify(orphan))
  const number = pages(W(["It", "cost", "us", "50", "000", "rupees"]))
  assert.ok(number.some((p) => p.includes("w3") && p.includes("w4")), `a number isn't split: ${JSON.stringify(number)}`)
  assert.deepEqual(pages(W(["Hi"])), [["w0"]])
  assert.ok(pages(W(["1", "2", "3", "4", "5", "6"])).every((p) => p.length >= 2), "a long run of digits still gives pages of two or more")
  assert.deepEqual(pages(W(["a", "b", "c", "d", "e", "f"])).map((p) => p.length), [3, 3], "five and an orphan become three and three")
  for (let n = 2; n <= 40; n++) {
    const made = pages(W(Array.from({ length: n }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}`)))
    assert.ok(made.every((p) => p.length >= 2 && p.length <= 5), `${n} words: ${made.map((p) => p.length)}`)
    assert.equal(made.flat().length, n, "every word once")
  }
})

test("looks: Kriya's own; overrides are typed, and anything else is dropped", () => {
  assert.deepEqual(Object.keys(LOOKS).sort(), ["boxed", "clean", "karaoke", "minimal", "pop", "story"])
  const look = lookOf("karaoke", { color: "#00ff00", accent: "red; background:url(x)", size: 9, font: "comic", evil: "<script>" })
  assert.equal(look.color, "#00ff00")
  assert.equal(look.accent, LOOKS.karaoke.accent, "a colour that isn't a hex colour is ignored")
  assert.equal(look.size, LOOKS.karaoke.size)
  assert.equal(look.font, "sans")
  assert.equal("evil" in look, false)
  assert.equal(lookOf("nope").color, LOOKS.clean.color, "an unknown look falls back to clean")
})

test("ET-SEC-02 (tiles): a word's quotes, colons, % and markup land as text, never as markup", () => {
  const words = [{ text: `It's "50%": <img src=x onerror=alert(1)>`, at: 0, end: FLICKS / 2, emphasis: false }, { text: "a&b\nc", at: FLICKS / 2, end: FLICKS, emphasis: true }]
  const html = captionComposition({ kind: "caption", words, look: "karaoke", style: {}, placement: { x: 100, y: 1300, w: 880, h: 230 }, duration: FLICKS }, { output: { width: 1080, height: 1920 }, canvas: { width: 1080, height: 1920 } })
  assert.doesNotMatch(html, /<img/)
  assert.match(html, /It&#39;s &quot;50%&quot;: &lt;img src=x onerror=alert\(1\)&gt;/)
  assert.match(html, /a&amp;b\nc/)
  assert.equal(escapeText(`<&"'>`), "&lt;&amp;&quot;&#39;&gt;")
})

test("karaoke: each word lights at its own spoken time; emphasis keeps the accent; placement scales to the output", () => {
  const words = [0, 1, 2].map((i) => ({ text: `w${i}`, at: (i * FLICKS) / 2, end: ((i + 1) * FLICKS) / 2, emphasis: i === 2 }))
  const html = captionComposition({ kind: "caption", words, look: "karaoke", style: {}, placement: { x: 108, y: 1300, w: 864, h: 230 }, duration: 1.5 * FLICKS }, { output: { width: 540, height: 960 }, canvas: { width: 1080, height: 1920 } })
  const animations = JSON.parse(/for \(const a of (.*)\) document/.exec(html)[1].replaceAll("\\u003c", "<"))
  const lit = animations.filter((a) => a.id.startsWith("w"))
  assert.deepEqual(lit.map((a) => a.id), ["w0", "w1"], "emphasis words don't flash")
  const w1 = lit[1].keyframes.filter((k) => k.color === LOOKS.karaoke.accent).map((k) => k.offset)
  assert.deepEqual(w1, [500 / 1500, 1000 / 1500])
  assert.match(html, /left:54px;top:650px;width:432px/)
  assert.match(html, /class="e"/)
})

test("a corrected caption shows the correction: word by word when the count matches, else as one block", () => {
  const words = ["It", "cost", "Asha"].map((text, i) => ({ text, at: (i * FLICKS) / 2, end: ((i + 1) * FLICKS) / 2, emphasis: false }))
  const frame = { output: { width: 1080, height: 1920 }, canvas: { width: 1080, height: 1920 } }
  const node = (text) => ({ kind: "caption", words, text, look: "karaoke", style: {}, placement: { x: 100, y: 1300, w: 880, h: 230 }, duration: 1.5 * FLICKS })
  const same = captionComposition(node("It cost Aasha"), frame)
  assert.match(same, /> Aasha</)
  assert.doesNotMatch(same, /> Asha</)
  assert.equal((same.match(/data-at=/g) ?? []).length, 3, "still timed word by word")
  const block = captionComposition(node("It cost Asha fifty"), frame)
  assert.match(block, />It cost Asha fifty</)
  assert.match(captionComposition(node(undefined), frame), /> Asha</, "no edit: the words as said")
})

test("reading speed: a limit per script; the reel's deliverable burns captions only when asked", () => {
  assert.equal(scriptOf("नमस्ते दोस्तों"), "devanagari")
  assert.equal(scriptOf("నమస్కారం"), "telugu")
  assert.equal(scriptOf("Hello there"), "latin")
  assert.ok(READING_LIMITS.latin > READING_LIMITS.telugu)
  assert.equal(deliverableFor({}).burnCaptions, false)
  const captioned = deliverableFor({ captions: "karaoke" })
  assert.equal(captioned.burnCaptions, true)
  assert.deepEqual(captioned.gates, ["QG-01", "QG-02", "QG-03", "QG-04", "QG-05", "QG-06", "QG-07", "QG-08", "QG-09", "QG-10", "QG-11", "QG-12", "QG-13", "QG-14"])
})

/* ─────────────────────────────── blocks and model-written code ─────────────────────────────── */

test("blocks: typed, escaped variables; an unknown block or version is refused", () => {
  const frame = { output: { width: 1080, height: 1920 }, canvas: { width: 1080, height: 1920 } }
  const html = blockComposition({ kind: "block", blockId: "lower-third", version: 1, variables: { text: "Asha <b>", subtitle: "Founder" }, placement: null, duration: 2 * FLICKS }, frame)
  assert.match(html, /Asha &lt;b&gt;<small>Founder<\/small>/)
  assert.throws(() => blockComposition({ blockId: "lower-third", version: 2, variables: {}, duration: FLICKS }, frame), (e) => e.reason === "unknown_block")
  assert.throws(() => blockComposition({ blockId: "title", version: 1, variables: { text: { toString: () => "x" } }, duration: FLICKS }, frame), (e) => e.reason === "bad_variable")
  for (const id of ["title", "lower-third", "card"]) assert.deepEqual(lintComposition(blockComposition({ blockId: id, version: 1, variables: { text: "Hi" }, duration: FLICKS }, frame)), [], `${id} passes Kriya's own lint`)
})

test("ET-SEC-04 (lint): network, clocks, randomness, outside code and GSAP are refused; customMotion off refuses everything", () => {
  const cases = {
    "fetch('/x')": "it reaches the network",
    "new WebSocket('ws://a')": "it reaches the network",
    "<script src='a.js'></script>": "it loads code or pages from outside",
    "url(https://evil.example/a.png)": "it names an address",
    "const t = Date.now()": "it reads the clock, so it wouldn't seek",
    "setTimeout(f, 10)": "it reads the clock, so it wouldn't seek",
    "requestAnimationFrame(f)": "it reads the clock, so it wouldn't seek",
    "Math.random()": "it is random, so two renders differ",
    "eval('1')": "it builds code from text",
    "gsap.to('#a', {x: 1})": "it uses GSAP or Remotion (EDD-08, EDD-09)",
  }
  for (const [code, reason] of Object.entries(cases)) assert.ok(lintComposition(`<script>${code}</script>`).includes(reason), code)
  const ok = "<div id='a'></div><script>document.getElementById('a').animate([{opacity:0},{opacity:1}],{duration:500,fill:'both'})</script>"
  assert.deepEqual(lintComposition(ok), [])
  const yes = { kind: "sandbox-exec" }
  assert.throws(() => customComposition(ok, { allowed: false, which: yes }), (e) => e.reason === "custom_motion_off")
  assert.throws(() => customComposition(ok, { allowed: undefined, which: yes }), (e) => e.reason === "custom_motion_off")
  assert.throws(() => customComposition(ok, { allowed: true, which: { kind: null, missing: "no sandbox" } }), (e) => e.reason === "no_confinement")
  assert.throws(() => customComposition("<script>fetch('x')</script>", { allowed: true, which: yes }), (e) => e.reason === "lint_refused")
  assert.ok(lintComposition(`<img src="//127.0.0.1:9/x">`).includes("it names an address"), "a protocol-relative address too")
  assert.ok(lintComposition(`<div style="background:url( '//evil.example/a')">`).includes("it names an address"))
  const page = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *">${ok}</head><body></body></html>`
  const allowed = customComposition(page, { allowed: true, which: yes })
  assert.ok(allowed.indexOf("connect-src 'none'") < allowed.indexOf("default-src *"), "Kriya's policy comes first, so the looser one can't widen it")
  assert.throws(() => customComposition(ok, { allowed: true, which: yes }), (e) => e.reason === "bad_composition")
})

/* ─────────────────────────────── confinement ─────────────────────────────── */

test("ES-05: the profile denies outbound network but loopback, people's folders, and lets back only what a render needs", () => {
  const profile = sandboxProfile({ read: ["/usr/bin"], write: ["/private/var/tmp"] })
  assert.match(profile, /\(deny network-outbound\)/)
  assert.match(profile, /\(allow network-outbound \(remote ip "localhost:\*"\)\)/)
  assert.doesNotMatch(profile, /unix-socket/, "no unix socket: the Host's and the daemon's sockets stay out of reach")
  assert.doesNotMatch(profile, /local ip/, "a local-address rule opens every outbound connection (found in ED8)")
  assert.match(profile, /\(deny file-read\* file-write\* \(subpath "\/Users"\) \(subpath "\/Volumes"\) \(subpath "\/private\/tmp"\) \(subpath "\/private\/var\/folders"\)/)
  const lines = profile.split("\n")
  assert.ok(lines.findIndex((l) => l.startsWith("(deny file-read*")) < lines.findIndex((l) => l.includes('(subpath "/usr/bin")')), "denials first, so the allowances win")
  assert.throws(() => sandboxProfile({ read: ['/tmp/a"b'], write: [] }), /./)
  assert.equal(confinement("linux").kind, null)
  assert.equal(confinement("darwin", () => true).kind, "sandbox-exec")
  assert.throws(() => confine("chrome", [], { read: [], write: [] }, confinement("win32")), (e) => e.reason === "no_confinement")
  const wrapped = confine("/bin/echo", ["hi"], { read: [], write: [] }, { kind: "sandbox-exec" })
  assert.deepEqual([wrapped.command, wrapped.args[0], wrapped.args.slice(-2)], ["/usr/bin/sandbox-exec", "-p", ["/bin/echo", "hi"]])
})

test("the motion layer says what it lacks, and without HyperFrames it draws in the runtime's Chrome", () => {
  assert.match(motionRuntime(null).missing, /kriya edit setup/)
  assert.match(motionRuntime({ dir: "/nonexistent", manifest: {} }).missing, /no Chrome/)
  const dir = mkdtempSync(join(tmpdir(), "kmotion-"))
  mkdirSync(join(dir, "chrome-headless-shell"))
  writeFileSync(join(dir, "chrome-headless-shell", "chrome"), "")
  const manifest = { platforms: { [`${process.platform}-${process.arch}`]: { artifacts: [{ id: "chrome-headless-shell", entry: "chrome" }] } } }
  const chromeOnly = motionRuntime({ dir, manifest })
  assert.equal(chromeOnly.missing, undefined, "Chrome alone is enough for captions")
  assert.equal(chromeOnly.cli, null, "drawn frame by frame, without HyperFrames")
  assert.equal(chromeOnly.chrome, join(dir, "chrome-headless-shell", "chrome"))
})

/* ─────────────────────────────── layers, matte, faces ─────────────────────────────── */

test("ET-HR-01 (graph): captions draw over cards whatever their start times; text behind the speaker goes under the matte", () => {
  const p = project([
    { op: "caption_style", look: "karaoke", words: ["a1:w2", "a1:w3"] },
    { op: "add_title", text: "Later card", at: { word: "a1:w3", edge: "start" }, duration: ms(1500) },
  ])
  const plan = compile(p, index, { ...VERSIONS, quality: "master" })
  const caption = plan.tiles.find((t) => t.kind === "caption")
  const card = plan.tiles.find((t) => t.kind === "block")
  assert.ok(card.at > caption.at, "the card starts later, so time order alone would draw it on top")
  const args = segmentArgs(plan, wholeSegment(plan), { input: () => "/m.mov", tile: (key) => `/t/${key}.mov`, output: "/o.mp4", encoder: [] })
  const graph = args[args.indexOf("-filter_complex") + 1]
  const inputs = args.filter((_, i) => args[i - 1] === "-i")
  assert.ok(inputs.indexOf(`/t/${card.key}.mov`) < inputs.indexOf(`/t/${caption.key}.mov`), "the card's layer is drawn first")
  assert.ok(graph.lastIndexOf("overlay") > graph.indexOf(`[${inputs.indexOf(`/t/${caption.key}.mov`)}:v]`), graph)
})

test("text behind the speaker: L8 faces on the output make the matte; with no face it's drawn in front and reported", () => {
  const p = project([{ op: "caption_style", look: "boxed", words: ["a1:w2", "a1:w3"] }])
  const captionClip = p.sequences[0].clips.find((c) => c.effects[0]?.type === "caption").id
  const behind = apply(p, [{ op: "text_behind", clip: captionClip }], { index })
  assert.deepEqual(behind.diagnostics, [])
  const faces = [{ asset: "a1", shot: "a1:s0", t: ms(2000), box: { x: 300, y: 300, w: 480, h: 480 } }]
  const plan = compile(behind.project, { ...index, faces }, { ...VERSIONS, quality: "master" })
  assert.equal(plan.mattes.length, 1)
  assert.deepEqual(plan.mattes[0].box, { x: 300, y: 300, w: 480, h: 480 }, "a 1080×1920 take on a 1080×1920 frame maps one to one")
  const tile = plan.tiles.find((t) => t.kind === "caption")
  assert.equal(tile.node.behind, true)
  assert.equal(tile.front, undefined)
  const args = segmentArgs(plan, wholeSegment(plan), { input: () => "/m.mov", tile: (key) => `/t/${key}.mov`, output: "/o.mp4", encoder: [] })
  const graph = args[args.indexOf("-filter_complex") + 1]
  assert.match(graph, /split=2\[mb\]\[mk0\]/)
  assert.match(graph, /alphamerge\[ms0\]/)
  const captionInput = args.filter((_, i) => args[i - 1] === "-i").indexOf(`/t/${tile.key}.mov`)
  assert.ok(graph.indexOf(`[${captionInput}:v]`) < graph.indexOf("alphamerge"), "the caption is drawn before the speaker goes back over it")
  assert.match(matteMask({ x: 0, y: 0, w: 100, h: 100 }), /^255\*gt\(lte\(pow/)

  const none = compile(behind.project, { ...index, faces: [] }, { ...VERSIONS, quality: "master" })
  assert.equal(none.mattes, undefined)
  assert.equal(none.tiles.find((t) => t.kind === "caption").front, true)
  assert.ok(none.issues.some((i) => i.code === "no_subject_for_matte"))
  assert.deepEqual(apply(behind.project, [{ op: "text_behind", clip: captionClip }], { index }).diagnostics[0].code, "already_behind")
})

test("faces on the output follow the crop path, the punch-in and the final scale", () => {
  const source = { width: 1920, height: 1080 }
  const canvas = { width: 1080, height: 1920 }
  const output = { width: 1080, height: 1920 }
  // A 9:16 crop 608 px wide at x=656: a face at x=800 lands at (800−656)·1920/1080 = 256
  assert.deepEqual(mapBox({ x: 800, y: 300, w: 200, h: 200 }, { crop: [{ t: 0, x: 656 }] }, source, canvas, output, 0), { x: 256, y: 533, w: 356, h: 356 })
  // A centre crop with no path: scale by height, offset by the overflow
  assert.deepEqual(mapBox({ x: 960, y: 540, w: 10, h: 10 }, {}, source, canvas, output, 0), { x: 540, y: 960, w: 18, h: 18 })
  // A 2× punch-in doubles the box about the centre
  assert.deepEqual(mapBox({ x: 540, y: 960, w: 10, h: 10 }, { zoom: { scale: 2 } }, canvas, canvas, output, 0), { x: 540, y: 960, w: 20, h: 20 })
  assert.equal(mapBox({ x: 0, y: 0, w: 10, h: 10 }, { crop: [{ t: 0, x: 900 }] }, source, canvas, output, 0), null, "off the crop: not on the output")
  const found = outputFaces([{ asset: "a1", in: ms(1000), out: ms(5000), at: 0, end: ms(4000), speed: { n: 2, d: 1 } }], [{ asset: "a1", t: ms(3000), box: { x: 0, y: 0, w: 10, h: 10 } }], () => canvas, { canvas, output })
  assert.deepEqual(found.map((f) => f.t), [ms(1000)], "double speed halves the time")
})

test("safe zones: the strictest of a project's deliverables, in its pixels; none without one", () => {
  const p = makeProject()
  assert.deepEqual(safeZoneFor(p), {})
  p.deliverables = [{ preset: "reel-9x16" }, { preset: "tiktok-9x16" }]
  const zone = safeZoneFor(p)
  assert.equal(zone.right, Math.ceil(SAFE_ZONES["tiktok-9x16"].right * 1080))
  assert.equal(zone.bottom, Math.ceil(SAFE_ZONES["tiktok-9x16"].bottom * 1920))
  assert.equal(zone.top, Math.ceil(SAFE_ZONES["reel-9x16"].top * 1920))
})

/* ─────────────────────────────── QG-08 and QG-09 judgements ─────────────────────────────── */

function textPlan(extra = []) {
  const p = project([{ op: "caption_style", look: "karaoke", words: ["a1:w2", "a1:w3"] }, ...extra])
  p.deliverables = [{ id: "d1", preset: "reel-9x16", size: { width: 1080, height: 1920 }, fps: { n: 30, d: 1 }, codec: "h264", audio: "aac", burnCaptions: true }]
  return { p, plan: compile(p, index, { ...VERSIONS, quality: "master", deliverable: "d1" }) }
}

test("QG-08: text on a face, outside the safe zone, clipped or overlapping fails; a clear layout passes", () => {
  const { p, plan } = textPlan()
  const tile = plan.tiles[0]
  const t = tile.at + FLICKS / 2
  const box = (b) => ({ size: 88, colours: ["rgb(255, 255, 255)"], plate: "rgba(0, 0, 0, 0)", clipped: false, ...b })
  const faces = { ...index, faces: [{ asset: "a1", t: ms(2500), box: { x: 300, y: 300, w: 480, h: 480 } }] }
  const clear = judgeLayout({ plan, project: p, index: faces, measured: [{ t, tile, box: box({ x: 160, y: 1200, w: 700, h: 200 }) }] })
  assert.equal(clear.status, "passed", JSON.stringify(clear.failures))
  const kinds = (b, extra = []) => judgeLayout({ plan, project: p, index: faces, measured: [{ t, tile, box: box(b) }, ...extra] }).failures.map((f) => f.kind)
  assert.deepEqual(kinds({ x: 400, y: 400, w: 300, h: 100 }), ["on_face"])
  assert.deepEqual(kinds({ x: 160, y: 1700, w: 700, h: 150 }), ["outside_safe_zone"], "inside the frame, under the reel's bottom margin")
  assert.deepEqual(kinds({ x: 900, y: 1200, w: 400, h: 100 }), ["outside_frame"])
  assert.deepEqual(kinds({ x: 160, y: 1200, w: 700, h: 200, clipped: true }), ["clipped"])
  const other = { t, tile: { ...tile, key: "other" }, box: box({ x: 200, y: 1250, w: 300, h: 100 }) }
  assert.deepEqual(kinds({ x: 160, y: 1200, w: 700, h: 200 }, [other]), ["overlap"])
  const behindTile = { ...tile, node: { ...tile.node, behind: true } }
  assert.equal(judgeLayout({ plan, project: p, index: faces, measured: [{ t, tile: behindTile, box: box({ x: 400, y: 400, w: 300, h: 100 }) }] }).status, "passed", "text behind the speaker may cross the face")
})

test("QG-09: contrast is WCAG's, on the pixels behind the box, with the plate blended in", () => {
  assert.equal(Math.round(contrast(luminance([255, 255, 255]), luminance([0, 0, 0]))), 21)
  assert.ok(contrast(luminance([255, 210, 63]), luminance([255, 255, 255])) < 4.5, "yellow on white is unreadable")
  const width = 20
  const height = 10
  const white = Buffer.alloc(width * height * 3, 255)
  const yellow = { colours: ["rgb(255, 210, 63)"], plate: "rgba(0, 0, 0, 0)" }
  assert.ok(boxContrast(white, width, height, { x: 0, y: 0, w: 20, h: 10 }, yellow) < 4.5)
  const plated = { colours: ["rgb(255, 255, 255)", "rgb(255, 210, 63)"], plate: `rgba(10, 10, 10, ${LOOKS.karaoke.box.alpha})` }
  assert.ok(boxContrast(white, width, height, { x: 0, y: 0, w: 20, h: 10 }, plated) >= 4.5, "the karaoke plate holds 4.5:1 over a white frame, both colours")
  const half = Buffer.alloc(width * height * 3, 255)
  half.fill(0, 0, (width * height * 3) / 2)
  assert.ok(boxContrast(half, width, height, { x: 0, y: 0, w: 20, h: 10 }, { colours: ["rgb(255, 255, 255)"], plate: "rgba(0, 0, 0, 0)" }) < 4.5, "the worst pixels decide, not the average")
})

test("QG-09: low contrast, small text and a page faster than its script's limit each fail, from the frames FFmpeg gives", async () => {
  const { plan } = textPlan()
  const tile = plan.tiles[0]
  const measured = [{ t: tile.at + FLICKS / 4, tile, box: { x: 100, y: 1200, w: 800, h: 200, size: 88, colours: ["rgb(255, 210, 63)"], plate: "rgba(0, 0, 0, 0)", clipped: false } }]
  const frame = Buffer.alloc(1080 * 1920 * 3, 255)
  let asked
  const run = async (command, args, { onStdout }) => {
    asked = args
    onStdout(frame)
  }
  const judged = await judgeLegibility({ plan, measured, inputPath: () => "/m.mov", tilePath: (k) => `/t/${k}.mov`, run, thresholds: { contrast: 4.5, minTextShare: 0.02 } })
  assert.deepEqual(judged.failures.map((f) => f.kind), ["low_contrast"])
  assert.ok(asked.includes("rawvideo") && asked.join(" ").includes("select="), "raw frames at the beats")
  assert.ok(!asked.includes(`/t/${tile.key}.mov`), "the text itself isn't in its own background")

  const small = [{ ...measured[0], box: { ...measured[0].box, colours: ["rgb(0, 0, 0)"], size: 20 } }]
  assert.deepEqual((await judgeLegibility({ plan, measured: small, inputPath: () => "/m.mov", tilePath: (k) => k, run, thresholds: { contrast: 4.5, minTextShare: 0.02 } })).failures.map((f) => f.kind), ["too_small"])
  const fast = { ...tile, end: tile.at + FLICKS / 4 }
  const quick = [{ ...measured[0], tile: fast, box: { ...measured[0].box, colours: ["rgb(0, 0, 0)"] } }]
  const judgedFast = await judgeLegibility({ plan, measured: quick, inputPath: () => "/m.mov", tilePath: (k) => k, run, thresholds: { contrast: 4.5, minTextShare: 0.02 } })
  assert.deepEqual(judgedFast.failures.map((f) => f.kind), ["too_fast"])
  assert.ok(judgedFast.failures[0].wordsPerSecond > READING_LIMITS.latin)
})

test("beats: at rest after the entrance, each word, and the last frame", () => {
  const { plan } = textPlan()
  const beats = beatsOf(plan.tiles[0], { n: 30, d: 1 })
  assert.ok(beats[0] >= 350 - 1, "after the entrance")
  assert.ok(beats.length >= 3)
  assert.ok(beats.every((b, i) => i === 0 || b > beats[i - 1]))
})
