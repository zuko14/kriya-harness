import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

import { apply } from "../../../src/edit/core/ops.js"
import { clipList, decideAssembly, essence, findSaid, splitAt, withIds } from "../../../src/edit/director/assembly.js"
import { ROOT } from "../../helpers.js"
import { film, world } from "./assembly-world.js"

// Bench-A-M (TOP_TIER_PLAN §6): can a person say it once? 40 assembly requests, each given three
// ways: as a storyboard, as mentions, and as English words. A function stands in for the model, so
// it costs nothing. A form passes a case when it makes the expected assembly and the film made
// from it passes QG-15 against the expected order, read from the rendered file. The storyboard
// and mention forms are code alone and must pass 40 of 40. The words here are ones the placement
// readers were written against, so their score says the readers do what they were built to do;
// how people really phrase things, in any language, is Bench-A-R's question, with a real model.
// Clips: 1 talk (speech), 2 beach, 3 city (labelled "harbour"), 4 outro, 5 song, 6 narration.

const S = (more = {}) => ({ asset: "a1", use: "story", ...more })
const W = (n, more = {}) => ({ asset: `a${n}`, use: "whole", ...more })
const O = (n, host, at) => ({ asset: `a${n}`, use: "over", at: { part: host, ...at } })
const M = (n) => ({ asset: `a${n}`, use: "sound" })
const FLICKS = 705_600_000

// Helpers for what a split or a stretch must be, from the index alone
const halves = (w, place) => splitAt(S(), place, { index: w.index, clip: clipList(w.project, w.index)[0] })
const wordOf = (w, text) => w.index.words.find((x) => x.asset === "a1" && x.text === text).id
const sentenceOf = (w, text) => w.index.sentences.find((s) => s.asset === "a1" && w.index.words.some((x) => x.id === wordOf(w, text) && x.start >= s.start && x.end <= s.end))
const neighbour = (w, id, by) => {
  const words = w.index.words.filter((x) => x.asset === "a1")
  return words[words.findIndex((x) => x.id === id) + by].id
}

/** say: the words; point: the same with mentions, [text, clip numbers]; expect: the parts, `at.part` as a place in the list. */
const CASES = [
  { say: "clip 3 first, then clip 1, then clip 2, then clip 4", point: ["⟦1⟧ first, then ⟦2⟧, then ⟦3⟧, then ⟦4⟧", [3, 1, 2, 4]], expect: () => [W(3), S(), W(2), W(4)] },
  { say: "clip 4 first", point: ["⟦1⟧ first", [4]], expect: () => [W(4), S(), W(2), W(3)] },
  { say: "put clip 2 at the end", point: ["put ⟦1⟧ at the end", [2]], expect: () => [S(), W(3), W(4), W(2)] },
  { say: "start with clip 3 and end with clip 2", point: ["start with ⟦1⟧ and end with ⟦2⟧", [3, 2]], expect: () => [W(3), S(), W(4), W(2)] },
  { say: "clip 2 before clip 1", point: ["⟦1⟧ before ⟦2⟧", [2, 1]], expect: () => [W(2), S(), W(3), W(4)] },
  { say: "clip 1 after clip 3", point: ["⟦1⟧ after ⟦2⟧", [1, 3]], expect: () => [W(2), W(3), S(), W(4)] },
  { say: "put clip 4 between clip 1 and clip 2", point: ["put ⟦1⟧ between ⟦2⟧ and ⟦3⟧", [4, 1, 2]], expect: () => [S(), W(4), W(2), W(3)] },
  { say: "use only clips 2 and 4", point: ["use only ⟦1⟧ and ⟦2⟧", [2, 4]], expect: () => [W(2), W(4)] },
  { say: "use only clips 4, 3 and 2", point: ["use only ⟦1⟧, ⟦2⟧ and ⟦3⟧", [4, 3, 2]], expect: () => [W(4), W(3), W(2)] },
  { say: "don't use clip 3", point: ["don't use ⟦1⟧", [3]], expect: () => [S(), W(2), W(4)] },
  { say: "leave out clips 2 and 3", point: ["leave out ⟦1⟧ and ⟦2⟧", [2, 3]], expect: () => [S(), W(4)] },
  { say: "clips 2, 3 and 4 in that order, without clip 1", point: ["⟦1⟧, ⟦2⟧ and ⟦3⟧ in that order, without ⟦4⟧", [2, 3, 4, 1]], expect: () => [W(2), W(3), W(4)] },
  { say: "the 2nd video first", point: ["⟦1⟧ goes first", [2]], expect: () => [W(2), S(), W(3), W(4)] },
  { say: "the third clip at the end", point: ["⟦1⟧ at the end", [3]], expect: () => [S(), W(2), W(4), W(3)] },
  { say: "put clip 2 in the middle of clip 1", point: ["put ⟦1⟧ in the middle of ⟦2⟧", [2, 1]], expect: (w) => [halves(w, { where: "middle" })[0], W(2), halves(w, { where: "middle" })[1], W(3), W(4)] },
  { say: "insert clip 3 into clip 1 after I say fifty thousand", point: ["insert ⟦1⟧ into ⟦2⟧ after I say fifty thousand", [3, 1]], expect: (w) => [halves(w, { word: wordOf(w, "fifty") })[0], W(3), halves(w, { word: wordOf(w, "fifty") })[1], W(2), W(4)] },
  { say: "show clip 2 over clip 1 while I say fifty thousand", point: ["show ⟦1⟧ over ⟦2⟧ while I say fifty thousand", [2, 1]], expect: (w) => [S(), W(3), W(4), O(2, 0, { word: wordOf(w, "fifty") })] },
  { say: "play clip 3 over the voice at the end", point: ["play ⟦1⟧ over the voice at the end", [3]], expect: () => [S(), W(2), W(4), O(3, 0, { where: "end" })] },
  { say: "clip 4 over clip 1 at the start", point: ["⟦1⟧ over ⟦2⟧ at the start", [4, 1]], expect: () => [S(), W(2), W(3), O(4, 0, { where: "start" })] },
  { say: "clip 2 over clip 1 in the middle", point: ["⟦1⟧ over ⟦2⟧ in the middle", [2, 1]], expect: () => [S(), W(3), W(4), O(2, 0, { where: "middle" })] },
  { say: "use the song under everything", point: ["use ⟦1⟧ under everything", [5]], expect: () => [S(), W(2), W(3), W(4), M(5)] },
  { say: "clip 5 as the music, and clip 4 first", point: ["⟦1⟧ as the music, and ⟦2⟧ first", [5, 4]], expect: () => [W(4), S(), W(2), W(3), M(5)] },
  { say: "clip 6 as the voice-over, and use only clips 2 and 3", point: ["⟦1⟧ as the voice-over, and use only ⟦2⟧ and ⟦3⟧", [6, 2, 3]], expect: () => [W(2), W(3), M(6)] },
  { say: "start with the outro", point: ["start with ⟦1⟧", [4]], expect: () => [W(4), S(), W(2), W(3)] },
  { say: "end with the beach", point: ["end with ⟦1⟧", [2]], expect: () => [S(), W(3), W(4), W(2)] },
  { say: "beach, then city, then the talk, then outro", point: ["⟦1⟧, then ⟦2⟧, then ⟦3⟧, then ⟦4⟧", [2, 3, 1, 4]], expect: () => [W(2), W(3), S(), W(4)] },
  { say: "put the harbor first", point: ["put ⟦1⟧ first", [3]], expect: () => [W(3), S(), W(2), W(4)] },
  { say: "the song under everything and the talking clip last", point: ["⟦1⟧ under everything and ⟦2⟧ last", [5, 1]], expect: () => [W(2), W(3), W(4), S(), M(5)] },
  { say: "after clip 2 comes clip 4", point: ["after ⟦1⟧ comes ⟦2⟧", [2, 4]], expect: () => [S(), W(2), W(4), W(3)] },
  { say: "clip 3 goes first and clip 1 goes last", point: ["⟦1⟧ goes first and ⟦2⟧ goes last", [3, 1]], expect: () => [W(3), W(2), W(4), S()] },
  {
    say: "start with where I talk about fifty thousand rupees",
    point: (w) => ["start with ⟦1⟧", [{ asset: "a1", from: sentenceOf(w, "fifty").start, to: sentenceOf(w, "fifty").end }]],
    // The stretch moves to the front; what was before it and after it stays, so nothing plays twice
    expect: (w, form) => {
      const s = sentenceOf(w, "fifty")
      if (form === "mentions") return [S({ from: s.start, to: s.end }), S({ to: s.start }), S({ from: s.end }), W(2), W(3), W(4)]
      return [S({ from: { word: s.firstWord, edge: "start" }, to: { word: s.lastWord, edge: "end" } }), S({ to: { word: neighbour(w, s.firstWord, -1), edge: "end" } }), S({ from: { word: neighbour(w, s.lastWord, 1), edge: "start" } }), W(2), W(3), W(4)]
    },
  },
  { say: "clip 2 then clip 3, and leave out clip 4", point: ["⟦1⟧ then ⟦2⟧, and leave out ⟦3⟧", [2, 3, 4]], expect: () => [W(2), W(3), S()] },
  { say: "clip 4, clip 3, clip 2, clip 1", point: ["⟦1⟧, ⟦2⟧, ⟦3⟧, ⟦4⟧", [4, 3, 2, 1]], expect: () => [W(4), W(3), W(2), S()] },
  { say: "put clip 3 right after clip 1", point: ["put ⟦1⟧ right after ⟦2⟧", [3, 1]], expect: () => [S(), W(3), W(2), W(4)] },
  { say: "clip 2 over clip 1 at 0:05", point: ["⟦1⟧ over ⟦2⟧ at 0:05", [2, 1]], expect: () => [S(), W(3), W(4), O(2, 0, { t: 5 * FLICKS })] },
  { say: "use only clip 1 and clip 3, with the song as the music", point: ["use only ⟦1⟧ and ⟦2⟧, with ⟦3⟧ as the music", [1, 3, 5]], expect: () => [S(), W(3), M(5)] },
  { say: "clip 3 first, clip 2 last", point: ["⟦1⟧ first, ⟦2⟧ last", [3, 2]], expect: () => [W(3), S(), W(4), W(2)] },
  // Nothing about the order in the words: the Director's slot orders them, and code checks its answer
  { say: "make one film from all of these", model: { parts: [{ clip: 2, use: "whole", reason: "opens on the beach" }, { clip: 1, use: "story", reason: "the talk" }, { clip: 3, use: "whole", reason: "the city" }, { clip: 4, use: "whole", reason: "ends on the outro" }] }, point: ["⟦1⟧, then ⟦2⟧, then ⟦3⟧, then ⟦4⟧", [2, 1, 3, 4]], expect: () => [W(2), S(), W(3), W(4)] },
  // A clip that doesn't exist is left open; the Director settles it and must keep what the person fixed
  { say: "clip 9 first, and clip 3 last", model: { parts: [{ clip: 4, use: "whole", reason: "a strong open" }, { clip: 1, use: "story", reason: "the talk" }, { clip: 2, use: "whole", reason: "the beach" }, { clip: 3, use: "whole", reason: "fixed last" }] }, point: ["⟦1⟧ first, and ⟦2⟧ last", [4, 3]], expect: () => [W(4), S(), W(2), W(3)] },
  { say: "put clip 2 in the middle of clip 1 and use the song under everything, without clip 4", point: ["put ⟦1⟧ in the middle of ⟦2⟧ and use ⟦3⟧ under everything, without ⟦4⟧", [2, 1, 5, 4]], expect: (w) => [halves(w, { where: "middle" })[0], W(2), halves(w, { where: "middle" })[1], W(3), M(5)] },
]

// Expected parts as a real assembly: `at.part` a place in the list becomes that part's id
const asAssembly = (parts) => {
  const made = withIds(parts.map(({ at: _at, ...part }) => part))
  return { version: 1, parts: made.map((part, i) => (parts[i].at ? { ...part, at: { ...parts[i].at, part: made[parts[i].at.part].id } } : part)) }
}
const alike = (a, b) => JSON.stringify(essence(a.parts)) === JSON.stringify(essence(b.parts))

test("Bench-A-M: 40 assembly requests as a storyboard, as mentions and as words; each film checked by QG-15 against the expected order", { timeout: 1_500_000 }, async () => {
  assert.equal(CASES.length, 40)
  const w = await world({ clips: { beach: [150, 1000], city: [60, 2000], outro: [90, 3000] }, song: true, told: true })
  w.project = apply(w.project, [{ op: "describe_asset", asset: "a3", label: "harbour" }], { author: "person" }).project
  const films = new Map() // one render per different assembly
  const verdictOf = async (assembly, expected) => {
    const key = JSON.stringify(essence(assembly.parts))
    if (!films.has(key)) films.set(key, await film(w, assembly))
    return films.get(key).gate(undefined, expected)
  }
  const score = { storyboard: 0, mentions: 0, words: 0 }
  const how = { code: 0, director: 0 }
  const failures = []
  for (const [i, item] of CASES.entries()) {
    const point = typeof item.point === "function" ? item.point(w) : item.point
    const asked = []
    const ask = item.model ? async (slot) => (asked.push(slot.task), slot.check(item.model).length ? { value: null, source: "default", reason: slot.check(item.model)[0], calls: 1 } : { value: item.model, source: "model", calls: 1 }) : null
    const forms = {
      storyboard: () => decideAssembly({ project: w.project, index: w.index, text: "", storyboard: asAssembly(item.expect(w, "storyboard")) }),
      mentions: () => decideAssembly({ project: w.project, index: w.index, text: point[0], mentions: point[1].map((m) => (typeof m === "number" ? { asset: `a${m}` } : m)) }),
      words: () => decideAssembly({ project: w.project, index: w.index, text: item.say, ask }),
    }
    for (const [form, decide] of Object.entries(forms)) {
      const expected = asAssembly(item.expect(w, form))
      const decided = await decide()
      const same = decided.assembly && alike(decided.assembly, expected)
      const gate = same ? await verdictOf(decided.assembly, expected) : null
      if (same && gate.status === "passed") {
        score[form]++
        if (form === "words") how[asked.length ? "director" : "code"]++
      } else failures.push(`${i + 1} ${form}: ${JSON.stringify(form === "words" ? item.say : point[0])} → ${!decided.assembly ? `no assembly (${decided.lines.join(" ")})` : !same ? `made ${JSON.stringify(essence(decided.assembly.parts).map((p) => `${p.asset}/${p.use}`))}, expected ${JSON.stringify(essence(expected.parts).map((p) => `${p.asset}/${p.use}`))}` : `QG-15 ${gate.status}: ${gate.message}`}`)
      // Code alone read these: a form with no model must never have asked one
      if (form !== "words" || !item.model) assert.deepEqual(asked, [], `case ${i + 1} ${form} asked a model`)
    }
  }
  const line = `BENCH-A-M: storyboard ${score.storyboard}/40, mentions ${score.mentions}/40, words ${score.words}/40 (${how.code} by code alone, ${how.director} with the scripted Director); ${films.size} films rendered, each read by QG-15`
  console.log(`${line}${failures.length ? `\nBENCH-A-M failures:\n${failures.join("\n")}` : ""}`)
  const dir = join(ROOT, "bench", "edit", "results")
  mkdirSync(dir, { recursive: true })
  const date = new Date().toISOString().slice(0, 10)
  writeFileSync(join(dir, `bench-a-m-${date}.md`), `# Bench-A-M, ${date}\n\nNode ${process.version}, ${process.platform}-${process.arch}. A scripted model on synthetic, barcoded files. The words are ones the code readers were written against: this says the readers do what they were built to do, not how well people are understood (that is Bench-A-R, on a real model, with the owner's go-ahead).\n\n\`\`\`text\n${line}\n${failures.join("\n")}\n\`\`\`\n`)
  assert.deepEqual([score.storyboard, score.mentions], [40, 40], "the storyboard and mention forms are code: 40 of 40")
  assert.ok(score.words >= 36, `words ${score.words}/40`)
})
