import assert from "node:assert/strict"
import { test } from "node:test"

import { sceneFrame } from "../src/edit/core/layout.js"
import { apply } from "../src/edit/core/ops.js"
import { newProject } from "../src/edit/core/project.js"
import { solve } from "../src/edit/core/solver.js"
import { arrangeScenes, codeBeats, groundProblems, numbersSaid, phrasesOf, planScenes, revealWords, visualsIn } from "../src/edit/director/beats.js"
import { briefOf, planCut } from "../src/edit/director/plan.js"
import { blockComposition, lintComposition } from "../src/edit/engine/motion.js"
import { buildScene, cleanScene, layoutKind, SCENE_KINDS, SCENE_THEMES, sceneText, swapsFor } from "../src/edit/engine/scenes.js"
import { fetchFeatures } from "../src/edit/runtime/fetch.js"
import { judgeCopy } from "../src/edit/gates/copy.js"
import { judgeLayout, contrast, luminance } from "../src/edit/gates/text.js"
import { sceneOps } from "../src/edit/recipes/scene-clips.js"
import { planReel } from "../src/edit/recipes/reel.js"

// Visual scenes (VISUAL_SCENES.md, ET-VS-*): the words are the speaker's, the geometry holds
// in every frame, a re-make leaves no old scene, and with the switch off nothing changes.

const FLICKS = 705_600_000
const SPEECH = [
  "Hello everyone and welcome to the channel today.",
  "When you eat a meal your blood sugar rises and the pancreas releases insulin.",
  "Without insulin glucose floods into the bloodstream and stays there for hours.",
  "I still remember how scared my mother was that day.",
  "About 80 percent of that glucose goes to your muscles while the rest goes to the liver.",
  "So please follow the channel for more science every week.",
]

/** A take with those sentences: 0.4 s a word, half a second between sentences. */
function take(sentences = SPEECH) {
  const words = []
  const out = []
  let t = 0
  sentences.forEach((sentence, s) => {
    const first = words.length
    for (const text of sentence.split(" ")) {
      words.push({ id: `a1:w${words.length}`, asset: "a1", text, start: Math.round(t * FLICKS), end: Math.round((t + 0.36) * FLICKS), flags: [] })
      t += 0.4
    }
    out.push({ id: `a1:s${s}`, asset: "a1", firstWord: words[first].id, lastWord: words.at(-1).id, start: words[first].start, end: words.at(-1).end, score: 1 })
    t += 0.5
  })
  const index = { words, sentences: out, takes: [], shots: [], faces: [], subjects: {}, beats: [], bars: [], zeroCrossings: [], timestamps: [] }
  const duration = Math.round((t + 1) * FLICKS)
  const facts = { width: 1920, height: 1080, hasAudio: true, duration, vfr: false, fps: { n: 30, d: 1 }, color: { primaries: "bt709", transfer: "bt709", range: "tv", tagged: true, hdr: false } }
  const project = apply(newProject({ id: "p", name: "Talk" }), [{ op: "add_asset", id: "a1", kind: "video", fingerprint: "f", path: "take.mov", linked: true, rights: "own", facts }], { author: "code" }).project
  return { index, project, duration }
}

// Phrases split sentences at clauses: where the scene on this sentence really starts
const phraseStart = (index, sentence) => phrasesOf(index, "a1").map((p) => index.words[p.first]).find((w) => w.start >= sentence.start)?.id
const flood = (over = {}) => ({ from: "a1:s2", to: "a1:s2", kind: "flow", mode: "floods", theme: "lab", title: "Without insulin", items: [{ text: "glucose" }, { text: "bloodstream" }], ...over })
const stat = (over = {}) => ({ from: "a1:s4", to: "a1:s4", kind: "stat", theme: "lab", title: "", items: [{ text: "goes to your muscles", value: "80", unit: "%" }], ...over })
const scripted = (answers) => {
  const seen = []
  const ask = async (slot) => {
    seen.push(slot)
    const answer = answers[slot.task]
    if (answer === undefined) return { value: slot.fallback(), source: "default", reason: "no model", calls: 0 }
    return { value: typeof answer === "function" ? answer(slot) : answer, source: "model", calls: 1 }
  }
  return { ask, seen }
}

test("ET-VS-01 a scene's shape is checked at the boundary: unknown kinds, fields and markup go", () => {
  assert.equal(cleanScene({ kind: "video", items: [{ text: "x" }] }), null)
  assert.equal(cleanScene(null), null)
  assert.equal(cleanScene({ kind: "process", items: [{ text: "only one" }] }), null, "needs two steps")
  assert.equal(cleanScene({ kind: "stat", items: [{ text: "no number" }] }), null)
  assert.equal(cleanScene({ kind: "stat", items: [{ text: "x", value: "1e9" }] }), null, "a value is digits")
  const clean = cleanScene({ kind: "process", theme: "nope", title: "<img src=x onerror=alert(1)>", script: "x", items: [{ text: "a<b>", code: "x" }, { text: "c" }] })
  assert.equal(clean.theme, "lab")
  assert.equal(clean.script, undefined)
  assert.equal(clean.items[0].code, undefined)
  assert.doesNotMatch(clean.title + clean.items[0].text, /[<>]/)
})

test("ET-VS-02 the document escapes text, passes the model-code lint and has no clock, network or chance", () => {
  const output = { width: 1080, height: 1920 }
  for (const kind of Object.keys(SCENE_KINDS)) {
    const shape = SCENE_KINDS[kind]
    const items = Array.from({ length: Math.max(shape.min, 3 > shape.max ? shape.max : 3) }, (_, i) => ({ text: `a&b "${i}"`, value: `${i + 1}`, unit: "%" }))
    const variables = { kind, title: 'quote " & amp', theme: "paper", items, mode: "floods" }
    const html = blockComposition({ blockId: "scene", version: 1, variables, placement: { x: 100, y: 200, w: 800, h: 1000 }, duration: 6 * FLICKS }, { output, canvas: output })
    assert.deepEqual(lintComposition(html), [], kind)
    assert.match(html, /a&amp;b/, kind)
    assert.match(html, /Content-Security-Policy/)
    assert.equal(html, blockComposition({ blockId: "scene", version: 1, variables, placement: { x: 100, y: 200, w: 800, h: 1000 }, duration: 6 * FLICKS }, { output, canvas: output }), "the same document every time")
  }
})

test("ET-VS-03 every theme's ink and plate hold 4.5:1", () => {
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  for (const [name, theme] of Object.entries(SCENE_THEMES)) {
    assert.ok(contrast(luminance(rgb(theme.ink)), luminance(rgb(theme.plate))) >= 4.5, `${name} ink on plate`)
    assert.ok(contrast(luminance(rgb(theme.ink)), luminance(rgb(theme.bg))) >= 4.5, `${name} ink on background`)
  }
})

test("ET-VS-04 no box overlaps another or leaves its region, in any frame, at any count", () => {
  const collide = (a, b) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5
  const frames = [[1080, 1920, { top: 231, right: 152, bottom: 423, left: 65 }], [1920, 1080, {}], [1080, 1080, {}], [1080, 1350, {}]]
  for (const [width, height, safe] of frames) {
    const { content, row } = sceneFrame({ width, height }, safe, { w: Math.floor(width * 0.8), h: Math.floor(height * 0.12) })
    assert.ok(content.y + content.h <= row.y, "the content stays above the caption row")
    assert.ok(row.y + row.h <= height - (safe.bottom ?? 0), "the row is inside the safe zone")
    const base = Math.round(Math.min(width, height) * 0.05)
    const d = { ...content, y: content.y + base * 3, h: content.h - base * 3 }
    for (const [kind, shape] of Object.entries(SCENE_KINDS)) {
      for (let count = shape.min; count <= shape.max; count++) {
        const boxes = layoutKind(kind, count, d, base, height > width)
        assert.equal(boxes.length, count, `${kind} ${count}`)
        for (const [i, a] of boxes.entries()) {
          assert.ok(a.x >= d.x - 1 && a.y >= d.y - 1 && a.x + a.w <= d.x + d.w + 1 && a.y + a.h <= d.y + d.h + 1, `${kind} ${count} box ${i} leaves ${width}x${height}`)
          for (const [k, b] of boxes.entries()) if (k > i) assert.ok(!collide(a, b), `${kind} ${count} boxes ${i},${k} overlap in ${width}x${height}`)
        }
      }
    }
  }
})

test("ET-VS-05 the swaps offered are the ones that can draw these items", () => {
  assert.deepEqual(swapsFor(cleanScene({ kind: "process", items: [{ text: "a" }, { text: "b" }, { text: "c" }] })), ["process", "cycle", "hub", "flow"])
  assert.deepEqual(swapsFor(cleanScene(stat())), ["stat"], "a single number can only be a number")
  assert.ok(swapsFor(cleanScene({ kind: "bars", items: [{ text: "a", value: "1" }, { text: "b", value: "2" }] })).includes("compare"))
  for (const swap of swapsFor(cleanScene({ kind: "process", items: [{ text: "a" }, { text: "b" }, { text: "c" }] }))) assert.ok(cleanScene({ kind: swap, items: [{ text: "a" }, { text: "b" }, { text: "c" }] }), swap)
})

test("ET-VS-06 words on screen are the speaker's: an added fact or number is refused", () => {
  const near = "about 80 percent of that glucose goes to your muscles"
  const all = `${near} without insulin glucose floods the bloodstream`
  assert.deepEqual(groundProblems(cleanScene(stat({ title: "Where glucose goes" })), { all, near }), [])
  assert.match(groundProblems(cleanScene(stat({ items: [{ text: "muscles", value: "90", unit: "%" }] })), { all, near })[0], /number "90"/, "a figure never said")
  assert.match(groundProblems(cleanScene(stat({ title: "Harvard says so" })), { all, near })[0], /harvard/i, "a name never said")
  assert.match(groundProblems(cleanScene(stat({ title: "In 2019" })), { all, near })[0], /2019/, "a number in a title")
  assert.match(groundProblems(cleanScene(stat({ items: [{ text: "muscles", value: "80", unit: "mg" }] })), { all, near })[0], /unit/, "a unit never said")
  assert.deepEqual(groundProblems(cleanScene({ kind: "stat", title: "", items: [{ text: "muscles", value: "75", unit: "%" }] }), { all: `${all} seventy five percent`, near: "seventy five percent" }), [], "a number said in words")
  assert.deepEqual([...numbersSaid("two hundred and five people, 1,000 more and a thousand")].sort(), ["1000", "205"])
  assert.deepEqual(groundProblems(cleanScene({ kind: "process", title: "", items: [{ text: "ग्लूकोज़" }, { text: "इंसुलिन" }] }), { all: "ग्लूकोज़ और इंसुलिन", near: "ग्लूकोज़" }), [], "any language, as spoken")
})

test("ET-VS-07 scenes are placed by code: real lines, not the hook, not trimmed, room between, under the share", () => {
  const { index } = take()
  const made = arrangeScenes([stat(), flood()], { index, asset: "a1" })
  assert.deepEqual(made.scenes.map((s) => s.from), [index.sentences[2].firstWord, phraseStart(index, index.sentences[4])], "in spoken order, on word ids")
  assert.match(arrangeScenes([flood({ from: "a1:s0", to: "a1:s0", title: "", items: [{ text: "hello" }, { text: "channel" }] })], { index, asset: "a1" }).dropped[0].reason, /hook/)
  assert.match(arrangeScenes([flood({ from: "a1:s99" })], { index, asset: "a1" }).dropped[0].reason, /aren't in this take/)
  assert.match(arrangeScenes([flood({ from: "a1:s3", to: "a1:s2" })], { index, asset: "a1" }).dropped[0].reason, /aren't in this take/, "backwards")
  const s2 = index.sentences[2]
  assert.match(arrangeScenes([flood()], { index, asset: "a1", cuts: [{ from: s2.start / FLICKS + 0.5, to: s2.start / FLICKS + 1.5 }] }).dropped[0].reason, /trim/)
  assert.match(arrangeScenes([flood({ title: "Harvard" })], { index, asset: "a1" }).dropped[0].reason, /harvard/i)
  const next = arrangeScenes([flood(), { kind: "stat", from: "a1:s3", to: "a1:s3", title: "", items: [{ text: "mother", value: "80" }] }], { index, asset: "a1" })
  assert.equal(next.scenes.length, 1, "side by side lines don't both become scenes")
  const short = take(["Welcome back to this channel everyone and thank you.", "Glucose floods.", "It then stays in the bloodstream for hours and hours.", "Goodbye for now my friends and see you."])
  const grown = arrangeScenes([{ kind: "flow", from: "a1:s1", to: "a1:s1", title: "", items: [{ text: "glucose" }, { text: "bloodstream" }] }], { index: short.index, asset: "a1" })
  assert.ok(short.index.words.find((w) => w.id === grown.scenes[0].to).end > short.index.sentences[1].end, "a short line takes the next one with it")
  const everything = take(Array.from({ length: 8 }, (_, i) => `Glucose moves through the bloodstream to the muscles in step ${["one", "two", "three", "four", "five", "six", "seven", "eight"][i]} here.`))
  const many = arrangeScenes(everything.index.sentences.slice(1).map((s) => ({ kind: "process", from: s.id, to: s.id, title: "", items: [{ text: "glucose" }, { text: "muscles" }] })), { index: everything.index, asset: "a1" })
  const wordAt = new Map(everything.index.words.map((w) => [w.id, w]))
  const spans = many.scenes.reduce((sum, sc) => sum + wordAt.get(sc.to).end - wordAt.get(sc.from).start, 0)
  assert.ok(spans <= (everything.index.words.at(-1).end - everything.index.words[0].start) * 0.65)
})

test("ET-VS-07b a long run of speech with no sentence marks still gives scenes on phrases (found on a real take)", () => {
  const long = "the kidneys try to get rid of excess glucose but the water follows resulting in excess urination so because of excess urination the person ends up quenching for water all the time so despite having abundant glucose the body literally starves"
  const { index } = take(["Hey gang welcome back to the channel today friends.", long, "See you next time everyone."])
  const sentence = index.sentences[1]
  assert.ok(sentence.end - sentence.start > 14 * FLICKS, "too long for one scene")
  const phrases = phrasesOf(index, "a1")
  assert.ok(phrases.length >= 5, phrases.map((p) => p.text).join(" | "))
  assert.ok(phrases.every((p) => p.end - p.start <= 8 * FLICKS))
  assert.equal(phrases.flatMap((p) => p.text.split(" ")).length, index.words.length, "every word in one phrase")
  const find = (text) => index.words.find((w) => w.text === text).id
  const made = arrangeScenes([{ kind: "cycle", from: find("the"), to: find("starves"), title: "", items: [{ text: "kidneys" }, { text: "urination" }, { text: "water" }] }, { kind: "process", from: find("but"), to: find("urination"), title: "", items: [{ text: "excess glucose" }, { text: "water follows" }, { text: "excess urination" }] }], { index, asset: "a1" })
  assert.ok(made.scenes.some((s) => s.kind === "process"), JSON.stringify(made.dropped))
  const scene = made.scenes.find((s) => s.kind === "process")
  assert.equal(index.words.find((w) => w.id === scene.from).text, "but", "it starts on the clause")
})

test("ET-VS-08 each label lands on the word it's said on", () => {
  const { index } = take()
  const spoken = index.words.filter((w) => w.start >= index.sentences[1].start && w.end <= index.sentences[1].end)
  const landing = revealWords(cleanScene({ kind: "process", items: [{ text: "blood sugar rises" }, { text: "insulin" }, { text: "never said" }] }), spoken)
  assert.equal(landing[0].text, "blood")
  assert.equal(landing[1].text, "insulin.")
  assert.equal(landing[2], null)
})

test("ET-VS-09 with no model, code's beats say only what the sentence says outright", () => {
  const { index } = take()
  const beats = codeBeats(index, "a1")
  const flow = beats.find((b) => b.kind === "flow")
  assert.equal(flow.mode, "floods")
  assert.equal(flow.items[0].text.toLowerCase().includes("glucose"), true)
  const number = beats.find((b) => b.kind === "stat")
  assert.equal(number.items[0].value, "80")
  assert.equal(number.items[0].unit, "%")
  const placed = arrangeScenes(beats, { index, asset: "a1" })
  assert.ok(placed.scenes.length >= 1, JSON.stringify(placed.dropped))
  assert.deepEqual(codeBeats(take(["Hello my friends.", "I love this city so much."]).index, "a1"), [], "nothing to draw, nothing drawn")
})

test("ET-VS-10 the person's words come first, and a story gets no diagram", async () => {
  const { index } = take()
  assert.equal(visualsIn("please no animations in this"), "off")
  assert.equal(visualsIn("add some diagrams"), "on")
  assert.equal(visualsIn("make it 16:9"), null)
  const off = scripted({ scenes: { contentType: "explainer", theme: "lab", scenes: [flood()] } })
  assert.deepEqual((await planScenes({ ask: off.ask, index, asset: "a1", text: "make it short, no visuals" })).scenes, [])
  assert.equal(off.seen.length, 0, "no model call when the person said no")
  const story = scripted({ scenes: { contentType: "vlog", theme: "lab", scenes: [flood()] } })
  assert.deepEqual((await planScenes({ ask: story.ask, index, asset: "a1", text: "edit this" })).scenes, [])
  const asked = scripted({ scenes: { contentType: "vlog", theme: "lab", scenes: [flood()] } })
  assert.equal((await planScenes({ ask: asked.ask, index, asset: "a1", text: "add animations please" })).scenes.length, 1)
  assert.equal(asked.seen[0].tier, "balanced", "the owner's tier (EDD-55)")
  const themed = scripted({ scenes: { contentType: "explainer", theme: "lab", scenes: [flood()] } })
  assert.equal((await planScenes({ ask: themed.ask, index, asset: "a1", text: "explain it on a chalkboard" })).scenes[0].theme, "chalk")
  const kept = scripted({})
  const previous = { settings: { scenes: [flood({ kind: "process", mode: undefined })] } }
  assert.equal((await planScenes({ ask: kept.ask, index, asset: "a1", text: "make the music louder", previous })).scenes[0].kind, "process", "a revision keeps the card's swap")
  assert.equal(kept.seen.length, 0)
})

test("ET-VS-11 a tier the plan doesn't have falls back to budget, and a bad answer to code's beats", async () => {
  const { index } = take()
  const tiers = []
  const ask = async (slot) => {
    tiers.push(slot.tier)
    if (slot.tier === "balanced") return { value: slot.fallback(), source: "default", reason: "refused", calls: 1 }
    return { value: { contentType: "explainer", theme: "blueprint", scenes: [flood()] }, source: "model", calls: 1 }
  }
  const done = await planScenes({ ask, index, asset: "a1", text: "explain it" })
  assert.deepEqual(tiers, ["balanced", "budget"])
  assert.equal(done.scenes[0].theme, "blueprint")
  const none = await planScenes({ ask: async (slot) => ({ value: slot.fallback(), source: "default", reason: "signed out", calls: 0 }), index, asset: "a1", text: "explain it" })
  assert.ok(none.scenes.length >= 1, "code's own beats, with no model at all")
  const check = scripted({ scenes: (slot) => {
    assert.ok(slot.check({ scenes: [flood({ title: "Harvard" })] }).length, "nothing usable goes back to the model")
    assert.deepEqual(slot.check({ scenes: [flood(), flood({ title: "Harvard", from: "a1:s4", to: "a1:s4" })] }), [], "one good scene is enough; the bad one is dropped")
    return { contentType: "explainer", theme: "lab", scenes: [] }
  } })
  await planScenes({ ask: check.ask, index, asset: "a1", text: "explain" })
})

test("ET-VS-REG-01 switch off: no extra call, the same prompt, the same settings, no scenes in the brief", async () => {
  const { index, project } = take()
  const planAnswer = { say: "A cut.", steps: ["Cut it"], settings: { captions: "clean" } }
  const before = scripted({ plan: planAnswer })
  const off = await planCut({ ask: before.ask, project, index, text: "add animations and make a cut" })
  assert.deepEqual(before.seen.map((s) => s.task), ["plan"])
  assert.equal(off.settings.scenes, undefined)
  assert.equal(briefOf(off.settings).scenes, undefined)
  assert.match(before.seen[0].request, /no stock footage or generated video/)
  assert.doesNotMatch(before.seen[0].request, /Animated explainer/)
  const again = scripted({ plan: planAnswer })
  await planCut({ ask: again.ask, project, index, text: "add animations and make a cut", visuals: false })
  assert.equal(again.seen[0].request, before.seen[0].request, "explicitly off is the default")
})

test("ET-VS-12 on: the plan carries the checked scenes, the pitch knows, and they're the brief an approval makes", async () => {
  const { index, project } = take()
  const made = scripted({ scenes: { contentType: "explainer", theme: "lab", scenes: [flood(), flood({ title: "Harvard says", from: "a1:s4", to: "a1:s4" })] }, plan: { say: "A cut.", steps: [], settings: {} } })
  const plan = await planCut({ ask: made.ask, project, index, text: "explain this", visuals: true })
  assert.deepEqual(made.seen.map((s) => s.task), ["scenes", "plan"])
  assert.equal(plan.settings.scenes.length, 1, "the invented one is gone")
  assert.match(made.seen[1].request, /Animated explainer scenes/)
  assert.match(plan.steps.at(-1), /1 animated scene/)
  const brief = briefOf(plan.settings)
  assert.equal(brief.scenes[0].kind, "flow")
  assert.equal(brief.sceneSound, true)
  const quiet = scripted({ scenes: { contentType: "explainer", theme: "lab", scenes: [flood()] }, plan: { say: "A cut.", steps: [], settings: {} } })
  assert.equal(briefOf((await planCut({ ask: quiet.ask, project, index, text: "explain this, no sound effects", visuals: true })).settings).sceneSound, false)
})

test("ET-VS-13 a make lays each scene on its words, over the kept cut, with captions on a clear row, and sound on the words", async () => {
  const { index, project } = take()
  const withSounds = apply(project, [
    { op: "add_asset", id: "sw", kind: "audio", fingerprint: "w", path: "w.wav", linked: true, rights: "own", facts: { duration: FLICKS, hasAudio: true, peak: 0 } },
    { op: "add_asset", id: "sp", kind: "audio", fingerprint: "p", path: "p.wav", linked: true, rights: "own", facts: { duration: FLICKS / 4, hasAudio: true, peak: 0 } },
  ], { author: "code" }).project
  const ask = scripted({}).ask
  const brief = { format: "9:16", captions: "clean", scenes: [cleanScene(flood()), cleanScene(stat())], sfx: { scene: "sw", reveal: "sp" }, targetDuration: 60 * FLICKS }
  const made = await planReel({ project: withSounds, index, asset: "a1", ask, brief })
  const motion = made.ops.filter((op) => op.op === "add_motion")
  assert.equal(motion.length, 2, made.notes.join("; "))
  assert.equal(motion[0].block, "scene")
  assert.equal(motion[0].variables.kind, "flow")
  assert.ok(motion[0].variables.items[0].reveal > 0, "the label lands on its word")
  assert.equal(made.ops.filter((op) => op.op === "add_sfx" && op.asset === "sw").length, 2, "a whoosh per scene")
  assert.ok(made.ops.some((op) => op.op === "add_sfx" && op.asset === "sp"), "a pop as a label lands")
  const timeline = solve(made.project, index)
  const scenes = timeline.overlays.filter((o) => o.block?.blockId === "scene")
  assert.equal(scenes.length, 2)
  assert.ok(scenes[0].placement.w > 0, "a scene has its content box")
  const under = timeline.captions.filter((c) => c.at < scenes[0].end && scenes[0].at < c.end)
  assert.ok(under.length > 0)
  for (const caption of under) assert.ok(caption.placement.y >= scenes[0].placement.y + scenes[0].placement.h, "a caption over a scene sits below its content")
  assert.deepEqual(timeline.issues.filter((i) => i.code === "no_placement"), [])
  // Punch-ins would be hidden under a scene
  const covered = new Set(motion.flatMap((op) => { const a = index.words.findIndex((w) => w.id === op.at.word); const b = index.words.findIndex((w) => w.id === op.until.word); return index.words.slice(a, b + 1).map((w) => w.id) }))
  for (const op of made.ops.filter((o) => o.op === "punch_in" && o.at.word)) assert.ok(!covered.has(op.at.word), op.at.word)

  // A second make: the old scenes go with the old cut, and nothing appears twice
  const second = await planReel({ project: made.project, index, asset: "a1", ask, brief })
  assert.equal(solve(second.project, index).overlays.filter((o) => o.block?.blockId === "scene").length, 2)
  // A third with none: none left
  const none = await planReel({ project: second.project, index, asset: "a1", ask, brief: { format: "9:16", targetDuration: 60 * FLICKS } })
  assert.equal(solve(none.project, index).overlays.filter((o) => o.block?.blockId === "scene").length, 0)
})

test("ET-VS-14 a scene whose lines left the cut is dropped with a note, and the first seconds stay on the speaker", () => {
  const { index, project } = take()
  const cut = apply(project, index.sentences.filter((s) => s.id !== "a1:s2").map((s) => ({ op: "keep_range", asset: "a1", from: { word: s.firstWord, edge: "start" }, to: { word: s.lastWord, edge: "end" } })), { author: "agent", index }).project
  const kept = index.words.filter((w) => !(w.start >= index.sentences[2].start && w.end <= index.sentences[2].end))
  const done = sceneOps({ scenes: [cleanScene(flood()), cleanScene(stat())], project: cut, index, asset: "a1", kept })
  assert.equal(done.ops.filter((op) => op.op === "add_motion").length, 1)
  assert.match(done.notes.join(), /aren't in this cut/)
})

test("ET-VS-14b fitting the length keeps the lines under an approved scene, and honours a longer ask (found on real footage)", async () => {
  const filler = Array.from({ length: 14 }, (_, i) => `This line number ${["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen"][i]} says something else entirely for a good long while now.`)
  const { index, project } = take([...filler, "Without insulin glucose floods into the bloodstream and stays there for hours."])
  const s = index.sentences.at(-1)
  const scene = cleanScene({ kind: "flow", mode: "floods", from: s.firstWord, to: s.lastWord, title: "", items: [{ text: "glucose" }, { text: "bloodstream" }] })
  const short = await planReel({ project, index, asset: "a1", ask: scripted({}).ask, brief: { format: "9:16", scenes: [scene], targetDuration: 30 * FLICKS } })
  assert.equal(short.ops.filter((o) => o.op === "add_motion").length, 1, short.notes.join("; "))
  const long = await planReel({ project, index, asset: "a1", ask: scripted({}).ask, brief: { format: "9:16", scenes: [scene], targetDuration: 90 * FLICKS } })
  assert.ok(solve(long.project, index).duration > 60 * FLICKS, "the 90 s asked for, past the reel's 60")
  const off = await planReel({ project, index, asset: "a1", ask: scripted({}).ask, brief: { format: "9:16", targetDuration: 90 * FLICKS } })
  assert.ok(solve(off.project, index).duration <= 61 * FLICKS, "without scenes, as before")
})

test("ET-VS-14c a scene right after another holds the first until it starts: no flash of the speaker", () => {
  const { index, project } = take(["Welcome back to this channel everyone and thank you for coming.", "The kidneys try to remove glucose from the blood all day long.", "Right then.", "The water follows the glucose out of the body every single time.", "Goodbye for now my friends and see you next time."])
  const [first, a, gone, b, last] = index.sentences
  const keeps = [first, a, b, last].map((s) => ({ op: "keep_range", asset: "a1", from: { word: s.firstWord, edge: "start" }, to: { word: s.lastWord, edge: "end" } }))
  const cut = apply(project, keeps, { author: "agent", index }).project
  const kept = index.words.filter((w) => !(w.start >= gone.start && w.end <= gone.end))
  const scene = (s, text) => cleanScene({ kind: "process", from: s.firstWord, to: s.lastWord, title: "", items: [{ text }, { text: "glucose" }] })
  const done = sceneOps({ scenes: [scene(a, "kidneys"), scene(b, "water")], project: cut, index, asset: "a1", kept })
  const motion = done.ops.filter((o) => o.op === "add_motion")
  assert.equal(motion.length, 2, done.notes.join())
  assert.deepEqual(motion[0].until, { word: b.firstWord, edge: "start" }, "held until the next scene")
  assert.equal(motion[1].until.word, b.lastWord)
})

test("ET-VS-15 gates: a scene hides the face, and its words are read as a set", () => {
  const box = { x: 100, y: 100, w: 400, h: 100, size: 50, clipped: false }
  const scene = { key: "k", kind: "block", at: 0, end: 5 * FLICKS, node: { blockId: "scene", variables: { kind: "process", title: "How it works", items: [{ text: "sugar rises" }, { text: "insulin released" }] } } }
  const faces = [{ asset: "a1", t: FLICKS, box: { x: 100, y: 100, w: 400, h: 400 } }]
  const project = { canvas: { width: 1920, height: 1080 }, deliverables: [], assets: [{ id: "a1", facts: { width: 1920, height: 1080 } }] }
  const plan = (tiles) => ({ output: { width: 1920, height: 1080, fps: { n: 30, d: 1 } }, canvas: { width: 1920, height: 1080 }, tiles, duration: 5 * FLICKS, segments: [{ start: 0, end: 5 * FLICKS, node: { picture: [{ asset: "a1", in: 0, out: 5 * FLICKS, at: 0, end: 5 * FLICKS, speed: { n: 1, d: 1 }, effects: [] }], overlays: [] } }] })
  const measured = (tile) => [{ t: FLICKS, tile, box }]
  assert.equal(judgeLayout({ plan: plan([scene]), project, index: { faces }, measured: measured(scene) }).status, "passed", "no face under a scene")
  const card = { key: "c", kind: "block", at: 0, end: 5 * FLICKS, node: { blockId: "title", variables: { text: "x" } } }
  assert.equal(judgeLayout({ plan: plan([card]), project, index: { faces }, measured: measured(card) }).failures[0].kind, "on_face", "a title still can't sit on one")
  assert.equal(sceneText(scene.node.variables), "How it works sugar rises insulin released")
  const options = { copySimilarity: 0.9 }
  assert.deepEqual(judgeCopy([{ tile: scene, seen: "insulin released sugar rises How it works" }], options).failures, [], "any reading order")
  assert.equal(judgeCopy([{ tile: scene, seen: "How it works sugar rises" }], options).failures[0].kind, "copy_mismatch", "a missing word fails")
  assert.equal(judgeCopy([{ tile: card, seen: "y" }], options).failures[0].kind, "copy_mismatch", "other cards as before")
})

test("ET-VS-16 a client asks the server, and any failure means off", async () => {
  const saved = globalThis.fetch
  const device = { url: "http://kriya.test", token: "t" }
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ visuals: true }), { status: 200, headers: { "content-type": "application/json" } })
    assert.deepEqual(await fetchFeatures(device), { visuals: true, playbooks: false, mediaSearch: false, motion: false, customMotion: false, assembly: false, livePreview: false, intent: false, craft: false, typeKit: false, referenceIntent: false, directorLoop: false, taviOrder: false })
    globalThis.fetch = async () => new Response(JSON.stringify({ code: "not_found", message: "Not found." }), { status: 404, headers: { "content-type": "application/json" } })
    assert.deepEqual(await fetchFeatures(device), { visuals: false, playbooks: false, mediaSearch: false, motion: false, customMotion: false, assembly: false, livePreview: false, intent: false, craft: false, typeKit: false, referenceIntent: false, directorLoop: false, taviOrder: false }, "an older server")
    globalThis.fetch = async () => {
      throw new Error("offline")
    }
    assert.deepEqual(await fetchFeatures(device), { visuals: false, playbooks: false, mediaSearch: false, motion: false, customMotion: false, assembly: false, livePreview: false, intent: false, craft: false, typeKit: false, referenceIntent: false, directorLoop: false, taviOrder: false })
    globalThis.fetch = async () => new Response(JSON.stringify({ visuals: "yes" }), { status: 200, headers: { "content-type": "application/json" } })
    assert.deepEqual(await fetchFeatures(device), { visuals: false, playbooks: false, mediaSearch: false, motion: false, customMotion: false, assembly: false, livePreview: false, intent: false, craft: false, typeKit: false, referenceIntent: false, directorLoop: false, taviOrder: false }, "only a real yes")
  } finally {
    globalThis.fetch = saved
  }
})

test("ET-VS-17 buildScene refuses what isn't a scene, plainly", () => {
  assert.throws(() => buildScene({ variables: { kind: "nope" }, area: { x: 0, y: 0, w: 10, h: 10 }, output: { width: 10, height: 10 }, duration: FLICKS }, () => []), /don't describe a scene/)
})
