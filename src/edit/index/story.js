// The story tree (PERCEPTION_AND_INDEX §8): sentence → beat → scene → act, so a long
// recording is read once and the Director descends only where it needs to. Built by
// code with no model call: beats split at pauses, speaker changes and a size cap;
// scenes at topic shifts (TextTiling depth over sentence vectors, plus long pauses);
// acts by where scenes sit in the running time. Every summary is the transcript's own
// sentences, by id, so a claim can be traced to its words (ET-IDX-06).
// Beat summaries are cached by their content: an unchanged chunk is never read again.

import { createHash } from "node:crypto"

import { openingStrength } from "../recipes/short-from-long.js"

const FLICKS = 705_600_000
export const STORY_VERSION = "story-1"
export const STORY = {
  pause: 2 * FLICKS, // a pause this long ends a beat
  longPause: 4 * FLICKS, // and this long counts toward a scene break
  beatMax: 8, // sentences
  window: 6, // sentences either side when comparing topics
  depth: 0.25, // TextTiling depth a scene break needs
  sceneMin: 45 * FLICKS,
  quotes: 3,
}

const DIMS = 256
const STOPWORDS = new Set("that this with have from they what there about which would their just like more than then when your were been into only also very here some them will because really thing things know think going want said does make made well even much many most other over such these those where while after before every could should being".split(" "))

const sha = (text) => createHash("sha256").update(text).digest("hex")
const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0)

function centroid(vectors) {
  const c = new Array(DIMS).fill(0)
  for (const v of vectors) for (let i = 0; i < DIMS; i++) c[i] += v[i]
  const norm = Math.hypot(...c)
  return norm ? c.map((x) => x / norm) : c
}

const wordsOf = (text) => (text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []).filter((w) => w.length >= 4 && !STOPWORDS.has(w))
const stem = (word) => word.replace(/(ing|ed|es|s)$/, "")

/**
 * Sentence vectors: content words hashed into 256 dims, weighted by how rare each is in
 * this recording (idf), so the speaker's habits ("the real reason") don't read as a topic.
 * shortcut: lexical, so synonyms don't meet; L11's embeddings replace it when that layer is built
 */
function vectorsOf(texts) {
  const bags = texts.map((t) => wordsOf(t).map(stem))
  const df = new Map()
  for (const bag of bags) for (const w of new Set(bag)) df.set(w, (df.get(w) ?? 0) + 1)
  return bags.map((bag) => {
    const v = new Array(DIMS).fill(0)
    for (const w of bag) {
      let h = 2166136261
      for (const c of w) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
      v[(h >>> 0) % DIMS] += Math.log(texts.length / df.get(w))
    }
    const norm = Math.hypot(...v)
    return norm ? v.map((x) => x / norm) : v
  })
}

const lineOf = (text) => ({ words: text.split(/\s+/).filter(Boolean).map((t) => ({ text: t })) })
const finished = (text) => /[.!?]["')]?$/.test(text.trim())

/** The asset's sentences in time order, with their text and speaker. */
export function sentencesOf(index, asset) {
  const words = index.words.filter((w) => w.asset === asset)
  const at = new Map(words.map((w, i) => [w.id, i]))
  return index.sentences
    .filter((s) => s.asset === asset && at.has(s.firstWord) && at.has(s.lastWord))
    .sort((a, b) => a.start - b.start)
    .map((s) => {
      const list = words.slice(at.get(s.firstWord), at.get(s.lastWord) + 1)
      return { id: s.id, start: s.start, end: s.end, firstWord: s.firstWord, text: list.map((w) => w.text).join(" "), speaker: s.speaker ?? list[0]?.speaker ?? null }
    })
}

function beatsOf(sentences, rules) {
  const beats = []
  let current = []
  sentences.forEach((s, i) => {
    const prev = sentences[i - 1]
    if (prev && (s.start - prev.end >= rules.pause || s.speaker !== prev.speaker || current.length >= rules.beatMax)) {
      beats.push(current)
      current = []
    }
    current.push(s)
  })
  if (current.length) beats.push(current)
  return beats
}

/** What a chunk says, from its own sentences: content-word counts and its quotable lines. */
function readChunk(sentences) {
  const terms = {}
  for (const s of sentences) for (const word of wordsOf(s.text)) terms[word] = (terms[word] ?? 0) + 1
  const quotable = sentences
    .map((s) => ({ sentence: s.id, strength: openingStrength(lineOf(s.text)), finished: finished(s.text) }))
    .filter((q) => q.strength >= 0.75 && q.finished)
    .map(({ sentence, strength }) => ({ sentence, standsAlone: strength > 0 }))
  return { terms, quotable }
}

// TextTiling depth: how far the similarity at a boundary sits below the peaks either side
function depths(sims) {
  return sims.map((sim, i) => {
    let left = sim
    for (let j = i - 1; j >= 0 && sims[j] >= left; j--) left = sims[j]
    let right = sim
    for (let j = i + 1; j < sims.length && sims[j] >= right; j++) right = sims[j]
    return left - sim + (right - sim)
  })
}

const titleCase = (word) => word.charAt(0).toUpperCase() + word.slice(1)

/**
 * @param {{ words: object[], sentences: object[] }} index
 * @param {string} asset
 * @param {{ cache?: { get(key: string): any, set(key: string, value: any): any }, rules?: typeof STORY }} [options]
 * @returns {{ version: string, asset: string, key: string, acts: object[], scenes: object[], beats: object[], stats: { sentences: number, computed: number, cached: number } }}
 */
export function storyTree(index, asset, { cache = new Map(), rules = STORY } = {}) {
  const sentences = sentencesOf(index, asset)
  const vectors = vectorsOf(sentences.map((s) => s.text))
  const position = new Map(sentences.map((s, i) => [s.id, i]))
  const stats = { sentences: sentences.length, computed: 0, cached: 0 }

  // Scene breaks fall between sentences where the topic shifts
  const sims = sentences.slice(1).map((_, i) => dot(centroid(vectors.slice(Math.max(0, i + 1 - rules.window), i + 1)), centroid(vectors.slice(i + 1, i + 1 + rules.window))))
  const pauseAt = (i) => (sentences[i + 1].start - sentences[i].end >= rules.longPause ? 0.1 : 0)
  const scores = depths(sims).map((d, i) => d + pauseAt(i))
  // A valley can be flat; depth favours its edge, so a break slides to the lowest point within two sentences
  const floorNear = (i) => {
    let best = i
    for (let j = Math.max(0, i - 2); j <= Math.min(sims.length - 1, i + 2); j++) if (sims[j] - pauseAt(j) < sims[best] - pauseAt(best)) best = j
    return best
  }
  const cuts = []
  const lengthOk = (from, to) => sentences[to - 1].end - sentences[from].start >= rules.sceneMin
  for (const i of scores.map((_, i) => i).sort((a, b) => scores[b] - scores[a] || a - b)) {
    if (scores[i] < rules.depth) break
    const at = floorNear(i) + 1 // the first sentence of the new scene
    if (cuts.includes(at)) continue
    const left = Math.max(0, ...cuts.filter((c) => c < at))
    const right = Math.min(sentences.length, ...cuts.filter((c) => c > at))
    if (lengthOk(left, at) && lengthOk(at, right)) cuts.push(at)
  }
  const edges = [0, ...cuts.sort((a, b) => a - b), sentences.length]

  // Beats inside each scene, never across a break
  const beats = []
  const groups = edges.slice(1).map((end, i) =>
    beatsOf(sentences.slice(edges[i], end), rules).map((list) => {
      const key = sha(`${STORY_VERSION}\n${list.map((s) => `${s.id}\t${s.text}`).join("\n")}`)
      let read = cache.get(key)
      if (read) stats.cached++
      else {
        read = readChunk(list)
        cache.set(key, read)
        stats.computed++
      }
      const beat = { id: `${asset}:b${beats.length}`, level: "beat", key, sentences: list.map((s) => s.id), from: list[0].id, to: list.at(-1).id, start: list[0].start, end: list.at(-1).end, ...read }
      beats.push(beat)
      return beat
    }),
  )

  // A scene's title: its two most distinctive words against the other scenes (tf-idf)
  const termsOf = (group) => group.reduce((all, b) => (Object.entries(b.terms).forEach(([w, n]) => (all[w] = (all[w] ?? 0) + n)), all), {})
  const sceneTerms = groups.map(termsOf)
  const seenIn = (word) => sceneTerms.filter((t) => t[word]).length
  const scenes = groups.map((group, n) => {
    const terms = sceneTerms[n]
    const topics = Object.keys(terms)
      .map((w) => [w, terms[w] * Math.log((1 + groups.length) / seenIn(w))])
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 3)
      .map(([w]) => w)
    const ids = group.flatMap((b) => b.sentences)
    const centre = centroid(ids.map((id) => vectors[position.get(id)]))
    const central = ids.slice(1).sort((a, b) => dot(vectors[position.get(b)], centre) - dot(vectors[position.get(a)], centre) || position.get(a) - position.get(b))[0]
    const summary = [ids[0], ...(central ? [central] : [])].map((id) => ({ sentence: id, text: sentences[position.get(id)].text }))
    return {
      id: `${asset}:sc${n}`,
      level: "scene",
      title: topics.slice(0, 2).map(titleCase).join(" and ") || `Part ${n + 1}`,
      topics,
      from: ids[0],
      to: ids.at(-1),
      start: group[0].start,
      end: group.at(-1).end,
      summary,
      quotable: group.flatMap((b) => b.quotable).slice(0, rules.quotes),
      children: group.map((b) => b.id),
    }
  })

  // Acts: opening, body and close by where each scene's middle falls
  const [first, last] = [sentences[0]?.start ?? 0, sentences.at(-1)?.end ?? 0]
  const actOf = (scene) => {
    const middle = ((scene.start + scene.end) / 2 - first) / Math.max(1, last - first)
    return middle < 0.25 ? 0 : middle > 0.75 ? 2 : 1
  }
  const acts = ["Opening", "Body", "Close"]
    .map((title, n) => ({ title, scenes: scenes.filter((s) => actOf(s) === n) }))
    .filter((a) => a.scenes.length)
    .map(({ title, scenes: list }, n) => ({ id: `${asset}:act${n}`, level: "act", title, from: list[0].from, to: list.at(-1).to, start: list[0].start, end: list.at(-1).end, topics: [...new Set(list.flatMap((s) => s.topics))].slice(0, 5), summary: list.map((s) => s.summary[0]), children: list.map((s) => s.id) }))

  const strip = ({ terms: _, ...beat }) => beat
  return { version: STORY_VERSION, asset, key: sha(beats.map((b) => b.key).join("")), acts, scenes, beats: beats.map(strip), stats }
}

/** YouTube's chapter time: m:ss under an hour (two-digit minutes, as "00:00"), h:mm:ss over. */
export function chapterTime(t) {
  const s = Math.floor(t / FLICKS)
  const [h, m, sec] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
  const two = (n) => String(n).padStart(2, "0")
  return h ? `${h}:${two(m)}:${two(sec)}` : `${two(m)}:${two(sec)}`
}

/**
 * Chapters from the scenes, on the cut's own timeline. `placeOf(sentenceId)` gives where
 * a sentence starts on the timeline, or null if it was cut. YouTube's rules: the first at
 * 00:00, at least three, each at least ten seconds; a short one folds into the one before.
 * @returns {{ chapters: { at: number, title: string, scene: string }[], note?: string }}
 */
export function chapters(tree, placeOf, { duration, min = 3, minLength = 10 * FLICKS } = {}) {
  const found = []
  for (const scene of tree.scenes) {
    const at = scene.children
      .flatMap((id) => tree.beats.find((b) => b.id === id).sentences)
      .map(placeOf)
      .find((t) => t !== null && t !== undefined)
    if (at !== undefined && (!found.length || at > found.at(-1).at)) found.push({ at, title: scene.title, scene: scene.id })
  }
  if (!found.length) return { chapters: [], note: "No scene is in the cut, so there are no chapters." }
  found[0] = { ...found[0], at: 0, title: "Intro" }
  const kept = []
  // A short one, or one named like the one before, folds into it
  for (const c of found) if (!kept.length || (c.at - kept.at(-1).at >= minLength && c.title !== kept.at(-1).title)) kept.push(c)
  if (duration !== undefined && kept.length > 1 && duration - kept.at(-1).at < minLength) kept.pop()
  if (kept.length < min) return { chapters: [], note: `Only ${kept.length} chapter${kept.length === 1 ? "" : "s"} of ten seconds or more; YouTube needs ${min}, so none are written.` }
  return { chapters: kept }
}

/** The list a person pastes into a YouTube description. */
export const chapterList = (list) => list.map((c) => `${chapterTime(c.at)} ${c.title}`).join("\n")
