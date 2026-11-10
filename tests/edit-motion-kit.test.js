import assert from "node:assert/strict"
import { test } from "node:test"

import { apply } from "../src/edit/core/ops.js"
import { solve } from "../src/edit/core/solver.js"
import { planDiff } from "../src/edit/director/continuity.js"
import { arrangeGraphics, brandIn, graphicsIn, planGraphics } from "../src/edit/director/graphics.js"
import { briefOf, planCut } from "../src/edit/director/plan.js"
import { consoleSchema, describe, expandGraphics, OPS_SCHEMA, revise } from "../src/edit/director/revise.js"
import { cleanGraphic, GRAPHIC_ACCENTS, GRAPHIC_KINDS, GRAPHIC_TONES, graphicLength } from "../src/edit/engine/graphics.js"
import { blockComposition, lintComposition } from "../src/edit/engine/motion.js"
import { contrast, luminance } from "../src/edit/gates/text.js"
import { isPlanGraphic } from "../src/edit/recipes/graphic-clips.js"
import { planReel } from "../src/edit/recipes/reel.js"
import { makeProject } from "./edit/fixture.js"
import { indexOf, lengthOf } from "./edit/script.js"

// The motion kit (MOTION_GRAPHICS.md, EDD-58): drawn by code, words held to the speaker's and
// the person's own, planned by the Director, added in chat, and off unless the server says on.

const FLICKS = 705_600_000
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))

function talk() {
  const index = indexOf()
  const facts = { width: 1080, height: 1920, hasAudio: true, duration: Math.round(lengthOf() * FLICKS), vfr: false, fps: { n: 30, d: 1 }, color: { primaries: "bt709", transfer: "bt709", range: "tv", tagged: true, hdr: false } }
  const base = apply(makeProject(), [], { author: "code" }).project
  const project = apply({ ...base, assets: [{ id: "a1", kind: "video", fingerprint: "f", path: "take.mov", linked: true, rights: "own", facts }] }, [{ op: "keep_range", asset: "a1", from: 0, to: facts.duration }], { author: "person", index }).project
  return { index, project }
}
const wordOf = (index, text) => index.words.find((w) => w.text === text && !w.flags.length).id
const never = async ({ task }) => assert.fail(`asked the model for ${task}`)
const defaults = async ({ fallback }) => ({ value: fallback(), source: "default", calls: 0 })
const graphicsOf = (project) => project.sequences[0].clips.flatMap((c) => c.effects.filter((e) => e.type === "block" && e.blockId === "graphic").map((e) => ({ clip: c.id, ...e.variables })))

test("ET-MG-01: every kind and style draws a tile that passes the lint a model's code must pass", () => {
  const canvas = { width: 1080, height: 1920 }
  for (const [kind, shape] of Object.entries(GRAPHIC_KINDS)) {
    for (const style of shape.styles) {
      const html = blockComposition({ blockId: "graphic", version: 1, variables: { kind, style, text: shape.number ? "50,000" : "Start small ship fast", subtitle: "our users" }, duration: 3 * FLICKS }, { output: canvas, canvas })
      assert.deepEqual(lintComposition(html), [], `${kind}/${style}`)
      assert.match(html, /data-text/)
      assert.equal(html.includes("our users"), shape.subtitle, `${kind}: a second line only where the kind has one`)
    }
  }
  assert.throws(() => blockComposition({ blockId: "graphic", version: 2, variables: { kind: "title", text: "Hi" }, duration: FLICKS }, { output: canvas, canvas }), /no motion block/i)
  assert.throws(() => blockComposition({ blockId: "graphic", version: 1, variables: { kind: "sparkle", text: "Hi" }, duration: FLICKS }, { output: canvas, canvas }), /don't describe a graphic/)
})

test("ET-MG-02: the brand kit keeps text readable: ink on each plate, and the chip's ink on each colour, hold 4.5:1", () => {
  for (const [name, tone] of Object.entries(GRAPHIC_TONES)) assert.ok(contrast(luminance(rgb(tone.ink)), luminance(rgb(tone.plate))) >= 4.5, `${name} ink on plate`)
  for (const [name, accent] of Object.entries(GRAPHIC_ACCENTS)) assert.ok(contrast(luminance(rgb(GRAPHIC_TONES.dark.chip)), luminance(rgb(accent))) >= 4.5, `chip ink on ${name}`)
})

test("ET-MG-03: a graphic is cleaned at the boundary: unknown kinds and fields go, markup can't get in, a stat is digits", () => {
  assert.equal(cleanGraphic({ kind: "sparkle", text: "Hi" }), null)
  assert.equal(cleanGraphic({ kind: "title", text: "  " }), null)
  assert.equal(cleanGraphic({ kind: "stat", text: "lots" }), null)
  assert.deepEqual(cleanGraphic({ kind: "stat", text: "50%", subtitle: "growth", url: "https://x", accent: "#ff0000", font: "Comic Sans" }), { kind: "stat", style: "pop", text: "50%", subtitle: "growth", accent: "teal", tone: "dark", font: "sans" })
  const cleaned = cleanGraphic({ kind: "title", style: "words", text: `<img src=x onerror=alert(1)> ${"long ".repeat(30)}`, subtitle: "dropped: a title has one line" })
  assert.ok(!/[<>]/.test(cleaned.text) && cleaned.text.length <= 48)
  assert.equal(cleaned.subtitle, undefined)
  const html = blockComposition({ blockId: "graphic", version: 1, variables: { kind: "title", text: `"quoted" & 'it'` }, duration: FLICKS }, { output: { width: 1080, height: 1080 }, canvas: { width: 1080, height: 1080 } })
  assert.match(html, /&quot;quoted&quot; &amp; &#39;it&#39;/)
  assert.ok(graphicLength(cleanGraphic({ kind: "title", text: "Hi" })) >= 1.8 * FLICKS && graphicLength(cleanGraphic({ kind: "quote", text: "x".repeat(48) })) <= 5 * FLICKS)
})

test("ET-MG-04: words on a graphic are the speaker's or the person's own; a number is one that was said", () => {
  const { index } = talk()
  const at = wordOf(index, "fifty")
  const ctx = { index, asset: "a1", person: "add a name strap: Ravi Kumar, Founder. End with Follow for more" }
  const tried = arrangeGraphics(
    [
      { kind: "title", text: "ship fast", at: wordOf(index, "ship") },
      { kind: "title", text: "Guaranteed results", at },
      { kind: "stat", text: "50000", subtitle: "rupees", at },
      { kind: "stat", text: "90%", subtitle: "users", at: wordOf(index, "users") },
      { kind: "lower", text: "Ravi Kumar", subtitle: "Founder", at: index.words[2].id },
      { kind: "lower", text: "Ravi Kumar", at: index.words[30].id },
      { kind: "end", text: "Follow for more" },
      { kind: "intro", text: "How we built this" },
      { kind: "title", text: "the design", at: "a1:w999999" },
    ],
    ctx,
  )
  assert.deepEqual(tried.graphics.map((g) => g.kind), ["intro", "lower", "stat", "title", "end"])
  assert.equal(tried.graphics[0].at, undefined, "code places the opening title")
  assert.equal(tried.graphics.at(-1).at, undefined, "and the end card")
  const why = Object.fromEntries(tried.dropped.map((d) => [d.graphic.text, d.reason]))
  assert.match(why["Guaranteed results"], /isn't in the speaker's words/)
  assert.match(why["90%"], /isn't said/)
  assert.match(why["Ravi Kumar"], /already a name strap/)
  assert.match(why["the design"], /isn't on a word/)
  // Under an animated scene, or on a stretch the person trimmed, there's nothing to put it on
  const scene = { from: index.sentences[7].firstWord, to: index.sentences[7].lastWord }
  assert.match(arrangeGraphics([{ kind: "title", text: "our users", at: index.sentences[7].firstWord }], { ...ctx, scenes: [scene] }).dropped[0].reason, /animated scene/)
  const word = index.words.find((w) => w.id === wordOf(index, "ship"))
  assert.match(arrangeGraphics([{ kind: "title", text: "ship fast", at: word.id }], { ...ctx, cuts: [{ from: word.start / FLICKS - 1, to: word.end / FLICKS + 1 }] }).dropped[0].reason, /isn't on a word/)
})

test("ET-MG-05: the person's words decide: no graphics means none and no call; a revision keeps and restyles them", async () => {
  const { index } = talk()
  assert.equal(graphicsIn("no graphics please"), "off")
  assert.equal(graphicsIn("add a lower third with my name"), "on")
  assert.equal(graphicsIn("make it warmer"), null)
  assert.deepEqual(brandIn("use a yellow accent and a serif font for the titles, light plates"), { accent: "yellow", tone: "light", font: "serif" })
  assert.deepEqual(await planGraphics({ ask: never, index, asset: "a1", text: "edit this, no graphics" }), { graphics: [], source: "person", dropped: [] })
  const asked = []
  const ask = async ({ task, schema, request }) => {
    asked.push({ task, request })
    assert.equal(schema.properties.graphics.items.additionalProperties, false)
    return { value: { graphics: [{ kind: "title", style: "slam", text: "start small", at: wordOf(index, "small.") }, { kind: "title", text: "Invented claim", at: wordOf(index, "week.") }] }, source: "model", calls: 1 }
  }
  const first = await planGraphics({ ask, index, asset: "a1", text: "edit this with motion graphics" })
  assert.deepEqual(first.graphics.map((g) => [g.kind, g.style, g.text]), [["title", "slam", "start small"]])
  assert.match(asked[0].request, /never write a title, name, handle or claim of your own/i)
  const previous = { settings: { graphics: first.graphics } }
  const kept = await planGraphics({ ask: never, index, asset: "a1", text: "make the music calmer", previous })
  assert.deepEqual([kept.source, kept.graphics], ["kept", first.graphics])
  const restyled = await planGraphics({ ask: never, index, asset: "a1", text: "pink accent colour, and a mono font for the text", previous })
  assert.deepEqual([restyled.graphics[0].accent, restyled.graphics[0].font, restyled.graphics[0].text], ["pink", "mono", "start small"])
})

test("ET-MG-06: a plan carries its graphics to the brief; the recipe anchors them to their words, and a remake replaces its own, never a chat one", async () => {
  const { index, project } = talk()
  const ask = async ({ task, fallback }) => (task === "graphics" ? { value: { graphics: [{ kind: "intro", text: "How we built this" }, { kind: "stat", text: "50000", subtitle: "rupees", at: wordOf(index, "fifty") }, { kind: "end", text: "start small" }] }, source: "model", calls: 1 } : { value: fallback(), source: "default", calls: 0 })
  const plan = await planCut({ ask, project, index, text: "edit this with motion graphics", motion: true })
  assert.deepEqual(plan.settings.graphics.map((g) => g.kind), ["intro", "stat", "end"])
  assert.match(plan.steps[0], /^Add 3 motion graphics: Opening title "How we built this"/)
  const brief = briefOf(plan.settings)
  assert.equal(brief.graphics.length, 3)
  assert.deepEqual(planDiff({}, brief).filter((line) => /graphics/.test(line)), ["Motion graphics: none → 3 graphics"])

  const first = await planReel({ project, index, asset: "a1", ask: defaults, brief })
  const made = first.ops.filter((op) => op.op === "add_motion" && op.block === "graphic")
  assert.deepEqual(made.map((op) => [op.variables.kind, op.variables.plan]), [["intro", true], ["stat", true], ["end", true]])
  assert.equal(made[1].at.word, wordOf(index, "fifty"), "on the word it was planned on")
  const timeline = solve(first.project, index)
  const tiles = timeline.overlays.filter((o) => o.block?.blockId === "graphic")
  assert.equal(tiles.length, 3)
  assert.ok(tiles.every((o) => o.placement), "each has a place clear of the face and the captions")
  assert.ok(tiles[0].at - timeline.picture[0].at < FLICKS / 2, "the opening title starts with the first word")
  assert.ok(timeline.duration - tiles.at(-1).end < FLICKS / 2, "the end card ends it")
  for (const [i, a] of tiles.entries()) for (const b of tiles.slice(i + 1)) assert.ok(a.end <= b.at, "no two on screen at once")

  // The person adds one in chat; then a remake with one graphic fewer
  const chat = apply(first.project, [{ op: "add_motion", block: "graphic", version: 1, variables: cleanGraphic({ kind: "title", text: "the design" }), at: { word: wordOf(index, "design."), edge: "start" }, duration: 2 * FLICKS }], { index, author: "agent" })
  assert.ok(chat.applied, JSON.stringify(chat.diagnostics))
  const second = await planReel({ project: chat.project, index, asset: "a1", ask: defaults, brief: { ...brief, graphics: brief.graphics.slice(0, 2), story: first.story } })
  assert.deepEqual(graphicsOf(second.project).map((g) => [g.kind, !!g.plan]).sort(), [["intro", true], ["stat", true], ["title", false]])
  assert.ok(second.project.sequences[0].clips.filter((c) => c.effects.some(isPlanGraphic)).length === 2)
})

test("ET-MG-07: a graphic whose line isn't in the cut, or that would land on a scene, is left out and said so", async () => {
  const { index, project } = talk()
  const graphics = [{ kind: "title", text: "the design", at: wordOf(index, "design.") }, { kind: "title", text: "our users", at: "a1:w57" }]
  const made = await planReel({ project, index, asset: "a1", ask: async ({ task, fallback }) => (task === "story" ? { value: { hook: null, drop: ["a1:s6"] }, source: "model", calls: 1 } : { value: fallback(), source: "default", calls: 0 }), brief: { graphics } })
  assert.deepEqual(graphicsOf(made.project).map((g) => g.text), ["our users"])
  assert.ok(made.notes.some((n) => /^Left out the Title "the design": its line isn't in this cut\.$/.test(n)), made.notes.join(" | "))
})

test("ET-MG-08: chat adds a kit graphic with the person's own words, described by code; an invented one is refused", async () => {
  const { index, project } = talk()
  const at = { word: index.words[2].id, edge: "start" }
  const person = "add a name strap that says Ravi Kumar, Founder"
  const good = expandGraphics([{ op: "add_graphic", kind: "lower", text: "Ravi Kumar", subtitle: "Founder", at }], { index, person })
  assert.deepEqual(good.problems, [])
  assert.deepEqual([good.ops[0].op, good.ops[0].block, good.ops[0].variables.text, good.ops[0].duration], ["add_motion", "graphic", "Ravi Kumar", 4 * FLICKS])
  assert.match(expandGraphics([{ op: "add_graphic", kind: "title", text: "Best product ever", at }], { index, person }).problems[0], /speaker's or the person's own/)
  assert.match(expandGraphics([{ op: "add_graphic", kind: "title", text: "Ravi Kumar" }], { index, person }).problems[0], /needs `at`/)
  assert.match(expandGraphics([{ op: "add_graphic", kind: "stat", text: "many", at }], { index, person }).problems[0], /isn't a graphic the kit draws/)

  const seen = []
  const ask = async ({ schema, request, check }) => {
    seen.push({ schema, request })
    const value = { ops: [{ op: "add_graphic", kind: "lower", text: "Ravi Kumar", subtitle: "Founder", at }], say: "Added your name." }
    assert.deepEqual(check(value), [])
    return { value, source: "model", calls: 1 }
  }
  const result = await revise({ ask, project, index, text: person, motion: true })
  assert.deepEqual(result.changes, [`Added a name strap "Ravi Kumar", "Founder" at "${index.words[2].text}"`])
  assert.deepEqual(graphicsOf(result.project).map((g) => [g.kind, g.text, !!g.plan]), [["lower", "Ravi Kumar", false]])
  assert.match(seen[0].request, /add_graphic/)
  assert.equal(describe({ op: "add_motion", block: "graphic", variables: { kind: "end", text: "Follow" }, at: 0 }, index), 'Added an end card "Follow" at 0.00 s')
})

test("ET-MG-REG-01: with editing.motion off the plan, the console and a make are what they were", async () => {
  const { index, project } = talk()
  const tasks = []
  const ask = async ({ task, schema, request, fallback }) => {
    tasks.push({ task, schema, request })
    return { value: fallback(), source: "default", calls: 0 }
  }
  const plan = await planCut({ ask, project, index, text: "edit this with motion graphics and a lower third" })
  assert.ok(!tasks.some((t) => t.task === "graphics"), "no extra model call")
  assert.equal(plan.settings.graphics, undefined)
  assert.equal(briefOf(plan.settings).graphics, undefined)
  assert.equal(consoleSchema(false), OPS_SCHEMA, "the same schema object")
  await revise({ ask, project, index, text: "add a title" })
  const consoleAsk = tasks.find((t) => t.task === "console")
  assert.equal(consoleAsk.schema, OPS_SCHEMA)
  assert.doesNotMatch(consoleAsk.request, /add_graphic/)
  // A brief with no graphics makes no graphic, and the recipe's operations are the same list
  const off = await planReel({ project, index, asset: "a1", ask: never.bind(null), brief: { story: { hook: null, drop: [], emphasis: { most: 3, ids: [] } }, punches: 3 } })
  assert.equal(graphicsOf(off.project).length, 0)
})
