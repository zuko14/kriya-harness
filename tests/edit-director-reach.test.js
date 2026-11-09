import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { apply } from "../src/edit/core/ops.js"
import { newProject } from "../src/edit/core/project.js"
import { solve } from "../src/edit/core/solver.js"
import { arrangeLookups, picturesRefused, planLookups, termId } from "../src/edit/director/lookups.js"
import { ACCENTS, briefOf, planCut } from "../src/edit/director/plan.js"
import { allowedMediaUrl, downloadMedia, stillClipArgs } from "../src/edit/engine/found-media.js"
import { readablePages } from "../src/edit/engine/captions.js"
import { blockComposition, lintComposition } from "../src/edit/engine/motion.js"
import { judgeCopy } from "../src/edit/gates/copy.js"
import { strokeContrast } from "../src/edit/gates/text.js"
import { beatCuts, planMontage } from "../src/edit/recipes/montage.js"
import { planProgramme } from "../src/edit/recipes/programme.js"
import { sceneOps } from "../src/edit/recipes/scene-clips.js"

// DP2 to DP6 (DIRECTOR_PLAYBOOKS.md): a podcast's cameras, caption looks and contrast, licensed
// pictures, a song's beats and cited definitions, each behind its switch.

const FLICKS = 705_600_000
const facts = (seconds, audio = true) => ({ width: 1920, height: 1080, hasAudio: audio, duration: Math.round(seconds * FLICKS), vfr: false, fps: { n: 30, d: 1 }, color: { primaries: "bt709", transfer: "bt709", range: "tv", tagged: true, hdr: false } })
function take(sentences) {
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
  const index = { words, sentences: out, takes: [], shots: [], faces: [], subjects: {}, beats: [], bars: [], zeroCrossings: [], timestamps: {} }
  const project = apply(newProject({ id: "p", name: "T" }), [{ op: "add_asset", id: "a1", kind: "video", fingerprint: "f", path: "take.mov", linked: true, rights: "own", facts: facts(t + 1) }], { author: "code" }).project
  return { index, project, seconds: t + 1 }
}
const addAssets = (project, list) => apply(project, list.map(([id, kind, seconds, rights = "own"]) => ({ op: "add_asset", id, kind, fingerprint: id, path: `${id}.mp4`, linked: true, rights, facts: kind === "audio" ? { duration: Math.round(seconds * FLICKS), hasAudio: true } : facts(seconds) })), { author: "code" }).project
const SPEECH = ["Hello everyone and welcome back to the channel today friends.", "We walked up to the Brihadeeswarar Temple early in the morning before the crowds.", "Its great tower was built a thousand years ago by the Chola kings of the south.", "Doctors call this insulin resistance and it changes how the body works every day.", "Thank you for watching and see you all next time soon."]
const scripted = (answers) => {
  const seen = []
  return { seen, ask: async (slot) => (seen.push(slot), answers[slot.task] === undefined ? { value: slot.fallback(), source: "default", calls: 0 } : { value: answers[slot.task], source: "model", calls: 1 }) }
}
const wordOf = (index, text) => index.words.find((w) => w.text === text).id
const item = (id, title = "Brihadeeswarar Temple") => ({ id, source: "wikimedia", kind: "image", title, url: "https://upload.wikimedia.org/a.jpg", thumb: "https://upload.wikimedia.org/t.jpg", width: 1920, height: 1080, licence: "CC BY 4.0", rights: "licensed", creator: "Ravi", page: "https://commons.wikimedia.org/x" })

test("ET-DR-01 downloads only over HTTPS, only from the allowed hosts, no redirects, typed, capped", async () => {
  assert.ok(allowedMediaUrl("https://upload.wikimedia.org/a.jpg"))
  for (const bad of ["http://upload.wikimedia.org/a.jpg", "https://evil.test/a.jpg", "https://upload.wikimedia.org.evil.test/a", "https://u:p@upload.wikimedia.org/a", "https://upload.wikimedia.org:8443/a", "file:///etc/passwd", "", null]) assert.equal(allowedMediaUrl(bad), false, String(bad))
  await assert.rejects(downloadMedia("https://evil.test/a.jpg", "/tmp/x"), /source Kriya may download/)
  const dir = mkdtempSync(join(tmpdir(), "kh-found-"))
  let asked
  const get = async (url, options) => ((asked = options), new Response("picture", { headers: { "content-type": "image/jpeg" } }))
  const { file } = await downloadMedia("https://upload.wikimedia.org/a.jpg", join(dir, "a"), { get })
  assert.equal(readFileSync(file, "utf8"), "picture")
  assert.equal(asked.redirect, "error")
  await assert.rejects(downloadMedia("https://upload.wikimedia.org/a", join(dir, "b"), { get: async () => new Response("x", { headers: { "content-type": "text/html" } }) }), /isn't a picture/)
  await assert.rejects(downloadMedia("https://upload.wikimedia.org/a", join(dir, "c"), { maxBytes: 3, get }), /too big/)
  await assert.rejects(downloadMedia("https://upload.wikimedia.org/a", join(dir, "d"), { get: async () => new Response("", { status: 404 }) }), /404/)
  const args = stillClipArgs({ image: "/m/a.jpg", output: "/m/c.mp4", width: 1080, height: 1920, seconds: 6 })
  assert.ok(args.join(" ").includes("zoompan"))
  assert.ok(args.includes("-an") && args.includes("180"))
})

test("ET-DR-02 lookups: placed on phrases, clear of scenes, a term only where it's said", () => {
  const { index } = take(SPEECH)
  const from = wordOf(index, "We")
  const to = wordOf(index, "crowds.")
  const placed = arrangeLookups({ pictures: [{ from, to, query: "Brihadeeswarar Temple" }, { from: "a1:w0", to: "a1:w5", query: "hook" }, { from: "nope", to: to, query: "x y" }], terms: [{ at: wordOf(index, "insulin"), term: "insulin resistance" }, { at: wordOf(index, "Doctors"), term: "made up term" }] }, { index, asset: "a1" })
  assert.deepEqual(placed.pictures.map((p) => p.query), ["Brihadeeswarar Temple"], "not the opening, not an unknown word")
  assert.deepEqual(placed.terms.map((t) => t.term), ["insulin resistance"], "an unspoken term is dropped")
  const clear = arrangeLookups({ pictures: [{ from, to, query: "Temple tower" }] }, { index, asset: "a1", scenes: [{ from, to }] })
  assert.deepEqual(clear.pictures, [], "a scene is already there")
  assert.ok(picturesRefused("edit it, no pictures"))
  assert.equal(picturesRefused("show pictures"), false)
})

test("ET-DR-03 a plan with lookups finds, keeps and offers; the brief carries only ids", async () => {
  const { index, project } = take(SPEECH)
  const kept = []
  const lookups = { search: async (queries) => queries.map((query) => ({ query, items: [item("wikimedia:1"), item("wikimedia:2", "Brihadeeswarar Temple tower")] })), define: async (terms) => terms.map((term) => ({ term, title: term, quote: "A condition of the body.", source: "Wikipedia", page: "https://en.wikipedia.org/wiki/X", licence: "CC BY-SA 4.0" })), keep: (found) => kept.push(found) }
  const model = scripted({ plan: { say: "A cut.", steps: [], settings: {}, genre: "documentary" }, lookups: { pictures: [{ from: wordOf(index, "We"), to: wordOf(index, "crowds."), query: "Brihadeeswarar Temple" }], terms: [{ at: wordOf(index, "insulin"), term: "insulin resistance" }] } })
  const plan = await planCut({ ask: model.ask, project, index, text: "edit this", playbooks: true, lookups })
  assert.equal(plan.settings.pictures[0].id, "wikimedia:1")
  assert.equal(plan.settings.pictures[0].options.length, 2)
  assert.equal(plan.settings.terms[0].id, termId("insulin resistance"))
  assert.equal(kept[0].items.length, 2)
  const brief = briefOf(plan.settings)
  assert.deepEqual(Object.keys(brief.pictures[0]).sort(), ["from", "id", "to"], "no URL or licence from the browser")
  assert.equal(brief.captions, "story", "a documentary's look")
  const none = scripted({ plan: { say: "A cut.", steps: [], settings: {} } })
  await planCut({ ask: none.ask, project, index, text: "edit this, no pictures", lookups })
  assert.deepEqual(none.seen.map((s) => s.task), ["plan"], "the person said no: no search")
  const off = scripted({ plan: { say: "A cut.", steps: [], settings: {} } })
  await planCut({ ask: off.ask, project, index, text: "edit this" })
  assert.deepEqual(off.seen.map((s) => s.task), ["plan"], "switch off: no lookups slot")
})

test("ET-DR-04 lookups survive a failed search and find nothing plainly", async () => {
  const { index } = take(SPEECH)
  const { ask } = scripted({ lookups: { pictures: [{ from: wordOf(index, "We"), to: wordOf(index, "crowds."), query: "Temple tower" }], terms: [] } })
  const found = await planLookups({ ask, index, asset: "a1", text: "x", search: async () => [], define: async () => [] })
  assert.deepEqual(found.pictures, [])
})

test("ET-DR-04b a picture must be named for what was asked", async () => {
  const { index } = take(SPEECH)
  const { ask } = scripted({ lookups: { pictures: [{ from: wordOf(index, "We"), to: wordOf(index, "crowds."), query: "human pancreas" }], terms: [] } })
  const found = await planLookups({ ask, index, asset: "a1", text: "x", search: async ([query]) => [{ query, items: [item("wikimedia:1", "Human calvaria with metastatic lesions from primary pancreas carcinoma.jpg"), item("wikimedia:2", "The pancreas and the pancreatic duct.jpg"), item("wikimedia:3", "Human Pancreas (NIH).png"), item("wikimedia:4", "Human skull.jpg")] }], define: async () => [] })
  assert.equal(found.pictures[0].id, "wikimedia:3", "the closest title")
  assert.deepEqual(found.pictures[0].options.map((o) => o.id), ["wikimedia:3", "wikimedia:2"], "no clinical photograph, nothing off the subject")
})

test("ET-DR-04c a burst of fast speech joins its neighbour; readable pages stay as they are", () => {
  const w = (id, text, start, end) => ({ id, text, start: Math.round(start * FLICKS), end: Math.round(end * FLICKS) })
  const words = [w("a", "so", 0, 0.1), w("b", "in", 0.1, 0.2), w("c", "type", 0.2, 0.3), w("d", "one", 0.5, 1.2), w("e", "diabetes", 1.2, 2.2), w("f", "mistakes", 2.2, 3.4)]
  assert.deepEqual(readablePages([["a", "b", "c"], ["d", "e", "f"]], words), [["a", "b", "c", "d", "e", "f"]])
  assert.deepEqual(readablePages([["d", "e"], ["f"]], words), [["d", "e"], ["f"]], "readable: untouched")
  const steady = Array.from({ length: 12 }, (_, i) => w(`s${i}`, "word", i * 0.2, (i + 1) * 0.2))
  assert.equal(readablePages([steady.slice(0, 6).map((x) => x.id), steady.slice(6).map((x) => x.id)], steady).length, 2, "a fast speaker's long pages stay: they don't flash by")
  assert.deepEqual(readablePages([["d", "e", "f"], ["a", "b", "c"]], words).length, 1, "a fast last page joins the one before")
})

test("ET-DR-05 pictures and terms land on their words; a caption there has no face to clear; a term is read", () => {
  const { index, project } = take(SPEECH)
  const withClip = addAssets(project, [["c1", "video", 12, "licensed"]])
  const cut = apply(withClip, index.sentences.map((s) => ({ op: "keep_range", asset: "a1", from: { word: s.firstWord, edge: "start" }, to: { word: s.lastWord, edge: "end" } })), { author: "agent", index }).project
  const done = sceneOps({ scenes: [], pictures: [{ asset: "c1", from: wordOf(index, "We"), to: wordOf(index, "crowds.") }], terms: [{ at: wordOf(index, "insulin"), term: "insulin resistance", quote: "A condition of the body.", source: "Wikipedia", page: "https://en.wikipedia.org/wiki/X" }], project: cut, index, asset: "a1", kept: index.words })
  assert.equal(done.ops.filter((o) => o.op === "place_broll").length, 1, done.notes.join())
  const term = done.ops.find((o) => o.op === "add_motion")
  assert.equal(term.block, "term")
  assert.ok(term.duration >= 2 * FLICKS)
  const applied = apply(cut, done.ops, { index, author: "agent" })
  assert.deepEqual(applied.diagnostics, [])
  const timeline = solve(applied.project, index)
  const card = timeline.overlays.find((o) => o.block?.blockId === "term")
  assert.ok(card.placement.h > 150, "room for the quote")
  for (const caption of timeline.captions.filter((c) => c.at < card.end && card.at < c.end)) assert.ok(caption.placement.y >= card.placement.y + card.placement.h || caption.placement.y + caption.placement.h <= card.placement.y, "never on a caption")
  const output = { width: 1920, height: 1080 }
  const html = blockComposition({ blockId: "term", version: 1, variables: { text: "a<b", quote: "Quoted & exact.", source: "Wikipedia" }, placement: card.placement, duration: 3 * FLICKS }, { output, canvas: output })
  assert.match(html, /a&lt;b/)
  assert.deepEqual(lintComposition(html), [])
  const tile = { key: "k", kind: "block", at: 0, end: FLICKS, node: { blockId: "term", variables: { text: "Insulin", quote: "A hormone.", source: "Wikipedia" } } }
  assert.deepEqual(judgeCopy([{ tile, seen: "Insulin A hormone. Wikipedia" }], { copySimilarity: 0.9 }).failures, [])
  assert.equal(judgeCopy([{ tile, seen: "Insulin A hormones Wikipedia" }], { copySimilarity: 0.9 }).failures.length, 1, "a quote must be exact")
  const short = sceneOps({ scenes: [], pictures: [{ asset: "c1", from: "a1:w0", to: "a1:w9" }], project: cut, index, asset: "a1", kept: index.words })
  assert.match(short.notes.join(), /speaker is seen first/)
})

test("ET-DR-05b a short caption page holds 1.2 s only when a playbook asks; off, the same timing", async () => {
  const { index, project } = take(SPEECH)
  const ask = async (slot) => ({ value: slot.fallback(), source: "default", calls: 0 })
  const { planReel } = await import("../src/edit/recipes/reel.js")
  const quick = { ...index, words: index.words.map((w, i) => (i < 4 ? { ...w, end: w.start + Math.round(0.1 * FLICKS) } : w)) }
  const off = solve((await planReel({ project, index: quick, asset: "a1", ask, brief: { format: "9:16", captions: "clean" } })).project, quick)
  const on = solve((await planReel({ project, index: quick, asset: "a1", ask, brief: { format: "9:16", captions: "clean", holdCaptions: true } })).project, quick)
  const shortest = (t) => Math.min(...t.captions.map((c, i) => (t.captions[i + 1] ? Math.min(c.end - c.at, 99 * FLICKS) : 99 * FLICKS)))
  assert.ok(shortest(on) >= shortest(off))
  assert.equal(off.captions.length, on.captions.length)
  for (const [i, c] of on.captions.entries()) if (on.captions[i + 1]) assert.ok(c.end <= on.captions[i + 1].at, "never over the next page")
})

test("ET-DR-06 a real outline counts for contrast; a thin one doesn't; a word's one-letter slip passes, a name's doesn't", () => {
  assert.ok(strokeContrast({ colours: ["rgb(255, 255, 255)"], stroke: "rgb(0, 0, 0)", strokeWidth: 4, size: 60 }) > 15)
  assert.equal(strokeContrast({ colours: ["rgb(255, 255, 255)"], stroke: "rgb(0, 0, 0)", strokeWidth: 1, size: 60 }), null)
  assert.equal(strokeContrast({ colours: ["rgb(255, 255, 255)"], stroke: "", strokeWidth: 0, size: 60 }), null)
  assert.ok(strokeContrast({ colours: ["rgb(255, 255, 255)"], stroke: "rgb(240, 240, 240)", strokeWidth: 6, size: 60 }) < 4.5, "an outline that doesn't separate gets no credit from the gate's threshold")
  const caption = (text) => ({ key: "c", kind: "caption", at: 0, end: FLICKS, node: { text, words: text.split(" ").map((t, i) => ({ text: t, at: i, end: i + 1 })) } })
  assert.deepEqual(judgeCopy([{ tile: caption("Hey gang welcome back so"), seen: "Hey gang welcome Dack so" }], { copySimilarity: 0.9 }).failures, [])
  assert.deepEqual(judgeCopy([{ tile: caption("Okay so"), seen: "O kay so" }], { copySimilarity: 0.9 }).failures, [], "a reader's stray space")
  assert.deepEqual(judgeCopy([{ tile: caption("water all the time"), seen: "water a the time" }], { copySimilarity: 0.9 }).failures, [], "thin strokes dropped")
  assert.deepEqual(judgeCopy([{ tile: caption("diabetes mellitus where"), seen: "diabetes melitus where" }], { copySimilarity: 0.9 }).failures, [], "a doubled letter")
  assert.deepEqual(judgeCopy([{ tile: caption("in a week."), seen: "in a week.s" }], { copySimilarity: 0.9 }).failures, [], "a stray letter")
  assert.ok(judgeCopy([{ tile: caption("we built it"), seen: "we bought it" }], { copySimilarity: 0.9 }).failures.length, "a real change still fails")
  assert.ok(judgeCopy([{ tile: caption("We met Ravi today"), seen: "We met Davi today" }], { copySimilarity: 0.9 }).failures.length, "a name stays exact")
  assert.ok(judgeCopy([{ tile: caption("It cost 500 rupees"), seen: "It cost 600 rupees" }], { copySimilarity: 0.9 }).failures.length, "a number stays exact")
})

test("ET-DR-07 a podcast's cameras reach the switcher from a plan, with captions; one camera doesn't", async () => {
  const { index, project } = take(SPEECH)
  const two = addAssets(project, [["c2", "video", 40]])
  const asked = { plan: { say: "A cut.", steps: [], settings: {}, genre: "podcast" } }
  const plan = await planCut({ ask: scripted(asked).ask, project: two, index, text: "edit this", playbooks: true })
  assert.deepEqual(briefOf(plan.settings).multicam, { master: "a1", angles: [{ asset: "a1", speaker: 0 }, { asset: "c2", speaker: 1 }] })
  const one = await planCut({ ask: scripted(asked).ask, project, index, text: "edit this", playbooks: true })
  assert.equal(briefOf(one.settings).multicam, undefined)
  const steps = 200
  const analysis = { sync: { a1: { offset: 0, drift: 0, confidence: 1 }, c2: { offset: 0, drift: 0, confidence: 1 } }, speakers: [new Float64Array(steps).fill(40), new Float64Array(steps).fill(10)], labels: Array.from({ length: steps }, (_, i) => (i < 100 ? [0] : [1])) }
  const made = planProgramme({ project: two, index, brief: { captions: "minimal", captionStyle: { accent: ACCENTS.teal } }, multicam: { master: "a1", angles: [{ asset: "a1", speaker: 0 }, { asset: "c2", speaker: 1 }], analysis } })
  assert.ok(made.ops.some((o) => o.op === "caption_style"))
  assert.ok(made.ops.some((o) => o.op === "place_broll" && o.asset === "c2"), "the other camera while they talk")
  assert.equal(made.project.look.caption.accent, ACCENTS.teal)
})

test("ET-DR-08 a montage cuts on the song's beats and is heard as the song", () => {
  const beats = Array.from({ length: 40 }, (_, i) => ({ asset: "s", t: Math.round((i + 1) * 0.5 * FLICKS), downbeat: i % 4 === 0 }))
  const cuts = beatCuts(beats, 15 * FLICKS)
  assert.ok(cuts.every((c, i) => c - (cuts[i - 1] ?? 0) >= 0.8 * FLICKS), "never faster than the eye")
  assert.ok(cuts.every((c) => beats.some((b) => b.t === c)), "on the beats")
  const { index, project } = take(SPEECH)
  const withSong = addAssets(project, [["s", "audio", 20], ["c2", "video", 30]])
  const made = planMontage({ project: withSong, index: { ...index, beats }, brief: { music: "s", format: "9:16", targetDuration: 12 * FLICKS } })
  assert.ok(made.ops.some((o) => o.op === "set_music" && o.asset === "s"))
  assert.ok(made.ops.filter((o) => o.op === "keep_range").length >= 5)
  assert.ok(made.ops.filter((o) => o.op === "set_level").every((o) => o.db === -60), "the clips' own sound goes")
  const timeline = solve(made.project, { ...index, beats })
  assert.ok(Math.abs(timeline.duration - 12 * FLICKS) < 0.5 * FLICKS, `${timeline.duration / FLICKS} s`)
  assert.throws(() => planMontage({ project, index, brief: { music: "none" } }), /needs a song/)
})

test("ET-DR-09 the plan uses the person's song when they say so, and a montage needs it", async () => {
  const { index, project } = take(SPEECH)
  const withSong = addAssets(project, [["s", "audio", 60]])
  const asked = { plan: { say: "A cut.", steps: [], settings: {}, genre: "opinion" } }
  assert.equal(briefOf((await planCut({ ask: scripted(asked).ask, project: withSong, index, text: "use my song for this", playbooks: true })).settings).music, "s")
  const montage = { plan: { say: "A cut.", steps: [], settings: {}, genre: "montage" } }
  const brief = briefOf((await planCut({ ask: scripted(montage).ask, project: withSong, index, text: "edit", playbooks: true })).settings)
  assert.equal(brief.montage, true)
  assert.equal(brief.music, "s")
  assert.equal(briefOf((await planCut({ ask: scripted(montage).ask, project, index, text: "edit", playbooks: true })).settings).montage, undefined, "no song, no montage")
})
