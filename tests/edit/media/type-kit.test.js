import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"

import { REGIONS } from "../../../src/edit/core/layout.js"
import { apply } from "../../../src/edit/core/ops.js"
import { kitNode, PAIRS } from "../../../src/edit/core/type-kit.js"
import { ALL_LOOKS, captionComposition, pageLimits } from "../../../src/edit/engine/captions.js"
import { readCapabilities } from "../../../src/edit/engine/capabilities.js"
import { FONTS, glyphProblems, shippedOnly } from "../../../src/edit/engine/fonts.js"
import { ALL_GRAPHIC_KINDS, cleanGraphic } from "../../../src/edit/engine/graphics.js"
import { createEngine } from "../../../src/edit/engine/index.js"
import { probe } from "../../../src/edit/engine/probe.js"
import { blockComposition, checkGlyphs, measureText, motionRuntime, renderTileInChrome } from "../../../src/edit/engine/motion.js"
import { runGates } from "../../../src/edit/gates/index.js"
import { graphicOps } from "../../../src/edit/recipes/graphic-clips.js"
import { openJournal } from "../../../src/edit/graph/journal.js"
import { makeProject, ms } from "../fixture.js"
import { fontsSkip, linkFonts, linkMotion } from "./motion-runtime.js"

// ET-TY-M1 (TOP_TIER_PLAN §4 TP7): every caption look and motion kit 2 kind, in every format, at
// its longest text, in each shipped script, in the runtime's Chrome inside the sandbox with the
// font pack installed: nothing clipped, no missing glyph, readable; the same tile draws the same
// pixels with the system fonts taken out of its stacks; and on rendered masters QG-08, QG-09 and
// QG-10 pass, Devanagari read and the other scripts glyph-checked. Synthetic pictures only.

const FLICKS = 705_600_000
const skip = fontsSkip()
const dir = realpathSync(mkdtempSync(join(tmpdir(), "kh-type-")))
const FRAMES = [[1080, 1920], [1920, 1080], [1080, 1080], [1080, 1350]]
const LONG = {
  latin: ["Understanding", "Responsibility", "Extraordinary", "Communication", "Unbelievable"],
  devanagari: ["जिम्मेदारियों", "प्रतिस्पर्धात्मक", "अंतरराष्ट्रीय", "विश्वविद्यालय", "संभावनाओं"],
  telugu: ["బాధ్యతలను", "అంతర్జాతీయ", "విశ్వవిద్యాలయం", "ప్రత్యేకమైన", "సంభాషణలు"],
  tamil: ["பொறுப்புகளை", "சர்வதேசத்தில்", "பல்கலைக்கழகம்", "சிறப்பான", "உரையாடல்கள்"],
  kannada: ["ಜವಾಬ್ದಾರಿಗಳು", "ಅಂತರರಾಷ್ಟ್ರೀಯ", "ವಿಶ್ವವಿದ್ಯಾಲಯ", "ವಿಶೇಷವಾದ", "ಸಂಭಾಷಣೆಗಳು"],
  malayalam: ["ഉത്തരവാദിത്തങ്ങൾ", "അന്താരാഷ്ട്ര", "സർവ്വകലാശാല", "പ്രത്യേകമായ", "സംഭാഷണങ്ങൾ"],
  bengali: ["দায়িত্বগুলো", "আন্তর্জাতিক", "বিশ্ববিদ্যালয়", "বিশেষভাবে", "কথোপকথন"],
  gujarati: ["જવાબદારીઓ", "આંતરરાષ્ટ્રીય", "વિશ્વવિદ્યાલય", "વિશેષરૂપે", "વાતચીત"],
  gurmukhi: ["ਜ਼ਿੰਮੇਵਾਰੀਆਂ", "ਅੰਤਰਰਾਸ਼ਟਰੀ", "ਯੂਨੀਵਰਸਿਟੀ", "ਵਿਸ਼ੇਸ਼", "ਗੱਲਬਾਤ"],
}
const ALL_FONT_IDS = Object.keys(FONTS)
// Longest that fits a limit, from the script's own words
const upTo = (words, max) => words.reduce((text, word) => (`${text} ${word}`.trim().length <= max ? `${text} ${word}`.trim() : text), "")
let runtime
let bare

before(() => {
  if (skip) return
  runtime = motionRuntime(linkFonts(join(dir, "home")))
  bare = motionRuntime(linkMotion(join(dir, "bare")))
  assert.equal(runtime.fonts.size, 14)
  assert.equal(bare.fonts.size, 0)
})

const kitFor = (pair = "clean", installed = ALL_FONT_IDS) => kitNode({ pair }, installed)
const placementOf = (kind, width, height) => {
  const region = REGIONS[kind]
  if (region?.region === "full") return { x: Math.round(width * 0.06), y: Math.round(height * 0.08), w: Math.round(width * 0.88), h: Math.round(height * 0.7) }
  if (region?.region === "frame") return { x: 0, y: 0, w: width, h: height }
  if (region?.region === "point") {
    const side = Math.floor(Math.min(width * region.w, height * region.h))
    return { x: Math.round(width / 2 - side / 2), y: Math.round(height * 0.55), w: side, h: side }
  }
  if (region) return { x: Math.round(width * 0.05), y: Math.round(height * 0.6), w: Math.floor(width * 0.9 * region.w), h: Math.floor(height * region.h) }
  return { x: Math.round(width * 0.1), y: Math.round(height * 0.6), w: Math.floor(width * 0.8), h: Math.floor(height * 0.12) }
}
const captionNode = (look, words, type) => {
  const step = Math.round(FLICKS / 3)
  return { kind: "caption", words: words.map((text, i) => ({ text, at: i * step, end: (i + 1) * step, emphasis: i === 1 })), look, style: {}, duration: words.length * step + FLICKS, type }
}
const atRest = (node) => node.words.length * Math.round(FLICKS / 3) / FLICKS * 1000 + 400

/** Every look and kind, every frame, every script: what each tile must hold. */
function everyTile({ frames = FRAMES } = {}) {
  const items = []
  for (const [width, height] of frames) {
    const frame = { output: { width, height }, canvas: { width, height } }
    for (const [i, [script, words]] of Object.entries(LONG).entries()) {
      // Each script with a different pair, so all six faces are measured over the run
      const type = kitFor(Object.keys(PAIRS)[i % Object.keys(PAIRS).length])
      for (const look of Object.keys(ALL_LOOKS)) {
        const node = captionNode(look, words.slice(0, pageLimits(look).max), type)
        const placement = placementOf(null, width, height)
        items.push({ id: `${width}x${height}/${script}/caption/${look}`, html: captionComposition({ ...node, placement }, frame), times: [atRest(node)], at: atRest(node), placement, height, width, script })
      }
      for (const [kind, shape] of Object.entries(ALL_GRAPHIC_KINDS)) {
        if (!["lower", ...Object.keys(ALL_GRAPHIC_KINDS).filter((k) => !["title", "chapter", "quote", "intro", "end", "stat", "lower"].includes(k))].includes(kind)) continue
        for (const style of shape.styles) {
          const text = shape.number ? "₹1,23,456" : upTo(words, kind === "handle" ? 24 : 48)
          const variables = cleanGraphic({ kind, style, text, subtitle: upTo(words, 32), steps: words.map((w) => upTo([w], 32)), accent: "yellow", tone: "dark" }, ALL_GRAPHIC_KINDS)
          assert.ok(variables, `${kind} ${style} ${script}`)
          const placement = placementOf(kind, width, height)
          const ms3 = 6 * FLICKS
          items.push({ id: `${width}x${height}/${script}/${kind}/${style}`, html: blockComposition({ blockId: "graphic", version: 1, variables, placement, duration: ms3, type }, frame), times: [5000], at: 5000, placement, height, width, script, kind })
        }
      }
    }
  }
  return items
}

test("ET-TY-M1 (layout): every look and kit 2 kind, every frame and script, at its longest: nothing clipped, inside its box, big enough", { skip, timeout: 280_000 }, async () => {
  const items = everyTile()
  const started = Date.now()
  const measured = await measureText({ items, work: join(dir, "measure"), runtime })
  const problems = []
  for (const item of items) {
    const boxes = measured.get(item.id)[0]
    if (!boxes.length && item.kind !== "frame") problems.push(`${item.id}: no text measured`)
    const inside = item.kind === "callout" ? { x: 0, y: 0, w: item.width, h: item.height } : item.placement
    for (const box of boxes) {
      const name = `${item.id} "${box.text.slice(0, 16)}"`
      if (box.clipped) problems.push(`${name} clipped`)
      if (box.x < inside.x - 1 || box.y < inside.y - 1 || box.x + box.w > inside.x + inside.w + 1 || box.y + box.h > inside.y + inside.h + 1) problems.push(`${name} outside its box`)
      if (box.size / item.height < 0.02) problems.push(`${name} too small: ${box.size}px`)
    }
  }
  console.log(`ET-TY-M1 layout: ${items.length} tiles measured in ${((Date.now() - started) / 1000).toFixed(1)} s`)
  if (problems.length) console.log(problems.join("\n"))
  assert.deepEqual(problems.slice(0, 20), [])
})

test("ET-TY-M1 (glyphs): every look and kind in each script: every glyph drawn by a shipped font, none missing, every cluster drawn", { skip, timeout: 280_000 }, async () => {
  // Glyphs don't depend on the frame, so one frame: every look and kind, each script
  const items = everyTile({ frames: [[1080, 1920]] }).filter((item) => item.kind !== "frame")
  const started = Date.now()
  const reports = await checkGlyphs({ items, work: join(dir, "glyphs"), runtime })
  const problems = items.flatMap((item) => reports.get(item.id).flatMap((report) => glyphProblems(report, { shipped: true }).map((p) => `${item.id}: ${p}`)))
  const families = new Set(items.flatMap((item) => reports.get(item.id).flatMap((r) => r.fonts.map((f) => f.family))))
  console.log(`ET-TY-M1 glyphs: ${items.length} tiles in ${((Date.now() - started) / 1000).toFixed(1)} s; families drawn: ${[...families].sort().join(", ")}`)
  assert.deepEqual(problems.slice(0, 20), [])
  for (const script of Object.keys(LONG)) if (script !== "latin") assert.ok([...families].some((f) => f.toLowerCase().includes(script)), `${script} drew in its own font`)
})

test("ET-TY-M1 (seeded): the glyph check finds a character no font has (drawn as an empty box), and a script with no shipped font", { skip, timeout: 120_000 }, async () => {
  const frame = { output: { width: 1080, height: 1920 }, canvas: { width: 1080, height: 1920 } }
  const items = [
    // A noncharacter no font maps, and a Kawi letter (Unicode 15) nothing here has: Chrome draws each as Inter's empty box and calls it Inter
    ["missing", "Plan \uFDD1 now"],
    ["kawi", "Plan \u{11F04} now"],
    ["arabic", "مرحبا بكم"],
    ["clean", "ನಮಸ್ಕಾರ ಸ್ನೇಹಿತರೆ"],
  ].map(([id, text]) => {
    const node = captionNode("clean", text.split(" "), kitFor())
    return { id, html: captionComposition({ ...node, placement: placementOf(null, 1080, 1920) }, frame), at: atRest(node) }
  })
  const reports = await checkGlyphs({ items, work: join(dir, "seeded"), runtime })
  const problems = (id) => reports.get(id).flatMap((r) => glyphProblems(r, { shipped: true }))
  assert.match(problems("missing").join(" "), /1 missing glyph\(s\) in .*empty box/)
  assert.match(problems("kawi").join(" "), /1 missing glyph\(s\) in .*empty box/)
  assert.match(problems("arabic").join(" "), /not the shipped fonts/)
  assert.deepEqual(problems("clean"), [])
})

/** One frame of a tile, as RGBA bytes. */
async function framesOf(html, name, use = runtime) {
  const out = join(dir, "pixels", `${name}.mov`)
  mkdirSync(join(dir, "pixels"), { recursive: true })
  await renderTileInChrome({ html, work: join(dir, "pixels", `${name}.work`), output: out, fps: { n: 10, d: 1 }, runtime: use, seconds: 1.5 })
  return execFileSync("ffmpeg", ["-v", "error", "-i", out, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 1 << 30 })
}

test("ET-TY-M1 (pixels): the same tile draws the same pixels with the system fonts taken out of its stacks, in every script", { skip, timeout: 280_000 }, async () => {
  const frame = { output: { width: 540, height: 960 }, canvas: { width: 540, height: 960 } }
  const differ = []
  for (const [script, words] of Object.entries(LONG)) {
    const node = { ...captionNode("marker", words.slice(0, 3), kitFor("bold")), placement: placementOf(null, 540, 960) }
    const graphic = blockComposition({ blockId: "graphic", version: 1, variables: cleanGraphic({ kind: "card", style: "title", text: upTo(words, 40), subtitle: upTo(words, 24), accent: "teal", tone: "dark" }, ALL_GRAPHIC_KINDS), placement: placementOf("card", 540, 960), duration: 2 * FLICKS, type: kitFor("story") }, frame)
    for (const [kind, html] of [["caption", captionComposition(node, frame)], ["card", graphic]]) {
      // The same document, its font stacks cut to the shipped families only: no system font can stand in
      const shipped = html.replace(/font-family:([^;}]+)/g, (_, stack) => `font-family:${shippedOnly(stack)}`)
      assert.notEqual(shipped, html)
      const a = createHash("sha256").update(await framesOf(html, `${script}-${kind}-a`)).digest("hex")
      const b = createHash("sha256").update(await framesOf(shipped, `${script}-${kind}-b`)).digest("hex")
      if (a !== b) differ.push(`${script} ${kind}`)
    }
  }
  assert.deepEqual(differ, [])
})

/* ─────────────────────────────── on rendered masters ─────────────────────────────── */

const FPS = 30
const W = 540
const H = 960
const ffmpeg = (...args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args, "-y"])
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex")

async function master(name, ops, words, { use = runtime } = {}) {
  const source = join(dir, "grey.mov")
  ffmpeg("-f", "lavfi", "-i", `color=c=0x6b7b80:s=${W}x${H}:r=${FPS}:d=6`, "-f", "lavfi", "-i", "sine=f=220:r=48000:d=6", "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-c:a", "aac", "-shortest", source)
  const index = { words: words.map((text, i) => ({ asset: "a1", id: `a1:w${i}`, start: ms(800 + i * 600), end: ms(1300 + i * 600), text, lang: "xx", speaker: "s0", conf: 1 })), sentences: [], shots: [], faces: [] }
  const root = realpathSync(mkdtempSync(join(dir, `${name}-`)))
  const { facts } = await probe(source)
  const project = structuredClone(makeProject())
  project.canvas = { ...project.canvas, width: W, height: H, fps: { n: FPS, d: 1 } }
  project.assets = [{ ...project.assets[0], id: "a1", path: source, fingerprint: sha(source), facts }]
  const applied = apply(project, [{ op: "keep_range", asset: "a1", from: 0, to: ms(6000) }, { op: "add_deliverable", preset: "reel-9x16", size: { width: W, height: H }, fps: { n: FPS, d: 1 }, codec: "h264", audio: "aac", loudness: { lufs: -14, tp: -1 }, burnCaptions: true }, ...ops], { index, author: "person" })
  assert.deepEqual(applied.diagnostics, [])
  const engine = createEngine({ folder: root, roots: [root, dir], cache: join(root, "cache"), exports: join(root, "exports"), journal: openJournal(":memory:"), toolVersion: "9", capabilities: await readCapabilities(), motion: () => use })
  engine.load(applied.project, index)
  const { file, plan } = await engine.render({ quality: "master", deliverable: applied.project.deliverables[0].id })
  const checked = await runGates({ file, plan, project: applied.project, index, sourcePath: () => source, only: ["QG-08", "QG-09", "QG-10"], tilePath: engine.tilePath, motion: use, work: join(root, "gates"), binDir: join(dir, "bin") })
  return { gates: Object.fromEntries(checked.gates.map((g) => [g.id, g])), plan }
}

test("ET-TY-M1 (gates): a type kit's looks and kit 2 on rendered masters pass QG-08, QG-09 and QG-10, in Latin, Devanagari and Telugu", { skip, timeout: 280_000 }, async () => {
  const runs = [
    ["latin", ["Start", "small", "and", "keep", "going", "every", "day"], "marker"],
    ["devanagari", ["आज", "हम", "कुछ", "नया", "सीखेंगे", "सब", "मिलकर"], "duo"],
    ["telugu", ["మీకు", "స్వాగతం", "మిత్రులారా", "ఈరోజు", "కొత్తది", "నేర్చుకుందాం", "కలిసి"], "underline"],
  ]
  for (const [script, words, look] of runs) {
    const ops = [
      { op: "set_type_kit", pair: "bold", colors: { text: "#ffffff", accent: "#ffd23f" } },
      { op: "caption_style", look, words: ["a1:w0", "a1:w1"] },
      { op: "caption_style", look, words: ["a1:w2", "a1:w3"] },
      { op: "add_motion", block: "graphic", version: 1, variables: cleanGraphic({ kind: "count", text: "48%", subtitle: words[4], accent: "yellow", tone: "dark" }, ALL_GRAPHIC_KINDS), at: { word: "a1:w5", edge: "start" }, duration: ms(1400) },
    ]
    const { gates, plan } = await master(script, ops, words)
    console.log(`${script}: QG-08 ${gates["QG-08"].status}, QG-09 ${gates["QG-09"].status} ${JSON.stringify(gates["QG-09"].numbers)}, QG-10 ${gates["QG-10"].status} ${JSON.stringify(gates["QG-10"].numbers)}`)
    assert.ok(plan.tiles.every((t) => t.node.type?.shipped === true))
    for (const id of ["QG-08", "QG-09", "QG-10"]) assert.equal(gates[id].status, "passed", `${script} ${id}: ${JSON.stringify(gates[id])}`)
    if (script === "telugu") assert.ok(gates["QG-10"].numbers.glyphChecked >= 2, "the Telugu tiles were glyph-checked")
    if (script === "devanagari") assert.equal(gates["QG-10"].numbers.unread, 0, "Devanagari was read")
  }
})

// EH-92 (fixed in TP11): an approved plan's kit 2 graphics, placed by the make's own graphicOps (as the make route lets them
// through with editing.typeKit on), render on a master and pass QG-08, QG-09 and QG-10. Before the fix the make dropped them
test("EH-92: approved kit 2 graphics placed by the make render on a master and pass QG-08, QG-09 and QG-10", { skip, timeout: 280_000 }, async () => {
  const words = ["Start", "small", "ship", "fast", "every", "day", "always"]
  const index = { words: words.map((text, i) => ({ asset: "a1", id: `a1:w${i}`, start: ms(800 + i * 600), end: ms(1300 + i * 600), text, lang: "en", speaker: "s0", conf: 1 })), sentences: [], shots: [], faces: [] }
  const project = structuredClone(makeProject())
  project.canvas = { ...project.canvas, width: W, height: H, fps: { n: FPS, d: 1 } }
  project.assets = [{ ...project.assets[0], id: "a1", facts: { ...project.assets[0].facts, duration: ms(6000) } }]
  const cut = apply(project, [{ op: "keep_range", asset: "a1", from: 0, to: ms(6000) }], { index, author: "person" })
  assert.deepEqual(cut.diagnostics, [])
  const approved = [
    { kind: "count", text: "48%", subtitle: "every day", at: "a1:w0" },
    { kind: "list", style: "steps", text: "Start small", steps: ["Start small", "ship fast"], at: "a1:w6" },
  ]
  const { ops, notes } = graphicOps({ graphics: approved, project: cut.project, index, asset: "a1", kept: index.words })
  assert.deepEqual(notes, [])
  assert.deepEqual(ops.map((op) => op.variables.kind), ["count", "list"])
  const { gates, plan } = await master("eh92", [{ op: "set_type_kit", pair: "clean" }, ...ops], words)
  console.log(`EH-92: tiles ${plan.tiles.map((t) => t.node.variables?.kind).join(", ")}; QG-08 ${gates["QG-08"].status}, QG-09 ${gates["QG-09"].status}, QG-10 ${gates["QG-10"].status}`)
  assert.deepEqual(plan.tiles.map((t) => t.node.variables?.kind), ["count", "list"])
  for (const id of ["QG-08", "QG-09", "QG-10"]) assert.equal(gates[id].status, "passed", `${id}: ${JSON.stringify(gates[id])}`)
})

test("ET-TY-M1 (no pack): a computer without the font pack keeps the system stacks, says so, and the make still passes", { skip, timeout: 280_000 }, async () => {
  const words = ["Start", "small", "and", "keep", "going", "every", "day"]
  const { gates, plan } = await master("bare", [{ op: "set_type_kit", pair: "story" }, { op: "caption_style", look: "clean", words: ["a1:w0", "a1:w1", "a1:w2"] }], words, { use: bare })
  assert.ok(plan.issues.some((i) => i.code === "fonts_missing"))
  assert.equal(plan.tiles[0].node.type.shipped, false)
  for (const id of ["QG-08", "QG-09", "QG-10"]) assert.equal(gates[id].status, "passed", `${id}: ${JSON.stringify(gates[id])}`)
  assert.ok(Object.keys(PAIRS).length === 6)
})

/* ─────────────────────────────── the Studio (operator rule 7) ─────────────────────────────── */

const studioSkip = (await import("../../../src/browser.js")).browserTarget() ? false : "no Chrome on this computer"
const shots = process.env.TP7_SHOTS

async function studioWorld({ typeKit }) {
  const { spawn } = await import("node:child_process")
  const { chmodSync, writeFileSync } = await import("node:fs")
  const { ensureHost, hostCall } = await import("../../../src/edit/host/client.js")
  const { buildStudio } = await import("../../../studio/build.js")
  const { startFakeKriya } = await import("../../fake-kriya.js")
  const { ROOT } = await import("../../helpers.js")
  await buildStudio()
  const tasks = []
  const fake = await startFakeKriya({
    models: ["budget"],
    features: { visuals: false, playbooks: false, mediaSearch: false, motion: true, customMotion: false, assembly: false, livePreview: false, intent: false, craft: false, typeKit },
    chat(body) {
      const task = body.response_format?.json_schema?.name
      tasks.push({ task, body: JSON.stringify(body) })
      if (task === "plan") return { content: JSON.stringify({ say: "A warm story cut.", steps: ["Keep the best takes", "Two words at a time"], settings: { format: "9:16", seconds: 30, captions: typeKit ? "duo" : "clean", ...(typeKit ? { stylePack: "warm-story" } : {}) } }) }
      return { content: JSON.stringify({ graphics: [], ops: [] }) }
    },
  })
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kh-")))
  const login = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "login", "--url", fake.url, "--no-browser"], { env: { ...process.env, KRIYA_HOME: home }, stdio: "ignore" })
  assert.equal(await new Promise((done) => login.on("exit", done)), 0)
  const media = join(home, "media", "9.9.9")
  mkdirSync(join(media, "python", "bin"), { recursive: true })
  writeFileSync(join(media, "python", "bin", "python"), "#!/bin/sh\nexit 1\n")
  chmodSync(join(media, "python", "bin", "python"), 0o755)
  writeFileSync(join(media, "manifest.json"), "{}")
  writeFileSync(join(media, ".complete"), "test")
  writeFileSync(join(home, "media", "current.json"), JSON.stringify({ current: "9.9.9", previous: null }))
  const folder = join(home, "work", "film")
  mkdirSync(folder, { recursive: true })
  const take = join(folder, "take.mov")
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=4", "-f", "lavfi", "-i", "sine=f=220:r=48000:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", take])
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0xffd23f:s=200x100:d=1", "-frames:v", "1", "-y", join(folder, "logo.png")])
  const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: join(home, "work"), KRIYA_EDIT_IDLE_MS: "600000" }
  const host = await ensureHost({ env, home })
  const call = (method, path, body) => hostCall(home, method, path, body)
  const { id } = await call("POST", "/projects", { name: "Film", folder })
  const a = await call("POST", `/projects/${id}/assets`, { path: take })
  await call("POST", `/projects/${id}/assets`, { path: join(folder, "logo.png") })
  await call("PATCH", `/projects/${id}`, { ops: [{ op: "keep_range", asset: a.id, from: 0, to: 4 * FLICKS }] })
  return { home, host, call, id, fake, tasks }
}

test("ET-TY-UI: the make panel's style pack, type, brand colours, logo and bar, the fourteen looks and the card's Style; 1280 and 360 px, light and dark; off, none of it", { skip: studioSkip, timeout: 280_000 }, async () => {
  const { chromium } = await import("playwright-core")
  const { browserTarget } = await import("../../../src/browser.js")
  const { stopHost } = await import("../../../src/edit/host/client.js")
  const shoot = async (page, name) => shots && (mkdirSync(shots, { recursive: true }), await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true }))
  const smallTargets = (page) =>
    page.evaluate(() =>
      [...document.querySelectorAll("button, a, input, select, textarea, [role=option]")]
        .filter((el) => el.offsetParent && !el.classList.contains("word") && !el.closest(".inline"))
        .map((el) => ({ el: el.getAttribute("aria-label") || el.id || el.textContent || el.className, ...el.getBoundingClientRect().toJSON() }))
        .filter((r) => r.height < 44 || r.width < 44)
        .map((r) => `${r.el}: ${Math.round(r.width)}×${Math.round(r.height)}`),
    )
  for (const typeKit of [true, false]) {
    const w = await studioWorld({ typeKit })
    const browser = await chromium.launch({ ...browserTarget(), headless: true })
    try {
      const problems = []
      const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
      page.on("console", (message) => message.type() === "error" && problems.push(`${message.text()} ${message.location().url}`))
      page.on("pageerror", (error) => problems.push(String(error)))
      const { url } = await w.call("POST", "/internal/launch", {})
      await page.goto(url)
      await page.waitForURL(`http://127.0.0.1:${w.host.port}/`)
      await page.getByRole("link", { name: "Film" }).click()
      await page.waitForFunction(() => window.__studio)
      await page.evaluate(() => window.__studio.setMode("direct"))
      // The redesign's Kriya panel: the make's choices are on its Brief tab
      await page.getByRole("tab", { name: /^Brief/ }).click()
      const captionOptions = await page.locator("#make-captions option").allInnerTexts()
      if (!typeKit) {
        assert.deepEqual(await page.locator("#make-style, #make-type, #make-logo, #make-bar, #make-ink").count(), 0, "off: nothing of TP7 on the page")
        assert.equal(captionOptions.length, 7, "off: the six looks and none")
        assert.deepEqual(problems, [])
        continue
      }
      assert.equal(captionOptions.length, 15, "the fourteen looks and none")
      assert.ok(captionOptions.includes("Captions: two words"))
      assert.equal(await page.locator("#make-style option").count(), 13)
      assert.equal(await page.locator("#make-type option").count(), 7)
      assert.deepEqual(await page.locator("#make-logo option").allInnerTexts(), ["Logo: none", "logo.png"])
      assert.match(await page.locator(".make").innerText(), /The Fonts pack isn't installed on this computer/)
      await page.locator("#make-style").scrollIntoViewIfNeeded()
      await shoot(page, "1280-light-make")
      // The Plan Card carries the plan's pack, the person's to change
      await page.getByRole("tab", { name: /^Chat/ }).click()
      await page.locator("#prompt").fill("Make it a warm story")
      await page.getByRole("button", { name: "Plan", exact: true }).click()
      const card = page.locator(".proposal.plan")
      await card.waitFor({ timeout: 30_000 })
      // The card's look, captions and style pack, on its Look tab
      await card.getByRole("tab", { name: /^Look/ }).click()
      const style = card.getByRole("combobox", { name: "Style pack" })
      assert.equal(await style.inputValue(), "warm-story")
      assert.ok((await card.getByRole("combobox", { name: "Caption look" }).locator("option").allInnerTexts()).includes("Two words"))
      await style.selectOption("bold-promo")
      await shoot(page, "1280-light-card")
      // A make from the panel: the pack and the person's colours, logo and bar reach the job
      await page.getByRole("tab", { name: /^Brief/ }).click()
      await page.locator("#make-style").selectOption("creator-pop")
      await page.locator("#make-accent-on").check()
      await page.locator("#make-accent").fill("#ff7ab6")
      await page.locator("#make-logo").selectOption({ label: "logo.png" })
      await page.locator("#make-bar").selectOption("progress")
      await page.locator(".make").getByRole("button", { name: "Make it" }).click()
      const { DatabaseSync } = await import("node:sqlite")
      const brief = await (async () => {
        for (let i = 0; i < 100; i++) {
          const db = new DatabaseSync(join(w.home, "edit", w.id, "journal.sqlite"), { readOnly: true })
          const row = db.prepare("select request from jobs where kind = 'make' order by id desc limit 1").get()
          db.close()
          if (row) return JSON.parse(row.request).brief
          await new Promise((done) => setTimeout(done, 100))
        }
        return null
      })()
      assert.equal(brief.typeKit.pack, "creator-pop")
      assert.equal(brief.typeKit.pair, "modern", "the pack's pair, since no Type was chosen")
      assert.deepEqual([brief.typeKit.colors, brief.typeKit.bar, brief.typeKit.corner], [{ accent: "#ff7ab6" }, "progress", "tr"])
      assert.equal(brief.captions, "duo", "the pack's look, since the panel chose none")
      await page.emulateMedia({ colorScheme: "dark" })
      await shoot(page, "1280-dark")
      assert.deepEqual(await smallTargets(page), [], "1280: every target is at least 44 px")
      await page.setViewportSize({ width: 360, height: 800 })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, "360: no sideways scroll")
      assert.deepEqual(await smallTargets(page), [], "360: every target is at least 44 px")
      assert.ok((await page.locator("#make-accent").boundingBox()).height >= 44, "a colour swatch is a 44 px target")
      await page.locator("#make-style").scrollIntoViewIfNeeded()
      await shoot(page, "360-dark")
      await page.emulateMedia({ colorScheme: "light" })
      await shoot(page, "360-light")
      assert.deepEqual(problems, [], "a clean console")
    } finally {
      await browser.close()
      await stopHost(w.home)
      await w.fake.close()
    }
  }
})


// EH-92 in the Studio (TP11): with editing.typeKit on, the Plan Card shows an approved plan's kit 2 graphics playing in
// their sandboxed previews (before the fix the preview route refused them), through a Host whose own channel now needs
// its per-launch token. 1280 and 360 px, light and dark, targets 44 px or more, no sideways scroll, console clean
test("EH-92 (UI): the Plan Card previews kit 2 graphics with the type kit on; 360 and 1280 px, light and dark, clean console", { skip: studioSkip || fontsSkip(), timeout: 280_000 }, async () => {
  const { spawn } = await import("node:child_process")
  const { chromium } = await import("playwright-core")
  const { browserTarget } = await import("../../../src/browser.js")
  const { ensureHost, hostCall, stopHost } = await import("../../../src/edit/host/client.js")
  const { hostToken } = await import("../../../src/edit/host/paths.js")
  const { buildStudio } = await import("../../../studio/build.js")
  const { startFakeKriya } = await import("../../fake-kriya.js")
  const { ROOT } = await import("../../helpers.js")
  const { fakeRuntime, rawTake } = await import("../take.js")
  await buildStudio()
  const ids = {}
  const fake = await startFakeKriya({
    models: ["budget"],
    features: { visuals: false, playbooks: false, mediaSearch: false, motion: true, customMotion: false, assembly: false, livePreview: false, intent: false, craft: false, typeKit: true },
    chat(body) {
      const task = body.response_format?.json_schema?.name
      if (task === "plan") return { content: JSON.stringify({ say: "A tight cut with two graphics.", steps: ["Keep the best takes"], settings: { format: "9:16", seconds: 30, captions: "none", music: "none", cutSound: "none" } }) }
      if (task === "graphics") return { content: JSON.stringify({ graphics: [{ kind: "list", style: "steps", text: "Start small", steps: ["Start small", "ship fast"], at: ids.start }, { kind: "card", style: "quote", text: "The hardest part was the design", at: ids.listen }] }) }
      return { content: JSON.stringify({ graphics: [], ops: [] }) }
    },
  })
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kh-eh92-")))
  const login = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "login", "--url", fake.url, "--no-browser"], { env: { ...process.env, KRIYA_HOME: home }, stdio: "ignore" })
  assert.equal(await new Promise((done) => login.on("exit", done)), 0)
  fakeRuntime(home)
  linkFonts(home, { hyperframes: false })
  const folder = join(home, "work", "film")
  mkdirSync(folder, { recursive: true })
  rawTake(join(folder, "take.mov"))
  const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: join(home, "work"), KRIYA_EDIT_IDLE_MS: "600000" }
  const host = await ensureHost({ env, home })
  assert.match(hostToken(home), /^[a-f0-9]{64}$/, "this Host's channel has its token")
  const call = (method, path, body) => hostCall(home, method, path, body)
  const browser = await chromium.launch({ ...browserTarget(), headless: true })
  const shots = process.env.KRIYA_SHOTS
  const problems = []
  try {
    const { id } = await call("POST", "/projects", { name: "Film", folder })
    const a = await call("POST", `/projects/${id}/assets`, { path: join(folder, "take.mov") })
    const job = await call("POST", `/projects/${id}/index`, { asset: a.id })
    for (let i = 0; i < 600 && !(await call("GET", "/jobs")).jobs.some((j) => j.id === job.id && j.status === "done"); i++) await new Promise((done) => setTimeout(done, 200))
    const { words } = await call("GET", `/projects/${id}/index`)
    ids.start = words.find((w) => /^start$/i.test(w.text.replace(/\W/g, "")))?.id
    ids.listen = words.find((w) => /^hardest$/i.test(w.text.replace(/\W/g, "")))?.id
    assert.ok(ids.start && ids.listen, "the take's words are indexed")
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
    page.on("console", (message) => message.type() === "error" && problems.push(`${message.text()} ${message.location().url}`))
    page.on("pageerror", (error) => problems.push(String(error)))
    const { url } = await call("POST", "/internal/launch", {})
    await page.goto(url)
    await page.waitForURL(`http://127.0.0.1:${host.port}/`)
    await page.getByRole("link", { name: "Film" }).click()
    await page.waitForFunction(() => window.__studio)
    await page.locator("#prompt").fill("edit this with motion graphics")
    await page.getByRole("button", { name: "Plan", exact: true }).click()
    const card = page.locator(".proposal.plan")
    await card.getByRole("tab", { name: /^Graphics/ }).click({ timeout: 60_000 })
    await card.getByText("Motion graphics", { exact: true }).waitFor({ timeout: 60_000 })
    assert.equal(await card.locator(".graphic-picture").count(), 2, "both kit 2 graphics are on the card")
    // In the order they play: the card's line comes first in the take
    await page.frameLocator(".graphic-picture iframe >> nth=0").getByText("The hardest part was the design").waitFor({ timeout: 20_000 })
    await page.frameLocator(".graphic-picture iframe >> nth=1").getByText("ship fast").waitFor({ timeout: 20_000 })
    assert.ok(await card.locator(".graphic-picture").nth(1).isVisible(), "the list's preview, on the Graphics part")
    for (const [width, height] of [[1280, 860], [360, 800]]) {
      await page.setViewportSize({ width, height })
      for (const colorScheme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme })
        await card.scrollIntoViewIfNeeded()
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width} ${colorScheme}: no sideways scroll`)
        for (const control of await card.locator("button, select").all()) {
          const box = await control.boundingBox()
          if (box) assert.ok(box.height >= 44, `${width}: a ${Math.round(box.height)} px control`)
        }
        if (shots) {
          mkdirSync(shots, { recursive: true })
          for (const [n, row] of (await card.locator(".scene-row").all()).entries()) {
            await row.scrollIntoViewIfNeeded()
            await row.screenshot({ path: join(shots, `kit2-plan-card-${n + 1}-${width}-${colorScheme}.png`) })
          }
        }
      }
    }
    assert.deepEqual(problems, [], "console clean")
  } finally {
    await browser.close()
    await stopHost(home)
    await fake.close()
  }
})
