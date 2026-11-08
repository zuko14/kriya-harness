// QG-04 Round-trip speech and QG-14 Blind reviewer (QUALITY_GATES §2, EDD-20, ED10).
// QG-04 listens to its own output and aligns what it heard with the words the plan
// keeps and the words it removed. QG-14 lets a model hear only what a viewer gets and
// say what the video is about; code compares that with the brief, and it can only add
// a note: a model's text never changes a verdict (ET-QG-20).

import { busOf } from "../core/audio.js"
import { scaleFlicks } from "../core/time.js"
import { normalise } from "./copy.js"

const FLICKS = 705_600_000

/** The words the plan keeps, in output order, and the ones it removed, from the index. */
export function expectedWords(plan, words) {
  const kept = []
  const keptIds = new Set()
  for (const item of plan.audio.items) {
    if (busOf(item.role) !== "dialogue") continue
    const rate = { n: item.speed?.d ?? 1, d: item.speed?.n ?? 1 }
    for (const w of words) {
      if (w.asset !== item.asset || w.start < item.in || w.end > item.out) continue
      kept.push({ ...w, at: item.at + scaleFlicks(w.start - item.in, rate) })
      keptIds.add(w.id)
    }
  }
  kept.sort((a, b) => a.at - b.at)
  const assets = new Set(plan.audio.items.filter((i) => busOf(i.role) === "dialogue").map((i) => i.asset))
  const removed = words.filter((w) => assets.has(w.asset) && !keptIds.has(w.id))
  return { kept, removed }
}

const token = (text) => normalise(text).replace(/ /g, "")
const STOP = new Set("the a an and or but of to in on for with is are was were it this that we you i our they them at as by be so if from".split(" "))
// Recognisers differ on small words and on a letter here and there: a word of 4 or more letters matches within one edit
function same(a, b) {
  if (a === b) return true
  if (a.length < 4 || b.length < 4 || Math.abs(a.length - b.length) > 1) return false
  let i = 0
  let j = 0
  let edits = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++
      j++
      continue
    }
    if (++edits > 1) return false
    if (a.length > b.length) i++
    else if (b.length > a.length) j++
    else {
      i++
      j++
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1
}

/** Longest common subsequence of two token lists: which of `a` were heard, in order. */
function align(a, b) {
  const n = a.length
  const m = b.length
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = same(a[i], b[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const matchedA = new Set()
  const matchedB = new Set()
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (same(a[i], b[j])) {
      matchedA.add(i++)
      matchedB.add(j++)
    } else if (L[i + 1][j] >= L[i][j + 1]) i++
    else j++
  }
  return { matchedA, matchedB }
}

/**
 * @param {{ kept: object[], removed: object[] }} expected
 * @param {{ text: string, start: number }[]} heard the recogniser's words on the output
 */
export function judgeSpeech(expected, heard) {
  const keptTokens = expected.kept.map((w) => token(w.text))
  const heardTokens = heard.map((w) => token(w.text))
  const { matchedA, matchedB } = align(keptTokens, heardTokens)
  const failures = []
  // A kept word missing: ignore short words and function words, which recognisers drop or swap
  // shortcut: an untuned list, English only; EX-11's real-speech check sets it per language
  expected.kept.forEach((w, i) => {
    if (!matchedA.has(i) && keptTokens[i].length > 2 && !STOP.has(keptTokens[i])) failures.push({ kind: "kept_word_missing", t: w.at, seconds: Math.round((w.at / FLICKS) * 100) / 100, word: w.text })
  })
  // A removed word audible: heard, matched to nothing kept, and it is one of the removed words
  const keptSet = new Set(keptTokens)
  heard.forEach((w, j) => {
    if (matchedB.has(j)) return
    const t = heardTokens[j]
    if (t.length < 3 || keptSet.has(t)) return
    if (expected.removed.some((r) => same(token(r.text), t))) failures.push({ kind: "removed_word_audible", t: w.start, seconds: Math.round((w.start / FLICKS) * 100) / 100, word: w.text })
  })
  // Order: words that are all there, but heard in another order, align short
  const bag = new Map()
  for (const t of heardTokens) bag.set(t, (bag.get(t) ?? 0) + 1)
  let present = 0
  for (const t of keptTokens) if ((bag.get(t) ?? 0) > 0) {
    present++
    bag.set(t, bag.get(t) - 1)
  }
  if (present - matchedA.size >= 2) failures.push({ kind: "order_wrong", t: 0, seconds: 0, present, inOrder: matchedA.size })
  return { failures, numbers: { kept: expected.kept.length, heard: heard.length, matched: matchedA.size } }
}

/* ─────────────────────────────── QG-14 ─────────────────────────────── */

export const REVIEWER_SCHEMA = { type: "object", properties: { about: { type: "string", maxLength: 300 } }, required: ["about"], additionalProperties: false }

const contentWords = (text) => new Set(normalise(text).split(" ").filter((w) => w.length > 2 && !STOP.has(w)))

/**
 * Code's comparison: does the reviewer's one sentence share any content word with the
 * lines the brief names (must-keeps, or the opening line)? Never a failure, only a note.
 */
export function judgeReview(about, keyLines) {
  const said = contentWords(about)
  const key = new Set(keyLines.flatMap((line) => [...contentWords(line)]))
  const shared = [...key].filter((w) => said.has(w))
  return { note: key.size > 0 && shared.length === 0, numbers: { shared: shared.length, keyWords: key.size } }
}
