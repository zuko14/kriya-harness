import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { createServer, request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { test } from "node:test"

import { segmentArgs } from "../src/edit/core/ffmpeg.js"
import { REGIONS, solveLayout } from "../src/edit/core/layout.js"
import { apply } from "../src/edit/core/ops.js"
import { compile } from "../src/edit/core/plan.js"
import { solve } from "../src/edit/core/solver.js"
import { applyStylePack, STYLE_PACKS } from "../src/edit/core/style-packs.js"
import { TRANSITIONS } from "../src/edit/core/transitions.js"
import { CONTRAST, cleanTypeKit, contrastRatio, kitNode, PAIRS, readableColors, typeKitOf, typeScale } from "../src/edit/core/type-kit.js"
import { GRAPHICS_SCHEMA, GRAPHICS_SCHEMA_2, graphicProblems } from "../src/edit/director/graphics.js"
import { consoleSchema, typeKitSchema } from "../src/edit/director/revise.js"
import { ALL_LOOKS, ARRIVALS, captionAtRest, captionComposition, LOOKS, MARKS, MORE_CAPTION_LOOKS, pageLimits, pages, placeOf } from "../src/edit/engine/captions.js"
import { clusterCount, FONT_LICENCES, FONT_PACK, fontFaces, fontsAsked, fontsFor, FONTS, fontStackFor, glyphProblems, installedFonts, OCR_READS, SCRIPT_FONTS, scriptRuns, scriptsIn, shippedOnly, withFonts } from "../src/edit/engine/fonts.js"
import { ALL_GRAPHIC_KINDS, cleanGraphic, countSteps, GRAPHIC_ACCENTS, GRAPHIC_KINDS, GRAPHIC_TONES, KIT2_KINDS, LOWER_STYLES_2 } from "../src/edit/engine/graphics.js"
import { ALL_MOODS } from "../src/edit/engine/music-bed.js"
import { blockComposition, lintComposition } from "../src/edit/engine/motion.js"
import { PACKS, packStatus } from "../src/edit/engine/packs.js"
import { judgeCopy } from "../src/edit/gates/copy.js"
import { GRADES } from "../src/edit/recipes/reel.js"
import { licenceVerdict, manifestLicenceProblems } from "../src/edit/runtime/licences.js"
import { openManifest } from "../src/edit/runtime/manifest.js"
import { activeRuntime, install, installPack } from "../src/edit/runtime/setup.js"
import { openManifest as openBefore } from "./edit/manifest-pre-tp7.js"
import { makeIndex, makeProject, ms } from "./edit/fixture.js"
import { freshHome, ROOT } from "./helpers.js"

// TP7 (CRAFT_UPGRADE §5, TOP_TIER_PLAN §5, EDD-67): fonts in the runtime as a pack, the script
// router and the glyph check, the type kit and brand colours, fourteen caption looks, motion kit 2,
// style packs; and with nothing chosen, everything as it was. No media here:
// tests/edit/media/type-kit.test.js renders every look and kind in real Chrome.

const FLICKS = 705_600_000
const VERSIONS = { engineVersion: "e", runtimeVersion: "r" }
const index = makeIndex()
const sha256 = (data) => createHash("sha256").update(data).digest("hex")
const SAMPLES = { latin: "Start small and keep going", devanagari: "आज हम कुछ नया सीखेंगे", telugu: "మీకు స్వాగతం మిత్రులారా", tamil: "இன்று புதிதாக கற்போம்", kannada: "ಇಂದು ಹೊಸದನ್ನು ಕಲಿಯೋಣ", malayalam: "ഇന്ന് പുതിയത് പഠിക്കാം", bengali: "আজ আমরা নতুন কিছু শিখব", gujarati: "આજે આપણે કંઈક નવું શીખીશું", gurmukhi: "ਅੱਜ ਅਸੀਂ ਕੁਝ ਨਵਾਂ ਸਿੱਖਾਂਗੇ" }
const MANIFEST = JSON.parse(readFileSync(join(ROOT, "tests", "edit", "runtime-2026.11.1.json"), "utf8"))
const ALL_FONTS = Object.keys(FONTS)
const cut = (ops = [], author = "person") => {
  const base = apply(makeProject(), [{ op: "keep_range", asset: "a1", from: 0, to: ms(14000) }], { index, author: "person" })
  assert.deepEqual(base.diagnostics, [])
  return apply(base.project, ops, { index, author })
}
const withImage = (project) => ({ ...project, assets: [...project.assets, { id: "logo1", kind: "image", fingerprint: "fp-logo", path: "media/logo.png", linked: true, rights: "own", role: "logo", facts: { width: 400, height: 200 } }] })

/* ─────────────────────────────── fonts and scripts ─────────────────────────────── */

test("ET-TY-01: the script picks the font: each shipped script has its own, runs keep shared characters, a mixed line names each", () => {
  for (const [script, text] of Object.entries(SAMPLES)) {
    assert.deepEqual(scriptsIn(text), [script], script)
    const ids = fontsFor(text, "font-inter")
    assert.equal(ids[0], "font-inter")
    if (script !== "latin") assert.deepEqual(ids, ["font-inter", SCRIPT_FONTS[script]], script)
    assert.ok(FONTS[ids.at(-1)].scripts.includes(script))
  }
  assert.deepEqual(scriptRuns("Hello, నమస్తే 2026!"), [{ script: "latin", text: "Hello, " }, { script: "telugu", text: "నమస్తే 2026!" }])
  assert.deepEqual(scriptRuns("123 "), [{ script: "common", text: "123 " }])
  assert.deepEqual(fontsFor("Price ₹500 आज, మీకు", "font-oswald"), ["font-oswald", "font-noto-sans-devanagari", "font-noto-sans-telugu"])
  // A script with nothing shipped adds no font: the system stack draws it and the glyph check says so
  assert.deepEqual(fontsFor("مرحبا", "font-inter"), ["font-inter"])
  assert.deepEqual(scriptsIn("مرحبا"), ["other"])
})

test("ET-TY-02: the fallback chain: shipped families first, the system stacks under them; a font not installed is left out, never a failure", () => {
  const mixed = "Hi మీకు"
  const all = fontStackFor(mixed, "font-inter")
  assert.equal(all, `'Kriya Inter','Kriya Noto Sans Telugu',${FONTS["font-inter"].system},${FONTS["font-noto-sans-telugu"].system}`)
  assert.equal(shippedOnly(all), "'Kriya Inter','Kriya Noto Sans Telugu'")
  assert.equal(fontStackFor(mixed, "font-inter", new Set()), `${FONTS["font-inter"].system},${FONTS["font-noto-sans-telugu"].system}`)
  assert.equal(fontStackFor(mixed, "font-inter", new Set(["font-inter"])), `'Kriya Inter',${FONTS["font-inter"].system},${FONTS["font-noto-sans-telugu"].system}`)
  assert.equal(fontStackFor("x", "not-a-font"), fontStackFor("x", "font-inter"))
  // The renderer fills the faces it has, as data, and drops the ones it hasn't
  const dir = mkdtempSync(join(tmpdir(), "kh-fonts-"))
  writeFileSync(join(dir, "inter.ttf"), Buffer.from("not really a font"))
  const css = fontFaces(["font-inter", "font-noto-sans-telugu", "font-inter", "nope"])
  assert.deepEqual(fontsAsked(css), ["font-inter", "font-noto-sans-telugu"])
  const html = `<style>${css}</style>`
  const filled = withFonts(html, new Map([["font-inter", join(dir, "inter.ttf")]]))
  assert.match(filled, /src:url\("data:font\/ttf;base64,bm90IHJlYWxseSBhIGZvbnQ="\)/)
  assert.doesNotMatch(filled, /kriya-font:|Noto Sans Telugu/)
  assert.equal(withFonts("<p>no fonts</p>", undefined), "<p>no fonts</p>")
  assert.equal(withFonts(html, undefined), "<style></style>")
  // A composition asking for a font names no address a lint would refuse
  assert.deepEqual(lintComposition(html), [])
  // Installed means: the pack finished (.complete), and only files its signed manifest names
  const runtime = { dir: join(dir, "rt"), manifest: MANIFEST }
  const packDir = join(runtime.dir, "packs", FONT_PACK)
  mkdirSync(join(packDir, "font-inter"), { recursive: true })
  writeFileSync(join(packDir, "font-inter", "Inter.ttf"), "x")
  assert.equal(installedFonts(runtime, "darwin-arm64").size, 0, "not complete yet")
  writeFileSync(join(packDir, ".complete"), "h")
  assert.deepEqual([...installedFonts(runtime, "darwin-arm64").keys()], ["font-inter"])
  assert.equal(installedFonts(null).size, 0)
})

test("ET-TY-03: the glyph check: a last-resort box, a system font where the pack was installed, a cluster not drawn; each is found", () => {
  assert.equal(clusterCount("आज हम कुछ"), 6)
  assert.equal(clusterCount("క్ష"), 1, "a conjunct is one cluster")
  assert.equal(clusterCount("a b  c"), 3)
  const text = "మీకు స్వాగతం"
  const ok = { text, fonts: [{ family: "Kriya Noto Sans Telugu", custom: true, glyphs: 16 }], drawn: clusterCount(text) }
  assert.deepEqual(glyphProblems(ok, { shipped: true }), [])
  assert.match(glyphProblems({ ...ok, fonts: [...ok.fonts, { family: "LastResort", custom: false, glyphs: 2 }] }, { shipped: true })[0], /2 missing glyph/)
  assert.match(glyphProblems({ ...ok, fonts: [{ family: "Kohinoor Telugu", custom: false, glyphs: 16 }] }, { shipped: true })[0], /drew with Kohinoor Telugu/)
  assert.deepEqual(glyphProblems({ ...ok, fonts: [{ family: "Kohinoor Telugu", custom: false, glyphs: 16 }] }, { shipped: false }), [], "without the pack a system font is the fallback, not a fault")
  assert.equal(glyphProblems({ ...ok, drawn: 2 }, { shipped: true })[0], `"${text}" shows 2 of its ${clusterCount(text)} clusters`)
  // TPX-05: the reader reads Latin and Devanagari only; the rest are the glyph check's
  assert.deepEqual(OCR_READS, { latin: "en-US", devanagari: "hi-IN" })
  // A typed Devanagari tile is read; untyped it stays unread, as before; the vowel signs count
  const tile = { key: "k", at: 0, kind: "block", node: { variables: { text: "आज हम कुछ नया सीखेंगे" } } }
  assert.equal(judgeCopy([{ tile, seen: "आज हम कुछ नया सीखेंगे" }], { copySimilarity: 0.9 }).unread.length, 1)
  assert.deepEqual(judgeCopy([{ tile, seen: "आज हम कुछ नया सीखेंगे", reads: ["latin", "devanagari"] }], { copySimilarity: 0.9 }).failures, [])
  assert.equal(judgeCopy([{ tile, seen: "आज हम कछ नया सीखेंगे", reads: ["latin", "devanagari"] }], { copySimilarity: 0.9 }).failures[0].kind, "copy_mismatch", "a missing vowel sign is a missing word")
})

/* ─────────────────────────────── the type kit and brand ─────────────────────────────── */

test("ET-TY-04: pairs name shipped faces; the kit is checked at the operation, the person's alone, and stored only when chosen", () => {
  for (const [id, pair] of Object.entries(PAIRS)) {
    for (const face of [pair.heading, pair.body]) {
      assert.ok(FONTS[face.font] && FONTS[face.font].role !== "script", `${id}: ${face.font}`)
      assert.ok(face.weight >= 100 && face.weight <= 900 && ["none", "upper"].includes(face.case) && Math.abs(face.tracking) <= 0.05)
    }
  }
  for (const height of [1080, 1350, 1920]) for (const size of Object.values(typeScale(height))) assert.ok(size / height >= 0.02, `${size}px of ${height}`)
  assert.deepEqual(cleanTypeKit(undefined), { kit: null, problem: null })
  for (const bad of [{ pair: "comic" }, { pair: "clean", colors: { text: "red" } }, { pair: "clean", bar: "ticker" }, { pair: "clean", logo: "../x" }, { pair: "clean", pack: "nope" }, []]) assert.ok(cleanTypeKit(bad, { packs: STYLE_PACKS }).problem, JSON.stringify(bad))
  assert.deepEqual(cleanTypeKit({ pair: "bold", colors: { text: "#FFFFFF", plate: "#000000", junk: "#123456" }, logo: "logo1", bar: "progress", pack: "bold-promo", extra: 1 }, { packs: STYLE_PACKS }).kit, { pair: "bold", colors: { text: "#ffffff", plate: "#000000" }, logo: "logo1", corner: "tr", bar: "progress", pack: "bold-promo" })
  // The operation: the person's, the logo an image of the bin, `clear` back to the system stacks
  const base = withImage(cut().project)
  const as = (ops, author = "person") => apply(base, ops, { index, author })
  assert.equal(as([{ op: "set_type_kit", pair: "story" }], "agent").diagnostics[0].code, "person_only")
  assert.equal(as([{ op: "set_type_kit", pair: "nope" }]).diagnostics[0].code, "bad_type_kit")
  assert.equal(as([{ op: "set_type_kit", pair: "clean", logo: "m1" }]).diagnostics[0].code, "wrong_asset_kind", "a sound isn't a logo")
  assert.equal(as([{ op: "set_type_kit", pair: "clean", logo: "zz" }]).diagnostics[0].code, "unknown_asset")
  const set = as([{ op: "set_type_kit", pair: "clean", logo: "logo1", corner: "bl", colors: { accent: "#ff7ab6" } }])
  assert.deepEqual(set.diagnostics, [])
  assert.deepEqual(set.project.look.brand.type, { pair: "clean", colors: { accent: "#ff7ab6" }, logo: "logo1", corner: "bl" })
  assert.deepEqual(typeKitOf(set.project), set.project.look.brand.type)
  assert.equal("type" in apply(set.project, [{ op: "set_type_kit", clear: true }], { index, author: "person" }).project.look.brand, false)
  // A kit written some other way (an older set_look) that isn't one reads as none
  assert.equal(typeKitOf({ look: { brand: { type: { pair: "comic" } } } }), null)
  // The node a tile carries: the pair's faces, and whether this computer has them
  assert.equal(kitNode({ pair: "clean" }, ALL_FONTS).shipped, true)
  assert.equal(kitNode({ pair: "clean" }, []).shipped, false)
  assert.equal(kitNode({ pair: "bold" }, ["font-inter"]).shipped, false)
})

test("ET-TY-05: the person's colours hold 4.5:1 whatever they type: the plate or outline is chosen by code, and what can't hold gives way", () => {
  const grid = []
  for (let r = 0; r < 256; r += 51) for (let g = 0; g < 256; g += 51) for (let b = 0; b < 256; b += 51) grid.push(`#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`)
  let checked = 0
  for (const text of grid) {
    for (const accent of ["#ffd23f", "#ff7ab6", "#4fd1c5", "#777777", text]) {
      for (const plate of [true, false]) {
        const colors = readableColors({ text, accent, plate: "#808000" }, { plate })
        const behind = colors.plate ?? colors.stroke
        assert.ok(contrastRatio(colors.text, behind) >= CONTRAST, `${text} on ${behind}`)
        assert.ok(contrastRatio(colors.accent, behind) >= CONTRAST, `${accent} on ${behind}`)
        if (contrastRatio(text, behind) >= CONTRAST) assert.equal(colors.text, text, "a text colour that holds is kept as typed")
        checked++
      }
    }
  }
  assert.equal(checked, grid.length * 10)
  // The person's own plate stays when their text holds on it
  assert.equal(readableColors({ text: "#1c2530", accent: "#ff7ab6", plate: "#f6f1e7" }, { plate: true }).plate, "#f6f1e7")
  // In a caption: the kit's colours on the look's plate, still over 4.5
  const node = { kind: "caption", words: [{ text: "Hello", at: 0, end: FLICKS, emphasis: false }], look: "boxed", style: {}, duration: FLICKS, type: { ...kitNode({ pair: "clean", colors: { text: "#777777" } }, []), colors: { text: "#777777" } } }
  const html = captionComposition(node, { output: { width: 1080, height: 1920 }, canvas: { width: 1080, height: 1920 } })
  const [, color] = /#t\{[^}]*;color:(#[0-9a-f]{6})/.exec(html)
  const [, bg] = /#t\{[^}]*background:(#[0-9a-f]{6})/.exec(html)
  assert.ok(contrastRatio(color, bg) >= CONTRAST, `${color} on ${bg}`)
})

/* ─────────────────────────────── looks, kit 2, packs ─────────────────────────────── */

test("ET-TY-06: fourteen caption looks, each data; the six keep their pages, the eight say how words arrive and are marked", () => {
  assert.equal(Object.keys(LOOKS).length, 6)
  assert.equal(Object.keys(ALL_LOOKS).length, 14)
  for (const [id, look] of Object.entries(MORE_CAPTION_LOOKS)) {
    assert.ok(!Object.hasOwn(LOOKS, id))
    assert.ok(Number.isInteger(look.words) && look.words >= 1 && look.words <= 5, id)
    assert.ok([1, 2].includes(look.lines) && ARRIVALS.includes(look.arrive) && MARKS.includes(look.mark) && ["color", "box", "underline", "size"].includes(look.emphasis) && ["bottom", "middle", "top"].includes(look.place), id)
    assert.ok(look.size >= 0.02 && look.size <= 0.1, id)
    assert.doesNotMatch(JSON.stringify(look), /https?:|\/Users\/|\bnpx?\b|model/)
    assert.deepEqual(pageLimits(id), { min: Math.min(2, look.words), max: look.words })
  }
  for (const id of Object.keys(LOOKS)) assert.deepEqual(pageLimits(id), { min: 2, max: 5 })
  assert.equal(placeOf("single"), "middle")
  assert.equal(placeOf("headline"), "top")
  assert.equal(placeOf("clean"), undefined)
  // One word a page means one word a page
  const run = index.words.slice(0, 7).map((w) => ({ id: w.id, text: w.text }))
  assert.ok(pages(run, pageLimits("single")).every((p) => p.length === 1))
  // Each word arrives on its own time; QG-10 reads the page once its last word is in
  const words = [{ text: "One", at: 0, end: FLICKS / 4, emphasis: false }, { text: "two", at: FLICKS / 4, end: FLICKS / 2, emphasis: true }, { text: "three", at: FLICKS / 2, end: FLICKS, emphasis: false }]
  for (const look of Object.keys(MORE_CAPTION_LOOKS)) {
    const node = { kind: "caption", words, look, style: {}, duration: FLICKS }
    const html = captionComposition(node, { output: { width: 1080, height: 1920 }, canvas: { width: 1080, height: 1920 } })
    assert.deepEqual(lintComposition(html), [])
    const animations = JSON.parse(/for \(const a of (\[.*?\])\) document/.exec(html)[1])
    assert.ok(["w0", "w1", "w2"].every((id) => animations.some((a) => a.id === id)), look)
    assert.equal(captionAtRest(node), 500 + 320)
  }
  assert.equal(captionAtRest({ words, look: "karaoke", style: {} }), null, "the six are read as before")
})

test("ET-TY-07: motion kit 2 places by region: thirds and corners clear faces and captions, a callout marks its point, a card covers like a scene", () => {
  const canvas = { width: 1080, height: 1920 }
  const face = { x: 300, y: 1200, w: 480, h: 500 }
  const third = { id: "g1", at: 0, end: 100, w: 900, h: 560, region: "third", faces: [face] }
  const caption = { id: "c1", at: 0, end: 100, w: 864, h: 230, faces: [face] }
  const { placements } = solveLayout([third, caption], { canvas, prefer: 70 })
  const box = placements.g1
  assert.ok(box.y + box.h <= face.y || box.y >= face.y + face.h, "clear of the face")
  assert.ok(placements.c1, "and the caption still has a place")
  const ov = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  assert.equal(ov(placements.g1, placements.c1), false)
  const corner = solveLayout([{ id: "h", at: 0, end: 1, w: 400, h: 120, region: "corner", corner: "bl", faces: [] }], { canvas, safe: { top: 100, left: 40, right: 60, bottom: 200 }, prefer: 70 }).placements.h
  assert.deepEqual(corner, { x: 40, y: 1920 - 200 - 120, w: 400, h: 120 })
  const point = solveLayout([{ id: "p", at: 0, end: 1, w: 280, h: 280, region: "point", point: { x: 540, y: 1450 }, faces: [face] }], { canvas, prefer: 70 }).placements.p
  assert.deepEqual(point, { x: 400, y: 1310, w: 280, h: 280 }, "a callout sits on its point, even over a face")
  // Through the solver: a card covers the frame (a caption under it moves to the scene's row), a screen frame takes the whole picture
  const graphic = (kind, extra = {}, word = "a1:w2") => ({ op: "add_motion", block: "graphic", version: 1, variables: cleanGraphic({ kind, text: "Start small", ...extra }, ALL_GRAPHIC_KINDS), at: { word, edge: "start" }, duration: 2 * FLICKS })
  const { project } = cut([graphic("card"), graphic("frame"), graphic("handle", { text: "@kriya" }, "a1:w12"), { op: "caption_style", look: "clean", words: ["a1:w2", "a1:w3"] }])
  const timeline = solve(project, index)
  const byKind = (kind) => timeline.overlays.find((o) => o.block?.variables?.kind === kind)
  assert.equal(REGIONS.card.region, "full")
  assert.ok(byKind("card").placement && byKind("card").placement.y > 0)
  assert.deepEqual(byKind("frame").placement, { x: 0, y: 0, w: project.canvas.width, h: project.canvas.height })
  assert.ok(byKind("handle").placement.w <= project.canvas.width / 2)
  assert.ok(timeline.captions[0].placement.y > byKind("card").placement.y + byKind("card").placement.h - 1, "the caption sits on the row under the card")
  // A list's steps are spoken words; a handle or call to action only typed ones
  const said = { spoken: "first we plan then we build then we ship", near: "first we plan", person: "add my handle @kriya" }
  assert.deepEqual(graphicProblems({ kind: "list", text: "plan", steps: ["we plan", "we build"] }, said), [])
  assert.ok(graphicProblems({ kind: "list", text: "plan", steps: ["we plan", "we sell"] }, said).length)
  assert.deepEqual(graphicProblems({ kind: "handle", text: "@kriya" }, said), [])
  assert.ok(graphicProblems({ kind: "handle", text: "we build" }, said).length, "spoken words aren't the person's handle")
  // Counting up ends on the number said, in its own grouping
  assert.equal(countSteps("₹1,23,456").at(-1), "₹1,23,456")
  assert.equal(countSteps("₹1,23,456")[5], "₹1,08,024")
  assert.equal(countSteps("about"), null)
  // Every kind and style draws with words escaped and nothing reaching out
  for (const [kind, shape] of Object.entries(ALL_GRAPHIC_KINDS)) {
    for (const style of shape.styles) {
      const variables = cleanGraphic({ kind, style, text: shape.number ? "48%" : "<b>Hi</b>", subtitle: "Founder", steps: ["one", "two", "three"], point: { x: 500, y: 900 } }, ALL_GRAPHIC_KINDS)
      assert.ok(variables, `${kind} ${style}`)
      const html = blockComposition({ blockId: "graphic", version: 1, variables, placement: { x: 100, y: 1200, w: 880, h: 300 }, duration: 3 * FLICKS }, { output: canvas, canvas })
      assert.deepEqual(lintComposition(html), [])
      assert.doesNotMatch(html, /<b>Hi/)
    }
  }
  assert.equal(Object.keys(KIT2_KINDS).length, 7)
  assert.deepEqual(LOWER_STYLES_2.length, 4)
  // Off, the kit's kinds aren't graphics at the boundary
  assert.equal(cleanGraphic({ kind: "card", text: "x" }), null)
})

test("ET-TY-08: style packs are data only, every id in Kriya's own tables; a pack fills only what the brief leaves open, and says what it can't", () => {
  assert.ok(Object.keys(STYLE_PACKS).length >= 10 && Object.keys(STYLE_PACKS).length <= 12)
  for (const [id, pack] of Object.entries(STYLE_PACKS)) {
    assert.match(id, /^[a-z0-9-]+$/)
    assert.deepEqual(Object.keys(pack).sort(), ["caption", "density", "does", "grade", "graphics", "label", "mood", "transition", "type"])
    assert.ok(Object.hasOwn(PAIRS, pack.type) && Object.hasOwn(ALL_LOOKS, pack.caption), id)
    assert.ok(Object.hasOwn(GRAPHIC_TONES, pack.graphics.tone) && Object.hasOwn(GRAPHIC_ACCENTS, pack.graphics.accent) && ALL_GRAPHIC_KINDS.lower.styles.includes(pack.graphics.lower), id)
    assert.ok(pack.transition === null || Object.hasOwn(TRANSITIONS, pack.transition), id)
    assert.ok(pack.grade === null || Object.hasOwn(GRADES, pack.grade), id)
    assert.ok(pack.mood === null || Object.hasOwn(ALL_MOODS, pack.mood), id)
    assert.ok(["none", "light", "full"].includes(pack.density))
    assert.doesNotMatch(JSON.stringify(pack), /https?:|\/Users\/|[$₹]|\bnpx?\b|\bcurl\b|model|claude|gpt/i)
  }
  const can = { moods: ALL_MOODS, grades: GRADES, transitions: TRANSITIONS, looks: ALL_LOOKS, motion: true }
  const filled = applyStylePack("bold-promo", { captions: "karaoke", graphics: [{ kind: "lower", style: "bar", text: "Asha", accent: "teal", tone: "light" }] }, can)
  assert.equal(filled.brief.captions, "karaoke", "the person's choice in the brief wins")
  assert.deepEqual([filled.brief.grade, filled.brief.transition, filled.brief.music, filled.brief.cutSound], ["vivid", "zoom", "generated:upbeat", "whoosh"])
  assert.deepEqual(filled.brief.graphics[0], { kind: "lower", style: "box", text: "Asha", accent: "yellow", tone: "dark" })
  assert.deepEqual(filled.kit, { pair: "bold", pack: "bold-promo" })
  const limited = applyStylePack("bold-promo", {}, { ...can, motion: false, moods: {} })
  assert.equal(limited.brief.transition, undefined)
  assert.equal(limited.brief.music, undefined)
  assert.equal(limited.notes.length, 2)
  assert.equal(applyStylePack("nope", {}, can), null)
})

/* ─────────────────────────────── licences ─────────────────────────────── */

test("ET-LIC-01: every shipped font is OFL-1.1, pinned by commit and hash, the pack this client knows, with its notice; OFL nowhere else", () => {
  const offered = MANIFEST.platforms["darwin-arm64"].packs[FONT_PACK].artifacts
  assert.deepEqual(manifestLicenceProblems(MANIFEST), [])
  assert.deepEqual(offered.map((a) => a.id).sort(), [...ALL_FONTS].sort())
  assert.deepEqual(PACKS[FONT_PACK].artifacts.sort(), [...ALL_FONTS].sort())
  for (const artifact of offered) {
    assert.equal(artifact.licence, "OFL-1.1")
    assert.match(artifact.url, /^https:\/\/raw\.githubusercontent\.com\/google\/fonts\/[0-9a-f]{40}\/ofl\//)
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/)
    assert.ok(FONT_LICENCES[artifact.id].startsWith("Copyright "))
  }
  assert.equal(licenceVerdict("OFL-1.1", "weight").why, "OFL-1.1: fonts only")
  const elsewhere = structuredClone(MANIFEST)
  elsewhere.platforms["darwin-arm64"].packs["pack-depth"] = { artifacts: [{ ...offered[0], id: "depth" }] }
  assert.deepEqual(manifestLicenceProblems(elsewhere).map((p) => p.item), ["darwin-arm64/pack-depth/depth"])
  assert.deepEqual(JSON.parse(readFileSync(join(ROOT, "scripts", "runtime-fonts.json"), "utf8")), Object.entries(FONT_LICENCES).map(([id, notice]) => ({ id, name: FONTS[id].family.replace(/^Kriya /, ""), notice })), "the notices script's list is this client's fonts")
  const notices = readFileSync(join(ROOT, "THIRD_PARTY_NOTICES.md"), "utf8")
  for (const [id, notice] of Object.entries(FONT_LICENCES)) assert.ok(notices.includes(`(\`${id}\`, OFL-1.1): ${notice}`), id)
  assert.match(notices, /SIL OPEN FONT LICENSE Version 1\.1/)
})

/* ─────────────────────────────── nothing chosen, nothing moves ─────────────────────────────── */

const F = FLICKS
const TILE_FRAMES = [[1080, 1920], [1920, 1080], [1080, 1080], [1080, 1350]]
const TILE_WORDS = [{ text: "We", at: 0, end: F / 4, emphasis: false }, { text: "shipped", at: F / 4, end: F / 2, emphasis: true }, { text: "Kriya", at: F / 2, end: (3 * F) / 4, emphasis: false }, { text: "in", at: (3 * F) / 4, end: F, emphasis: false }, { text: "March", at: F, end: (5 * F) / 4, emphasis: false }]

test("ET-TY-REG-01: with no kit chosen, every caption and graphic draws the document it drew before TP7, byte for byte (240 tiles)", () => {
  const golden = JSON.parse(readFileSync(join(ROOT, "tests", "edit", "pre-tp7-tiles.golden.json"), "utf8"))
  const now = {}
  for (const [width, height] of TILE_FRAMES) {
    const frame = { output: { width, height }, canvas: { width, height } }
    const placement = { x: Math.round(width * 0.1), y: Math.round(height * 0.7), w: Math.round(width * 0.8), h: Math.round(height * 0.12) }
    for (const look of Object.keys(LOOKS)) {
      for (const [name, style] of [["plain", {}], ["styled", { color: "#eeeeee", accent: "#ff7ab6", size: 0.05, scrim: true }], ["serif", { font: "serif", stroke: "none" }]]) {
        now[`${width}x${height}/caption/${look}/${name}`] = sha256(captionComposition({ kind: "caption", text: undefined, words: TILE_WORDS, look, style, placement, duration: (5 * F) / 4 }, frame))
        now[`${width}x${height}/caption/${look}/${name}/edited`] = sha256(captionComposition({ kind: "caption", text: "We shipped it in March", words: TILE_WORDS, look, style, placement, duration: (5 * F) / 4 }, frame))
      }
    }
    for (const [kind, shape] of Object.entries(GRAPHIC_KINDS)) {
      for (const st of shape.styles) {
        for (const tone of ["dark", "light"]) {
          const variables = { kind, style: st, text: shape.number ? "₹1,234" : "How we built it", ...(shape.subtitle ? { subtitle: "Founder" } : {}), accent: "yellow", tone, font: "sans" }
          now[`${width}x${height}/graphic/${kind}/${st}/${tone}`] = sha256(blockComposition({ blockId: "graphic", version: 1, variables, placement, duration: 3 * F }, frame))
        }
      }
    }
    for (const [blockId, variables] of [["title", { text: "Big news" }], ["lower-third", { text: "Asha Rao", subtitle: "Founder" }], ["card", { text: "Chapter one" }], ["term", { text: "Latency", quote: "The time a signal takes to travel.", source: "Wikipedia" }]]) {
      now[`${width}x${height}/block/${blockId}`] = sha256(blockComposition({ blockId, version: 1, variables, placement, duration: 3 * F }, frame))
    }
  }
  assert.equal(Object.keys(golden).length, 240)
  assert.deepEqual(now, golden)
})

test("ET-TY-REG-01, ET-TP-REG-01 (compile): no kit, no key: the plan is the same with or without the fonts, and a kit changes only its tiles", () => {
  const { project } = cut([{ op: "caption_style", look: "clean", words: ["a1:w2", "a1:w3"] }])
  const plain = compile(project, index, VERSIONS)
  assert.deepEqual(compile(project, index, { ...VERSIONS, fonts: ALL_FONTS }), plain, "the pack being here changes nothing a no-kit plan is made from")
  assert.equal(JSON.stringify(plain).includes('"type"'), false)
  assert.equal("brand" in plain, false)
  // Chosen, the caption's tile changes and its picture segments don't; a bar and a logo change every segment
  const kitted = apply(project, [{ op: "set_type_kit", pair: "bold" }], { index, author: "person" }).project
  const typed = compile(kitted, index, { ...VERSIONS, fonts: ALL_FONTS })
  assert.notEqual(typed.tiles[0].key, plain.tiles[0].key)
  assert.equal(typed.keys.picture, plain.keys.picture, "the picture is made from the same nodes; only the segment holding the tile re-renders (TP3)")
  assert.deepEqual(typed.segments.filter((s) => !s.node.tiles.length).map((s) => s.key), plain.segments.filter((s) => !s.node.tiles.length).map((s) => s.key))
  assert.equal(typed.tiles[0].node.type.shipped, true)
  const systemOnly = compile(kitted, index, VERSIONS)
  assert.equal(systemOnly.tiles[0].node.type.shipped, false)
  assert.ok(systemOnly.issues.some((i) => i.code === "fonts_missing"), "no pack: system fonts, with a note, never a failure")
  const branded = withImage(kitted)
  const barred = compile(apply(branded, [{ op: "set_type_kit", pair: "bold", bar: "progress", logo: "logo1" }], { index, author: "person" }).project, index, { ...VERSIONS, fonts: ALL_FONTS })
  assert.deepEqual(Object.keys(barred.brand).sort(), ["bar", "bug"])
  assert.ok(barred.segments.every((s, i) => s.node.brand.from === s.start && s.key !== typed.segments[i].key))
  const graph = segmentArgs(barred, barred.segments[0], { input: (id) => `/m/${id}`, tile: () => "/t.mov", output: "/o.mp4", encoder: [] })
  const chain = graph[graph.indexOf("-filter_complex") + 1]
  assert.match(chain, /\[bar\]overlay=x=-720\+720\*\(t\+0\.0+\)\/14\.0+:y=0:eval=frame/, "the bar fills on the cut's clock")
  assert.match(chain, /scale=w=\d+:h=\d+:force_original_aspect_ratio=decrease,format=rgba\[bug\]/)
  assert.ok(graph.includes("/m/logo1"))
  // Off-path schemas and prompts: the objects they were
  assert.equal(typeKitSchema(consoleSchema(true), false), consoleSchema(true))
  assert.ok(typeKitSchema(consoleSchema(true), true).properties.ops.items.properties.kind.enum.includes("card"))
  assert.ok(GRAPHICS_SCHEMA.properties.graphics.items.properties.kind.enum.every((kind) => Object.hasOwn(GRAPHIC_KINDS, kind)))
  assert.ok(GRAPHICS_SCHEMA_2.properties.graphics.items.properties.kind.enum.includes("list"))
})

test("ET-TP-REG-02 for TP7: a project with a kit serialises and replays; one without has no new key on opening", () => {
  const { project } = cut()
  assert.equal("type" in project.look.brand, false)
  const kitted = apply(withImage(project), [{ op: "set_type_kit", pair: "modern", bar: "chapters" }], { index, author: "person" })
  assert.deepEqual(kitted.diagnostics, [])
  assert.deepEqual(JSON.parse(JSON.stringify(kitted.project)).look.brand.type, { pair: "modern", bar: "chapters" })
})

test("ET-TY-REG-02: the previous client release reads the manifest that carries the font pack, installs its core, and then the pack", async () => {
  // The previous release's manifest.js is this one: TP7 changed neither it nor setup.js
  assert.equal(readFileSync(join(ROOT, "src", "edit", "runtime", "manifest.js"), "utf8"), readFileSync(join(ROOT, "tests", "edit", "manifest-pre-tp7.js"), "utf8"))
  assert.equal(sha256(readFileSync(join(ROOT, "src", "edit", "runtime", "setup.js"))), "48802a51b9e86aa39efdd0b4ffbdc193b9105c38a497bdc28629ef3119a6c9c3", "setup.js as released before TP7")
  const keys = generateKeyPairSync("ed25519")
  const trusted = [keys.publicKey.export({ type: "spki", format: "der" }).toString("base64")]
  const signed = (data) => {
    const text = JSON.stringify(data)
    return { manifest: text, signature: sign(null, Buffer.from(text), keys.privateKey).toString("base64") }
  }
  // The real 2026.11.1, signed by a key made for this test (EB-09: the owner signs it offline)
  const before = openBefore(signed(MANIFEST), trusted)
  assert.equal(before.data.platforms["darwin-arm64"].packs[FONT_PACK].artifacts.length, 14)
  assert.deepEqual(openManifest(signed(MANIFEST), trusted).data, before.data)
  // Its shape, served on this computer: the core installs as it did, the packs untouched; then the font pack
  const files = {}
  const local = structuredClone(MANIFEST)
  const server = createServer((req, res) => (files[req.url] ? res.end(files[req.url]) : res.writeHead(404).end()))
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  const url = `http://127.0.0.1:${server.address().port}`
  try {
    const mac = local.platforms["darwin-arm64"]
    for (const artifact of [...mac.artifacts, ...mac.packs[FONT_PACK].artifacts]) {
      const data = Buffer.from(`bytes of ${artifact.id}`)
      files[`/${artifact.id}`] = data
      Object.assign(artifact, { url: `${url}/${artifact.id}`, sha256: sha256(data), bytes: data.length, unpack: "none", entry: artifact.entry ?? "file.bin" })
    }
    mac.artifacts = mac.artifacts.map((a) => ({ ...a, entry: "chrome.bin" }))
    const home = freshHome()
    const run = async (command, args) => {
      if (command === "uv" && args[0] === "--version") return "uv 0.13.1"
      if (command === "uv" && args[0] === "venv") {
        mkdirSync(join(args.at(-1), "bin"), { recursive: true })
        writeFileSync(join(args.at(-1), "bin", "python"), "")
      }
      return ""
    }
    const opened = openBefore(signed(local), trusted)
    await install(opened, { home, platform: "darwin-arm64", run, free: () => 1e12 })
    const runtime = activeRuntime(home)
    assert.equal(runtime.version, "2026.11.1")
    assert.equal(existsSync(join(runtime.dir, "packs")), false, "the core install leaves the packs alone")
    assert.equal(packStatus({ runtime, capabilities: { filters: new Set(["lut3d"]) }, platform: "darwin-arm64" })[FONT_PACK].missing, "The Fonts pack isn't installed. Run kriya edit setup --pack fonts.")
    await installPack(opened, FONT_PACK, { home, platform: "darwin-arm64", free: () => 1e12 })
    assert.deepEqual([...installedFonts(activeRuntime(home), "darwin-arm64").keys()].sort(), [...ALL_FONTS].sort())
  } finally {
    await new Promise((done) => server.close(done))
  }
})

/* ─────────────────────────────── the switch, on the Host ─────────────────────────────── */

test("editing.typeKit off: the Host takes no kit, look or kind of TP7 and the make drops the pack; on, it takes them", async () => {
  const { spawn } = await import("node:child_process")
  const { ensureHost, stopHost } = await import("../src/edit/host/client.js")
  const { hostHeaders, socketPath } = await import("../src/edit/host/paths.js")
  const { startFakeKriya } = await import("./fake-kriya.js")
  for (const typeKit of [false, true]) {
    const fake = await startFakeKriya({ features: { visuals: false, playbooks: false, mediaSearch: false, motion: true, customMotion: false, assembly: false, livePreview: false, intent: false, craft: false, typeKit } })
    const home = realpathSync(mkdtempSync(join(tmpdir(), "kh-")))
    try {
      const login = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "login", "--url", fake.url, "--no-browser"], { env: { ...process.env, KRIYA_HOME: home }, stdio: "ignore" })
      assert.equal(await new Promise((done) => login.on("exit", done)), 0)
      const bin = join(home, "bin")
      const folder = join(home, "work", "film")
      mkdirSync(folder, { recursive: true })
      mkdirSync(bin)
      writeFileSync(join(bin, "ffmpeg"), `#!/bin/sh\ncase "$*" in\n*-filters*) echo " .S. noise V->V x";;\n*-encoders*) echo " V....D libx264 x";;\n*-version*) echo "ffmpeg version 9.0.2";;\n*) exit 1;;\nesac\n`)
      writeFileSync(join(bin, "ffprobe"), `#!/bin/sh\necho '{"streams":[{"index":0,"codec_type":"video","width":640,"height":360,"r_frame_rate":"30/1","avg_frame_rate":"30/1","duration_ts":90,"time_base":"1/30","color_primaries":"bt709","color_transfer":"bt709","color_space":"bt709","color_range":"tv"}],"format":{"format_name":"mov","duration":"3.0"}}'\n`)
      for (const tool of ["ffmpeg", "ffprobe"]) chmodSync(join(bin, tool), 0o755)
      const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: join(home, "work"), KRIYA_EDIT_IDLE_MS: "60000", PATH: `${bin}:${process.env.PATH}` }
      await ensureHost({ env, home })
      const call = (method, path, body) =>
        new Promise((done, fail) => {
          const req = request({ socketPath: socketPath(home), method, path, headers: { ...hostHeaders(home), "content-type": "application/json" } }, (res) => {
            const chunks = []
            res.on("data", (chunk) => chunks.push(chunk))
            res.on("end", () => done({ ...JSON.parse(Buffer.concat(chunks).toString() || "{}"), status: res.statusCode }))
          })
          req.on("error", fail)
          req.end(body === undefined ? undefined : JSON.stringify(body))
        })
      const { id } = await call("POST", "/projects", { name: "Film", folder })
      writeFileSync(join(folder, "take.mov"), "take")
      const asset = await call("POST", `/projects/${id}/assets`, { path: join(folder, "take.mov") })
      const opened = await call("GET", `/projects/${id}`)
      assert.equal("typeKit" in opened, typeKit, "the project view offers the kit only with the switch on")
      if (typeKit) assert.deepEqual([Object.keys(opened.typeKit.packs).length, Object.keys(opened.typeKit.pairs).length, opened.typeKit.looks.length, opened.typeKit.shipped], [12, 6, 8, false])
      const kit = await call("PATCH", `/projects/${id}`, { ops: [{ op: "set_type_kit", pair: "story" }] })
      const card = await call("PATCH", `/projects/${id}`, { ops: [{ op: "keep_range", asset: asset.id, from: 0, to: 2 * FLICKS }, { op: "add_motion", block: "graphic", version: 1, variables: { kind: "card", style: "title", text: "Hello", accent: "teal", tone: "dark", font: "sans" }, at: 0, duration: FLICKS }] })
      if (typeKit) {
        assert.deepEqual([kit.status, kit.project.look.brand.type], [200, { pair: "story" }])
        assert.equal(card.status, 200)
      } else {
        assert.deepEqual([kit.status, kit.diagnostics[0].code, "type" in kit.project.look.brand], [422, "switched_off", false])
        assert.deepEqual([card.status, card.diagnostics[0].code], [422, "switched_off"])
      }
      // The make: a style pack and a TP7 look reach the job only with the switch on
      const job = await call("POST", `/projects/${id}/make`, { brief: { stylePack: "bold-promo", captions: "single", typeKit: { pair: "hand" } } })
      assert.equal(job.status, 200)
      const db = new DatabaseSync(join(home, "edit", id, "journal.sqlite"), { readOnly: true })
      const recorded = JSON.parse(db.prepare("select request from jobs where kind = 'make' order by id desc limit 1").get().request).brief
      db.close()
      if (typeKit) assert.deepEqual([recorded.captions, recorded.grade, recorded.typeKit], ["single", "vivid", { pair: "hand", pack: "bold-promo" }])
      else assert.deepEqual([recorded.captions, recorded.typeKit, recorded.stylePack, recorded.grade], [undefined, undefined, undefined, undefined])
    } finally {
      await stopHost(home)
      await fake.close()
    }
  }
})
