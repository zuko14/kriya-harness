// A long synthetic talk for ED11's short-from-long: blocks on one subject each, some
// split by long pauses, some running straight on, with an L8 subject drifting across
// a 16:9 frame. Times are made here, so a test knows where every word is. No real speech.

import { analyseDelivery } from "../../src/edit/index/layers/retakes.js"
import { prng } from "./fixture.js"

const FLICKS = 705_600_000
const sec = (s) => Math.round(s * FLICKS)

/** The drawn face's centre at source second t (media tests draw it; the index tracks it). */
export const faceX = (t, width = 1920) => Math.round(width / 2 + width * 0.18 * Math.sin(t / 20))

const NOUNS = ["pricing", "invoice", "kitchen", "garlic", "monsoon", "harvest", "cricket", "stadium", "violin", "melody", "rocket", "orbit", "garden", "compost", "server", "database", "camera", "lens", "bicycle", "mountain", "market", "spices", "teacher", "classroom", "river", "bridge", "coffee", "roaster", "festival", "lantern", "engine", "piston", "library", "archive", "ferry", "harbour", "pottery", "kiln", "tailor", "fabric"]
const OPENERS = ["Here is what nobody tells you about the", "The real reason the", "Most people get the", "I spent three years learning how the", "There are 3 things to know about the"]
const MIDDLES = ["changed how we handle the", "quietly decides every", "only works when the", "costs far more than a", "matters more than any"]
const ENDINGS = ["and that is the whole lesson.", "so plan for it early.", "which surprised everyone in the room.", "and you can see it in the numbers.", "so we rebuilt it from scratch."]
const LEANERS = ["And then the", "So the", "But the", "It turned out the", "That is why the"]

/** A long talk; `face` sets the subject track's frame width and box width. */
export function longTalk(minutes, seed = 1, face = { width: 1920, w: 220 }) {
  const random = prng(seed)
  const pick = (list) => list[Math.floor(random() * list.length)]
  const lines = []
  for (let block = 0, t = 1; t < minutes * 60; block++) {
    const [a, b] = [NOUNS[(block * 2) % NOUNS.length], NOUNS[(block * 2 + 1) % NOUNS.length]]
    const topic = [`${a}${block}`, `${b}${block}`, `${a}${block}`]
    for (let s = 0; s < 12; s++) {
      const head = s === 0 || random() < 0.6 ? pick(OPENERS) : pick(LEANERS)
      lines.push({ block, gap: s === 0 && block % 2 === 0 ? 5 : 0.9, text: `${head} ${topic[s % 3]} ${pick(MIDDLES)} ${topic[(s + 1) % 3]} ${pick(ENDINGS)}` })
      t += lines.at(-1).text.split(" ").length * 0.5 + lines.at(-1).gap
    }
  }
  const words = []
  let t = 1
  for (const line of lines) {
    t += line.gap - 0.1
    for (const text of line.text.split(" ")) {
      words.push({ n: words.length, text, start: sec(t), end: sec(t + 0.4), conf: 0.95, block: line.block })
      t += 0.5
    }
  }
  const { flags, sentences, takes } = analyseDelivery(words)
  const asset = "a1"
  const duration = words.at(-1).end + FLICKS
  return {
    duration,
    blockOf: new Map(words.map((w) => [`${asset}:w${w.n}`, w.block])),
    index: {
      words: words.map((w, i) => ({ id: `${asset}:w${w.n}`, asset, start: w.start, end: w.end, text: w.text, conf: w.conf, flags: [...new Set(flags[i])] })),
      sentences: sentences.map((s, n) => ({ id: `${asset}:s${n}`, asset, start: s.start, end: s.end, firstWord: `${asset}:w${s.first}`, lastWord: `${asset}:w${s.last}`, takeGroup: s.group === null ? null : `${asset}:g${s.group}`, score: s.score })),
      takes: takes.map((k) => ({ group: `${asset}:g${k.group}`, sentence: `${asset}:s${k.sentence}`, rank: k.rank, signals: k.signals })),
      shots: [{ id: "a1:sh0", asset, start: 0, end: duration }],
      faces: [],
      silences: [],
      timestamps: {},
      subjects: { a1: Array.from({ length: Math.floor(duration / (FLICKS / 2)) }, (_, i) => ({ t: (i * FLICKS) / 2, x: faceX(i / 2, face.width), w: face.w, shot: "a1:sh0" })) },
    },
  }
}
