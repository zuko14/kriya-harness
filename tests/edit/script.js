// A synthetic raw take for the Director and the reel recipe: twelve lines with a
// cut-off attempt, a restart phrase, fillers, a stutter and a retake. Times are
// made here, so a test knows exactly where every word is. No real speech.

import { analyseDelivery } from "../../src/edit/index/layers/retakes.js"

const FLICKS = 705_600_000
export const WORD = 0.4
export const GAP = 0.1
export const LINE_GAP = 0.9

export const LINES = [
  "Okay so um today I want to show you how we built this.",
  "We built the whole thing in a",
  "Sorry, let me try that again.",
  "We built the whole thing in a week.",
  "It cost us fifty thousand rupees in total.",
  "Uh, the the hardest part was the design.",
  "The hardest part was the design.",
  "Our users loved it and they told their friends.",
  "That is why we grew so fast this year.",
  "If you want to build something like this, start small.",
  "Start small, ship fast, and listen to your users.",
  "Thanks for watching, and see you next time.",
]

/** Words with times in seconds (as decimals, as the recogniser prints them). */
export function heard(lines = LINES, start = 1) {
  const words = []
  let t = start
  for (const line of lines) {
    for (const text of line.split(" ")) {
      words.push({ text, s: t, e: t + WORD })
      t += WORD + GAP
    }
    t += LINE_GAP - GAP
  }
  return words
}

export const lengthOf = (lines = LINES, start = 1) => {
  const all = heard(lines, start)
  return all.at(-1).e + 1
}

/** The index rows the Host would read for this take, as asset `asset`. */
export function indexOf(asset = "a1", lines = LINES) {
  const words = heard(lines).map((w, n) => ({ n, text: w.text, start: Math.round(w.s * FLICKS), end: Math.round(w.e * FLICKS), conf: 0.95 }))
  const { flags, sentences, takes } = analyseDelivery(words)
  return {
    words: words.map((w, i) => ({ id: `${asset}:w${w.n}`, asset, start: w.start, end: w.end, text: w.text, conf: w.conf, flags: [...new Set(flags[i])] })),
    sentences: sentences.map((s, n) => ({ id: `${asset}:s${n}`, asset, start: s.start, end: s.end, firstWord: `${asset}:w${s.first}`, lastWord: `${asset}:w${s.last}`, takeGroup: s.group === null ? null : `${asset}:g${s.group}`, score: s.score })),
    takes: takes.map((t) => ({ group: `${asset}:g${t.group}`, sentence: `${asset}:s${t.sentence}`, rank: t.rank, signals: t.signals })),
    shots: [],
    faces: [],
    silences: [],
    timestamps: {},
    subjects: {},
  }
}

/** The id of the first word with this exact text. */
export const wordId = (index, text) => index.words.find((w) => w.text === text)?.id
