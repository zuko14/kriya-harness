import assert from "node:assert/strict"
import { test } from "node:test"

import { apply } from "../src/edit/core/ops.js"
import { compile } from "../src/edit/core/plan.js"
import { newProject } from "../src/edit/core/project.js"
import { createAsk } from "../src/edit/director/ask.js"
import { MOTION_TIER, motionLength, motionProblems, nearestKit, writeMotion } from "../src/edit/director/custom-motion.js"
import { consoleSchema, describe, pointingSchema, revise } from "../src/edit/director/revise.js"
import { CUSTOM_BLOCK, CUSTOM_VERSION, cssProblem, customVariables, parseBody, partsProblems } from "../src/edit/engine/custom.js"
import { customComposition, customDocument, lintComposition } from "../src/edit/engine/motion.js"
import { intendedText } from "../src/edit/gates/copy.js"
import { judgeTileText } from "../src/edit/gates/tile.js"
import { createGovernor } from "../src/edit/loop/governor.js"
import { indexOf, lengthOf, wordId } from "./edit/script.js"

// TP9 (CRAFT_UPGRADE §7, DIRECTOR_AND_AGENT §11, TOP_TIER_PLAN §4 TP9): MG2, a custom animation a model
// designs as data. ET-MG2-01 the switches and the tier rule (EH-65); -02 the structure and the lint, CSP
// first; -03 every word in a slot, grounded and escaped (ET-SEC-02); -04 two calls at most, then the
// nearest kit graphic; -05 a stored block is drawn only while the switch is on. No model, no media: the
// gateway is a script. The confined render and the gates on real tiles: tests/edit/media/custom-motion-pointing.test.js.

const F = 705_600_000
const FRAME = { output: { width: 1080, height: 1920 }, canvas: { width: 1080, height: 1920 } }
const CONFINED = { kind: "sandbox-exec" }
export const GOOD = {
  name: "Spinning badge",
  css: "#badge{position:absolute;left:390px;top:420px;width:300px;height:300px}#plate{position:absolute;left:160px;top:820px;width:760px;box-sizing:border-box;padding:16px 28px;background:#13292b;border-radius:16px;text-align:center}#line{display:block;color:#f2eadf;font:800 64px/1.2 Helvetica,Arial,sans-serif;background:#13292b}",
  body: '<svg id="badge" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="none" stroke="#ffb347" stroke-width="8"/><path d="M50 10 L50 30" stroke="#ffb347" stroke-width="8"/></svg><div id="plate"><span id="line" data-slot="0"></span></div>',
  animations: [
    { id: "badge", keyframes: [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], options: { duration: 2000, iterations: 2, easing: "linear", fill: "both" } },
    { id: "plate", keyframes: [{ opacity: 0, transform: "translateY(40px)" }, { opacity: 1, transform: "translateY(0px)" }], options: { duration: 600, fill: "both" } },
  ],
  texts: ["We built the whole thing"],
}
const node = (variables = customVariables(GOOD)) => ({ blockId: CUSTOM_BLOCK, version: CUSTOM_VERSION, variables, duration: 4 * F })
const index = indexOf("a1")
const spoken = index.words.map((w) => w.text).join(" ")

test("ET-MG2-02: a design passes only as allow-listed parts; each kind of escape is refused with its reason", () => {
  assert.deepEqual(partsProblems(GOOD).problems, [])
  const refused = (change) => partsProblems({ ...GOOD, ...change }).problems
  const body = (html) => refused({ body: html })
  const cases = [
    [body('<script>fetch("//x")</script>'), /<script> isn't allowed/],
    [body('<div id="a" onload="x()"></div>'), /onload isn't allowed/],
    [body('<div id="a" style="color:red"></div>'), /style isn't allowed/],
    [body('<svg id="a"><a href="x"></a></svg>'), /<a> isn't allowed/],
    [body('<iframe id="a"></iframe>'), /<iframe> isn't allowed/],
    [body('<img id="a"/>'), /<img> isn't allowed/],
    [body('<div id="a">Buy now</div>'), /has text in it/],
    [body('<div id="a" class="x" data-slot="0">smuggled</div>'), /slot 0 must be empty/],
    [body('<div id="mg"></div>'), /the id "mg" isn't allowed/],
    [body('<div id="a"></div><div id="a"></div>'), /used twice/],
    [body('<div id="a">'), /never closed/],
    [body("<div id=a></div>"), /stray </],
    [body('<path id="a" d="M0 0" fill="url(#g)"/>'), /characters that aren't allowed/],
    [body('<path id="a" transform="javascript:alert(1)"/>'), /characters that aren't allowed/],
    [refused({ css: "#plate{background:url(//evil.example/x.png)}" }), /from outside/],
    [refused({ css: "@import 'x.css';" }), /only at-rule/],
    [refused({ css: "@font-face{font-family:x}" }), /only at-rule/],
    [refused({ css: "#plate{color:red} /* hi */" }), /comment/],
    [refused({ css: "#plate{color:\\72 ed}" }), /backslash/],
    [refused({ css: '#plate::after{content:"Subscribe!"}' }), /empty `content/],
    [refused({ css: "body{background:red}" }), /names "body"/],
    [refused({ css: "#stage{display:none}" }), /Kriya's own/],
    [refused({ css: "#plate{position:fixed}" }), /fixed/],
    [refused({ css: "#plate:hover{color:red}" }), /pseudo-class/],
    [refused({ css: "#plate{color:red}é" }), /ASCII/],
    [refused({ animations: [{ id: "badge", keyframes: [{ opacity: 0 }], options: { duration: 1000, iterations: Infinity } }] }), /iterations/],
    [refused({ animations: [{ id: "badge", keyframes: [{ backgroundImage: "x" }], options: { duration: 1000 } }] }), /backgroundImage isn't allowed/],
    [refused({ animations: [{ id: "badge", keyframes: [{ filter: "url(#x)" }], options: { duration: 1000 } }] }), /characters that aren't allowed/],
    [refused({ animations: [{ id: "nope", keyframes: [{ opacity: 0 }], options: { duration: 1000 } }] }), /id the body doesn't have/],
    [refused({ animations: [{ id: "badge", keyframes: [{ opacity: 0 }], options: {} }] }), /needs a duration/],
    [refused({ texts: ["We built", "extra"] }), /text 1 has no/],
    [refused({ texts: [] }), /slot 0 has no text/],
  ]
  for (const [problems, why] of cases) assert.ok(problems.some((p) => why.test(p)), `${why} in ${JSON.stringify(problems)}`)
  // The CSS prelude check reads selectors only: a property's word like font-style isn't a selector
  assert.equal(cssProblem("#line{font-style:italic;font-weight:800}@keyframes pop{from{opacity:0}50%{opacity:.5}to{opacity:1}}#plate svg>circle:nth-child(1){opacity:.5}"), null)
  // What is stored is the canonical form, slots empty, and it parses again to the same thing (a project is read back)
  const stored = customVariables(GOOD)
  assert.equal(parseBody(stored.body).stored, stored.body)
  assert.doesNotMatch(stored.body, /data-text|⟦/)
})

test("ET-SEC-04 (the new caller): Kriya's CSP first, the whole document linted, switch off and an unconfined OS refuse everything", () => {
  const html = customDocument(node(), FRAME, { allowed: true, which: CONFINED })
  const head = html.indexOf("<head>") + "<head>".length
  assert.ok(html.slice(head).startsWith('<meta charset="utf-8"><meta http-equiv="Content-Security-Policy"') || html.slice(head).startsWith('<meta http-equiv="Content-Security-Policy"'), "Kriya's policy is the first thing in <head>")
  assert.match(html, /default-src 'none'.*connect-src 'none'/)
  assert.deepEqual(lintComposition(html.replace(/We built the whole thing/, "")), [])
  assert.match(html, /transform:scale\(1\.000000,1\.000000\)/)
  // No script of the model's: the only script is Kriya's, applying the animations as data
  assert.equal((html.match(/<script>/g) ?? []).length, 1)
  assert.throws(() => customDocument(node(), FRAME, { allowed: false, which: CONFINED }), (e) => e.reason === "custom_motion_off")
  assert.throws(() => customDocument(node(), FRAME, { allowed: true, which: { kind: null, missing: "no sandbox here" } }), (e) => e.reason === "no_confinement")
  // A project edited by hand is checked again before every render
  assert.throws(() => customDocument(node({ ...customVariables(GOOD), body: '<div id="a" onclick="x()"></div>' }), FRAME, { allowed: true, which: CONFINED }), (e) => e.reason === "bad_composition")
  // The lint refuses what slipped past nothing else: network, clock, randomness and GSAP in a model's text
  for (const bad of ["fetch('/x')", "Date.now()", "Math.random()", "gsap.to(x)", "requestAnimationFrame(f)", "src='//evil.example'"]) assert.throws(() => customComposition(`<html><head></head><body>${bad}</body></html>`, { allowed: true, which: CONFINED }), (e) => e.reason === "lint_refused", bad)
  assert.equal(nearestKit("spin my logo").kind, "title")
})

test("ET-SEC-02 (the new caller): quotes, colons, newlines and % land as text; a word that reads like code is never code", () => {
  const texts = [`It's "50%": a&b\nc <b>bold</b>`, "fetch Date eval Function gsap"]
  const parts = { ...GOOD, body: `${GOOD.body}<div id="p2"><span id="l2" data-slot="1"></span></div>`, texts }
  const html = customDocument(node(customVariables(parts)), FRAME, { allowed: true, which: CONFINED })
  assert.match(html, /It&#39;s &quot;50%&quot;: a&amp;b\nc &lt;b&gt;bold&lt;\/b&gt;/)
  assert.doesNotMatch(html, /<b>/)
  // Words go in after the lint: a speaker who says "fetch" doesn't sink the animation, and it stays text
  assert.match(html, /<span id="l2" data-slot="1" data-text>fetch Date eval Function gsap<\/span>/)
  assert.equal(intendedText({ kind: "block", node: node(customVariables(parts)) }), texts.map((t) => t.replace(/[\u0000-\u0009\u000b-\u001f]/g, " ").trim()).join(" "))
})

test("ET-MG2-03: every word on screen is the speaker's or the person's own; a number must be said", () => {
  assert.deepEqual(motionProblems(GOOD, { spoken, person: "make a spinning badge" }), [])
  assert.match(motionProblems({ ...GOOD, texts: ["Award winning startup"] }, { spoken, person: "make a spinning badge" })[0], /"award" isn't in the speaker's words/)
  assert.match(motionProblems({ ...GOOD, texts: ["99 rupees"] }, { spoken, person: "" })[0], /the number "99"/)
  // What the person typed counts as theirs
  assert.deepEqual(motionProblems({ ...GOOD, texts: ["Asha Rao"] }, { spoken, person: "a badge that says Asha Rao" }), [])
})

/** A gateway script: each tier's replies in order (an Error is thrown, undefined is "not on your plan"); what was sent is kept. */
function gateway(replies) {
  const sent = []
  const send = async (body) => {
    sent.push(body.model)
    const next = replies[body.model]?.shift()
    if (next instanceof Error) throw next
    if (next === undefined) throw Object.assign(new Error("That model tier isn't on your plan."), { status: 400, code: "tier_not_allowed" })
    return { choices: [{ message: { content: JSON.stringify(next) }, finish_reason: "stop" }], usage: {} }
  }
  return { sent, governor: createGovernor({ send, windowMs: 10 }) }
}
const motion = (g, extra = {}) => writeMotion({ ask: createAsk({ governor: g.governor }), tiers: ["budget", "balanced"], allowed: true, which: CONFINED, person: "add a spinning badge saying we built the whole thing", describe: "a spinning badge", spoken, canvas: FRAME.canvas, ...extra })

test("ET-MG2-01 (EH-65): off, unconfined, or no `balanced` listed: no call at all, and the nearest kit graphic is named", async () => {
  for (const [extra, why] of [
    [{ allowed: false }, "custom_motion_off"],
    [{ which: { kind: null, missing: "no sandbox" } }, "no_confinement"],
    [{ tiers: null }, "no_tier"],
    [{ tiers: ["budget"] }, "no_tier"],
  ]) {
    const g = gateway({ balanced: [GOOD] })
    const out = await motion(g, extra)
    assert.equal(out.refused, why)
    assert.equal(out.calls, 0)
    assert.deepEqual(g.sent, [], `${why}: nothing sent`)
    assert.equal(g.governor.stats.calls, 0)
    assert.ok(out.nearest.label)
  }
})

test("ET-MG2-04: on `balanced` only; one repair at most, then a clean refusal; a refused tier is answered once, never retried", async () => {
  const good = gateway({ balanced: [GOOD] })
  const made = await motion(good)
  assert.equal(made.node.blockId, CUSTOM_BLOCK)
  assert.equal(made.node.duration, 4 * F)
  assert.deepEqual(good.sent, [MOTION_TIER])
  assert.equal(made.calls, 1)
  assert.equal(good.governor.stats.calls, 1, "through the Governor, counted (ET-GOV-01, ET-NL-09)")

  const repaired = gateway({ balanced: [{ ...GOOD, texts: ["Award winning"] }, GOOD] })
  const second = await motion(repaired)
  assert.equal(second.source, "repaired")
  assert.equal(second.calls, 2)

  const twice = gateway({ balanced: [{ ...GOOD, body: "<script></script>" }, { ...GOOD, css: "@import 'x';" }, GOOD] })
  const out = await motion(twice)
  assert.equal(out.refused, "failed")
  assert.equal(out.calls, 2, "two attempts, never a third")
  assert.deepEqual(twice.sent, [MOTION_TIER, MOTION_TIER])
  assert.match(out.reason, /didn't fit, twice/)

  const notAllowed = gateway({})
  const refused = await motion(notAllowed)
  assert.equal(refused.refused, "failed")
  assert.deepEqual(notAllowed.sent, [MOTION_TIER], "a 400 tier_not_allowed is answered once, then the nearest kit graphic")
  assert.match(refused.reason, /couldn't answer/)
  assert.equal(motionLength(30 * F), 8 * F)
  assert.equal(motionLength(0), 1 * F)
})

function world() {
  const facts = { width: 1080, height: 1920, hasAudio: true, duration: Math.round((lengthOf() + 2) * F), vfr: false, fps: { n: 30, d: 1 }, color: { primaries: "bt709", transfer: "bt709", range: "tv", tagged: true, hdr: false } }
  let made = apply(newProject({ id: "p", name: "Custom" }), [{ op: "add_asset", id: "a1", kind: "video", fingerprint: "f-a1", path: "a1.mov", linked: true, rights: "own", facts }], { author: "code" })
  made = apply(made.project, [{ op: "keep_range", asset: "a1", from: 0, to: Math.round(12 * F) }], { index, author: "agent" })
  return made.project
}
const VERSIONS = { engineVersion: "e", runtimeVersion: "r" }

test("ET-MG2-05: a stored custom block is drawn only while the switch is on; off, it stays in the project with a note; the cut without one compiles as before", () => {
  const project = world()
  const before = compile(project, index, VERSIONS)
  const withBlock = apply(project, [{ op: "add_motion", block: CUSTOM_BLOCK, version: CUSTOM_VERSION, variables: customVariables(GOOD), at: Math.round(2 * F), duration: 4 * F }], { index, author: "agent" })
  assert.ok(withBlock.applied, JSON.stringify(withBlock.diagnostics))
  const off = compile(withBlock.project, index, VERSIONS)
  assert.equal(off.tiles.some((t) => t.node.blockId === CUSTOM_BLOCK), false)
  assert.ok(off.issues.some((i) => i.code === "custom_motion_off"))
  assert.equal(JSON.stringify(off.segments), JSON.stringify(before.segments), "off, the film is the film without it")
  const on = compile(withBlock.project, index, { ...VERSIONS, customMotion: true })
  const tile = on.tiles.find((t) => t.node.blockId === CUSTOM_BLOCK)
  assert.deepEqual(tile.node.placement, { x: 0, y: 0, w: 1080, h: 1920 })
  assert.equal(on.issues.some((i) => i.code === "custom_motion_off"), false)
  // With the switch on, a cut that has no custom block compiles to exactly what it did (EH-59)
  assert.deepEqual(compile(project, index, { ...VERSIONS, customMotion: true }), before)
  assert.match(describe({ op: "add_motion", block: CUSTOM_BLOCK, variables: { name: "Spinning badge" }, at: { word: "a1:w3", edge: "start" } }, index), /^Added a custom animation "Spinning badge" at/)
})

test("ET-MG2-01 (console): off, the schema and the prompt are what they were; on, custom_motion is set aside for its own slot", async () => {
  const base = consoleSchema(false)
  assert.equal(pointingSchema(base, {}), base, "the same object with nothing new")
  assert.equal(pointingSchema(base, { customMotion: false, mark: false }), base)
  const project = world()
  const word = wordId(index, "built")
  let request = ""
  let schema = null
  const ask = async (slot) => {
    request = slot.request
    schema = slot.schema
    const value = { ops: [{ op: "custom_motion", text: "a spinning badge", at: { word, edge: "start" } }], say: "I'll make a spinning badge." }
    return { value, source: "model", calls: 1, problems: slot.check(value) }
  }
  const off = await revise({ ask, project, index, text: "add a spinning badge" })
  assert.doesNotMatch(request, /custom_motion/)
  assert.equal(schema.properties.ops.items.properties.op.enum.includes("custom_motion"), false)
  assert.deepEqual(off.ops, [], "off: refused by its check, nothing proposed")
  assert.equal(off.custom, undefined)
  const on = await revise({ ask, project, index, text: "add a spinning badge", customMotion: true })
  assert.match(request, /custom_motion/)
  assert.ok(schema.properties.ops.items.properties.op.enum.includes("custom_motion"))
  assert.deepEqual(on.custom, [{ at: { word, edge: "start" }, text: "a spinning badge" }])
  assert.deepEqual(on.ops, [])
})

test("QG-08 and QG-09 on a custom tile's boxes: inside the frame and safe zone, unclipped, apart, on a plate of 4.5:1, big enough", () => {
  const output = { width: 1080, height: 1920 }
  const safe = { top: 100, right: 60, bottom: 400, left: 60 }
  const box = (extra = {}) => ({ x: 160, y: 820, w: 760, h: 90, text: "We built", size: 64, colours: ["rgb(242, 234, 223)"], plate: "rgb(19, 41, 43)", clipped: false, ...extra })
  const ok = judgeTileText([[box()], [box()]], { output, safe })
  assert.deepEqual(ok.map((r) => r.status), ["passed", "passed"])
  const status = (sets) => Object.fromEntries(judgeTileText(sets, { output, safe }).map((r) => [r.id, r.failures.map((f) => f.kind)]))
  assert.deepEqual(status([[box({ x: 1000 })]])["QG-08"], ["outside_frame"])
  assert.deepEqual(status([[box({ y: 1700 })]])["QG-08"], ["outside_safe_zone"])
  assert.deepEqual(status([[box({ clipped: true })]])["QG-08"], ["clipped"])
  assert.deepEqual(status([[box(), box({ y: 850 })]])["QG-08"], ["overlap"])
  assert.deepEqual(status([[box({ plate: "rgba(0, 0, 0, 0)" })]])["QG-09"], ["no_plate"])
  assert.deepEqual(status([[box({ plate: "rgb(60, 60, 60)", colours: ["rgb(90, 90, 90)"] })]])["QG-09"], ["low_contrast"])
  assert.deepEqual(status([[box({ size: 20 })]])["QG-09"], ["too_small"])
  assert.equal(judgeTileText([[]], { output, safe })[0].status, "not_applicable")
})

test("ET-MG2-05 (reuse): a saved custom animation is placed again from chat by its clip, with no model call for it; an unknown one is refused", async () => {
  const project = world()
  const word = wordId(index, "built")
  const saved = [{ clip: "c9", name: "Spinning badge", variables: customVariables(GOOD) }]
  const ask = (op) => async (slot) => {
    const value = { ops: [op] }
    return { value: slot.check(value).length ? { ops: [] } : value, source: "model", calls: 1 }
  }
  const again = await revise({ ask: ask({ op: "custom_motion", reuse: "c9", at: { word, edge: "start" } }), project, index, text: "use that badge again here", customMotion: true, customBlocks: saved })
  assert.deepEqual(again.custom, [{ at: { word, edge: "start" }, reuse: "c9" }])
  assert.equal(again.calls, 1, "only the console's own call")
  const unknown = await revise({ ask: ask({ op: "custom_motion", reuse: "c4", at: { word, edge: "start" } }), project, index, text: "use that badge again", customMotion: true, customBlocks: saved })
  assert.equal(unknown.custom, undefined)
})
