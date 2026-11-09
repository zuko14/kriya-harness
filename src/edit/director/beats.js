// Visual beats (VISUAL_SCENES.md, EDD-51): which moments of the speech become an explainer
// scene. One model slot proposes them as typed JSON; code decides everything that can be
// decided: the words must have been said, the numbers must have been said here, and each
// scene spans whole sentences of a sensible length. With no model, code's own patterns
// find what they can, and only what they are sure of.

import { cleanScene, FLOW_MODES, SCENE_KINDS, SCENE_THEMES } from "../engine/scenes.js"
import { phraseView } from "../index/views.js"

const FLICKS = 705_600_000
const MIN_SCENE = 2.5 * FLICKS
const MAX_SCENE = 14 * FLICKS
const MIN_GAP = 1.5 * FLICKS
export const MAX_SHARE = 0.65 // of the cut under scenes: the speaker stays part of the film
export const MAX_SCENES = 10

/* ─────────────────────────────── what was said ─────────────────────────────── */

const SMALL = new Set("a an the of to in on at by for from with and or but so if as is are was were be been it its this that these those your you we our their his her they he she i my me not no do does did has have had will would can could should then than very more most into out up down over under about how what why when where which who".split(" "))
const tokens = (text) => String(text).normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}.,%]+/u).map((t) => t.replace(/^[.,]+|[.,]+$/g, "")).filter(Boolean)
// shortcut: English endings only; a label in another language must match the transcript's word as it stands
const stem = (word) => (word.length > 4 ? word.replace(/(?:ing|ed|es|s)$/, "") : word)
const isNumber = (token) => /^\d[\d.,]*%?$/.test(token)
const bare = (token) => token.replace(/%$/, "").replace(/,/g, "")

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]

/** Numbers in spoken words, as digits: "seventy five" → "75", "two hundred" → "200", "a thousand" → "1000". */
export function numbersSaid(text) {
  const out = new Set()
  const words = tokens(text)
  let current = null
  const flush = () => {
    if (current !== null) out.add(String(current))
    current = null
  }
  for (const word of words) {
    if (isNumber(word)) {
      flush()
      out.add(bare(word))
      continue
    }
    const one = ONES.indexOf(word)
    const ten = TENS.indexOf(word)
    if (one >= 0) current = (current ?? 0) + one
    else if (ten >= 2) current = (current ?? 0) + ten * 10
    else if (word === "hundred" || word === "thousand") current = (current ?? 1) * (word === "hundred" ? 100 : 1000)
    else if (!(word === "and" && current !== null)) flush()
  }
  flush()
  return out
}

const UNITS = { "%": /percent|per cent|%/i, mg: /milligram|\bmg\b/i, g: /\bgrams?\b|\bg\b/i, kg: /kilo/i, km: /kilomet/i, m: /\bmet(?:er|re)s?\b/i, cm: /centimet/i, mm: /millimet/i, l: /lit(?:er|re)s?\b/i, ml: /millilit/i, s: /\bseconds?\b/i, min: /\bminutes?\b/i, h: /\bhours?\b/i, x: /\btimes\b/i, "₹": /rupee|₹/i, $: /dollar|\$/ }

/**
 * Why a scene's words aren't the speaker's: every word on screen was said somewhere in the
 * take, and every number was said in or next to this scene's own lines. Nothing else
 * reaches the screen, so a model can't add a fact (a figure, a name) the person never said.
 * @param {object} scene from cleanScene
 * @param {{ all: string, near: string }} said the whole take's text, and this scene's lines with their neighbours
 * @returns {string[]}
 */
export function groundProblems(scene, { all, near }) {
  const problems = []
  const known = new Set(tokens(all).map(stem))
  const numbers = numbersSaid(near)
  const check = (text) => {
    for (const token of tokens(text)) {
      if (isNumber(token)) {
        if (!numbers.has(bare(token))) problems.push(`the number "${token}" isn't said in this scene's lines`)
      } else if (!SMALL.has(token) && !known.has(stem(token))) problems.push(`"${token}" isn't in the speaker's words`)
    }
  }
  check(scene.title)
  for (const item of scene.items) {
    check(item.text)
    if (item.value !== undefined && !numbers.has(item.value.replace(/,/g, ""))) problems.push(`the number "${item.value}" isn't said in this scene's lines`)
    if (item.unit) {
      const cue = UNITS[item.unit.toLowerCase()]
      if (cue ? !cue.test(near) : !known.has(stem(item.unit.toLowerCase()))) problems.push(`the unit "${item.unit}" isn't said in this scene's lines`)
    }
  }
  return problems
}

/* ─────────────────────────────── phrases ─────────────────────────────── */

const MAX_PHRASE = 8 * FLICKS
const MIN_PHRASE = 1.2 * FLICKS
const PAUSE = 0.35 * FLICKS
const CLAUSE = /^(?:so|but|because|where|which|as|then|when|while|resulting|despite|without|until|since|although)$/i

/**
 * A take's phrases: what a scene can start and end on. Recognised speech has few sentence
 * marks (found on a real take: one "sentence" of 29 s, another of 22 s), so a sentence is too
 * coarse; a phrase ends at a sentence end, a pause or a new clause, and caps at 8 s.
 * @returns {{ first: number, last: number, start: number, end: number, text: string }[]} first, last: positions in `words`
 */
export function phrasesOf(index, asset) {
  const words = (index.words ?? []).filter((w) => w.asset === asset)
  const ends = new Set((index.sentences ?? []).filter((s) => s.asset === asset).map((s) => s.lastWord))
  const out = []
  let first = 0
  const close = (last) => {
    out.push({ first, last, start: words[first].start, end: words[last].end, text: words.slice(first, last + 1).map((w) => w.text).join(" ") })
    first = last + 1
  }
  for (let i = 0; i < words.length; i++) {
    const next = words[i + 1]
    if (!next || ends.has(words[i].id)) {
      close(i)
      continue
    }
    const length = words[i].end - words[first].start
    if (next.start - words[i].end >= PAUSE && length >= MIN_PHRASE) close(i)
    else if (CLAUSE.test(tokens(next.text)[0] ?? "") && length >= MIN_PHRASE) close(i)
    else if (next.end - words[first].start > MAX_PHRASE) close(i)
  }
  return out
}

/* ─────────────────────────────── placing ─────────────────────────────── */

const out = (word, cuts) => cuts.some((c) => (word.start + word.end) / 2 >= c.from * FLICKS && (word.start + word.end) / 2 < c.to * FLICKS)
const OPENING = 3 * FLICKS // the speaker is seen first
const NEAR = 6 * FLICKS // "said in or next to this scene's lines"

/**
 * Scenes that may be made, in order: real words, forward, on phrase edges, a sensible length,
 * room between them, under the share, words grounded. Each dropped one says why.
 * @param {object[]} raw a model's or a browser's scenes; from and to are word ids or sentence ids
 * @param {{ index: object, asset: string, cuts?: { from: number, to: number }[], limit?: number }} input cuts in seconds of the take
 */
export function arrangeScenes(raw, { index, asset, cuts = [], limit = MAX_SCENES }) {
  const words = (index.words ?? []).filter((w) => w.asset === asset)
  const total = words.length ? words.at(-1).end - words[0].start : 0
  const phrases = phrasesOf(index, asset)
  const position = new Map(words.map((w, i) => [w.id, i]))
  const sentence = new Map((index.sentences ?? []).filter((s) => s.asset === asset).map((s) => [s.id, s]))
  const phraseAt = (i) => phrases.findIndex((p) => i >= p.first && i <= p.last)
  const startOf = (id) => phraseAt(position.get(sentence.get(id)?.firstWord ?? id) ?? -1)
  const endOf = (id) => phraseAt(position.get(sentence.get(id)?.lastWord ?? id) ?? -1)
  const all = words.map((w) => w.text).join(" ")
  const dropped = []
  const placed = []
  const spans = (Array.isArray(raw) ? raw : [])
    .map(cleanScene)
    .filter(Boolean)
    .map((scene) => ({ scene, i: startOf(scene.from), k: endOf(scene.to) }))
    .sort((a, b) => (a.i < 0 ? Infinity : a.i) - (b.i < 0 ? Infinity : b.i))
  let used = 0
  for (const { scene, i, k: asked } of spans) {
    const drop = (reason) => dropped.push({ scene, reason })
    if (i < 0 || asked < i) {
      drop("its lines aren't in this take")
      continue
    }
    let k = asked
    // A short phrase takes the next one with it, so a scene is on screen long enough to read
    while (k + 1 < phrases.length && phrases[k].end - phrases[i].start < MIN_SCENE) k++
    const start = phrases[i].start
    const end = phrases[k].end
    const span = end - start
    if (!words.length || start - words[0].start < OPENING) drop("the first line stays on the speaker, as the hook")
    else if (span < MIN_SCENE) drop("its lines are too short to read a scene")
    else if (span > MAX_SCENE) drop("its lines run too long for one scene")
    else if (words.some((w) => w.start >= start && w.end <= end && out(w, cuts))) drop("it covers a stretch you asked to trim")
    else if (placed.length && start - placed.at(-1).end < MIN_GAP) drop("it comes too soon after the last scene")
    else if (placed.length >= limit) drop("there are already enough scenes")
    else if (total && used + span > total * MAX_SHARE) drop("the speaker would hardly be seen")
    else {
      const near = words.filter((w) => w.end >= start - NEAR && w.start <= end + NEAR).map((w) => w.text).join(" ")
      const wrong = groundProblems(scene, { all, near })
      if (wrong.length) drop(wrong[0])
      else {
        used += span
        placed.push({ start, end, scene: { ...scene, from: words[phrases[i].first].id, to: words[phrases[k].last].id } })
      }
    }
  }
  return { scenes: placed.map((p) => p.scene), dropped }
}

/**
 * The word each label is spoken on, in order, so it lands as it's said; null where the
 * label's words aren't in these words (it then comes in evenly).
 * @param {object} scene
 * @param {{ id: string, text: string }[]} spoken the scene's words, in order
 */
export function revealWords(scene, spoken) {
  let from = 0
  return scene.items.map((item) => {
    const wanted = new Set([...tokens(item.text), ...(item.value ? [item.value] : [])].filter((t) => !SMALL.has(t)).map(stem))
    for (let i = from; i < spoken.length; i++) {
      if (tokens(spoken[i].text).some((t) => wanted.has(stem(t)) || wanted.has(bare(t)))) {
        from = i + 1
        return spoken[i]
      }
    }
    return null
  })
}

/* ─────────────────────────────── code's own beats ─────────────────────────────── */

const LEAD = /^(?:(?:so|and|but|then|now|that|this|the|a|an|your|our|it|when|because|which|without)\s+)+/i
const HELPERS = /\s+(?:starts?|begins?|keeps?|tends?|continues?|is|are|was|were|will)(?:\s+to)?$/i
function phrase(text, words = 4) {
  const cleaned = String(text).replace(/[^\p{L}\p{N}%' -]+/gu, " ").replace(/\s+/g, " ").trim().replace(LEAD, "").replace(HELPERS, "")
  return cleaned.split(" ").slice(-words).join(" ").slice(0, 32).trim()
}
const CHAIN = /\s*(?:\bwhich (?:then )?(?:leads? to|causes?|makes?)\b|\bleads? to\b|\bcauses?\b|\bturns? into\b|\bresults? in\b|\band then\b|\bthen\b|→)\s*/i
const FLOW = /\b([\p{L}\p{N} '-]{3,30}?)\s+(flood|flow|mov|enter|travel|pass|go)(?:s|es|ing|ed)?\s+(?:in ?to|through|to)\s+(?:the\s+|your\s+|a\s+)?([\p{L}\p{N} '-]{3,30})/iu
const VERSUS = /\b([\p{L}\p{N} '-]{3,30}?)\s+(?:versus|vs\.?|compared (?:to|with)|unlike)\s+(?:the\s+|a\s+)?([\p{L}\p{N} '-]{3,30})/iu
const PERCENT = /\b(\d{1,3}(?:\.\d{1,2})?)\s*(?:%|percent\b|per cent\b)\s*(?:of\s+)?([\p{L}\p{N} '-]{3,40})?/iu

/**
 * The beats code is sure of, from what the sentence says outright.
 * shortcut: English patterns only; with no model, speech in another language gets no scene. A model reads any language.
 */
export function codeBeats(index, asset) {
  const out = []
  const words = (index.words ?? []).filter((w) => w.asset === asset)
  for (const { first, last, text } of phrasesOf(index, asset)) {
    const base = { from: words[first].id, to: words[last].id, title: "" }
    const percent = PERCENT.exec(text)
    const flow = FLOW.exec(text)
    const versus = VERSUS.exec(text)
    const chain = text.split(CHAIN).map((part) => phrase(part)).filter(Boolean)
    if (percent && phrase(percent[2] ?? "")) out.push({ ...base, kind: "stat", items: [{ text: String(percent[2]).trim().split(" ").slice(0, 5).join(" ").slice(0, 32).trim(), value: percent[1], unit: "%" }] })
    else if (versus && phrase(versus[1]) && phrase(versus[2])) out.push({ ...base, kind: "compare", items: [{ text: phrase(versus[1]) }, { text: String(versus[2]).trim().split(" ").slice(0, 4).join(" ").slice(0, 32).trim() }] })
    else if (flow && phrase(flow[1]) && phrase(flow[3])) out.push({ ...base, kind: "flow", mode: /flood/i.test(flow[2]) ? "floods" : /\b(?:can't|cannot|can not|blocked|stops?)\b/i.test(text) ? "blocked" : "flows", items: [{ text: phrase(flow[1]) }, { text: String(flow[3]).trim().split(" ").slice(0, 4).join(" ").slice(0, 32).trim() }] })
    else if (chain.length >= 3 && chain.length <= 5) out.push({ ...base, kind: "process", items: chain.map((text) => ({ text })) })
  }
  return out
}

/* ─────────────────────────────── the slot ─────────────────────────────── */

const SCENES_SCHEMA = {
  type: "object",
  properties: {
    contentType: { type: "string", enum: ["explainer", "tutorial", "story", "opinion", "interview", "vlog", "promo", "other"] },
    theme: { type: "string", enum: Object.keys(SCENE_THEMES) },
    scenes: {
      type: "array",
      maxItems: MAX_SCENES,
      items: {
        type: "object",
        properties: {
          from: { type: "string", maxLength: 64 },
          to: { type: "string", maxLength: 64 },
          kind: { type: "string", enum: Object.keys(SCENE_KINDS) },
          mode: { type: "string", enum: FLOW_MODES },
          title: { type: "string", maxLength: 60 },
          items: {
            type: "array",
            maxItems: 6,
            items: { type: "object", properties: { text: { type: "string", maxLength: 32 }, value: { type: "string", maxLength: 12 }, unit: { type: "string", maxLength: 8 } }, required: ["text"], additionalProperties: false },
          },
        },
        required: ["from", "to", "kind", "title", "items"],
        additionalProperties: false,
      },
    },
  },
  required: ["contentType", "theme", "scenes"],
  additionalProperties: false,
}

const SAID_OFF = /\b(?:no|without|skip|don't (?:want|add|use)|do not (?:want|add|use))\s+(?:any\s+|the\s+)?(?:animations?|diagrams?|visuals?|graphics|scenes|illustrations?)\b/i
const SAID_ON = /\b(?:animat\w*|diagrams?|visuals?|graphics|illustrat\w*|explainer|cutaways?)\b/i
const SAID_THEMES = [[/\bblue ?prints?\b/i, "blueprint"], [/\bchalk ?(?:board)?\b|\bblackboard\b/i, "chalk"], [/\bpaper\b|\bwhite ?board\b|\blight (?:look|theme|background)\b/i, "paper"], [/\blab\b|\bdark (?:look|theme|background)\b/i, "lab"]]
// Types of video where a diagram is usually what the viewer needs
const EXPLAINS = new Set(["explainer", "tutorial", "promo"])

/** What the person's words say about scenes: "off", "on", or null. */
export function visualsIn(text) {
  return SAID_OFF.test(text) ? "off" : SAID_ON.test(text) ? "on" : null
}

const themeIn = (text) => SAID_THEMES.find(([cue]) => cue.test(text))?.[1] ?? null

/**
 * The scenes for a plan. The person's words come first: "no animations" means none and no
 * call. A revision that doesn't mention them keeps the ones on the card.
 * @param {{ ask: Function, index: object, asset: string, text: string, history?: object[], previous?: object | null, cuts?: object[], signal?: AbortSignal }} input
 * @returns {Promise<{ scenes: object[], contentType: string | null, source: string, dropped: object[] }>}
 */
export async function planScenes({ ask, index, asset, text, history = [], previous = null, cuts = [], signal }) {
  const said = [...history.filter((h) => h.who === "you").map((h) => h.text), text]
  const verdict = said.map(visualsIn).filter(Boolean).at(-1) ?? null
  if (verdict === "off") return { scenes: [], contentType: null, source: "person", dropped: [] }
  const themeSaid = said.map(themeIn).filter(Boolean).at(-1) ?? null
  const restyle = (scenes) => (themeSaid ? scenes.map((scene) => ({ ...scene, theme: themeSaid })) : scenes)
  const kept = previous?.settings?.scenes
  if (Array.isArray(kept) && !visualsIn(text)) {
    const { scenes, dropped } = arrangeScenes(restyle(kept), { index, asset, cuts })
    return { scenes, contentType: null, source: "kept", dropped }
  }
  const words = (index.words ?? []).filter((w) => w.asset === asset)
  const phrases = phrasesOf(index, asset)
  const usable = words.length ? (words.at(-1).end - words[0].start) / FLICKS : 0
  const limit = Math.max(1, Math.min(MAX_SCENES, Math.round(usable / 9)))
  if (phrases.length < 2) return { scenes: [], contentType: null, source: "code", dropped: [] }
  const hints = codeBeats(index, asset)
  const kinds = Object.entries(SCENE_KINDS).map(([id, kind]) => `- ${id} (${kind.min === kind.max ? kind.min : `${kind.min} to ${kind.max}`} items): ${kind.when}`).join("\n")
  const request = [
    `The person says (their own words, trusted): ${JSON.stringify(String(text).slice(0, 1200))}`,
    "You are the Director choosing the moments where an animated explainer scene takes over the frame while the speaker's voice keeps playing, the way a top science channel cuts away from the presenter to show the idea. First decide the contentType of this video.",
    verdict === "on" ? "The person asked for visuals, so propose them whatever the contentType." : "If this video isn't explaining something (a story, an opinion, a personal moment, a vlog), answer with no scenes: a diagram would get in the way.",
    `Choose up to ${limit} scenes, the moments that are hard to picture from words alone: how something works, a cause and effect, a process, numbers. Keep the speaker on screen for the opening line, for anything personal or emotional and for calls to action. Let the film breathe: leave the speaker on screen between scenes.`,
    `A scene covers whole phrases, about 3 to 12 seconds: \`from\` is the first word id of its first phrase, \`to\` the last word id of its last phrase. Choose lines where something can be shown, and start each scene as the idea starts. The kinds:\n${kinds}`,
    "Hard rules, checked by code, which throws away a scene that breaks them: every word on the scene comes from what the speaker actually says, in the speaker's language, as short labels of 1 to 4 words; a number only if the speaker says it in those lines, as digits, in `value`, with `unit` only if they say the unit. Never add a fact, figure or name of your own, however true. List items in the order they are spoken. `title` is at most 6 of the speaker's words, or empty.",
    "Use a variety of kinds, each right for its moment. Choose one theme for the whole film: lab (dark, scientific), blueprint (engineering), chalk (a lesson), paper (light).",
    hints.length ? `Code found these candidates, which may help: ${JSON.stringify(hints.slice(0, 8).map((h) => ({ from: h.from, kind: h.kind })))}.` : "",
  ].filter(Boolean).join("\n")
  // A scene that fails is dropped below; only a whole answer with nothing usable goes back to the model
  const check = ({ scenes }) => {
    if (!scenes.length) return []
    const tried = arrangeScenes(scenes, { index, asset, cuts, limit })
    return tried.scenes.length ? [] : tried.dropped.slice(0, 3).map((d) => `scene on ${d.scene.from}: ${d.reason}`)
  }
  const slot = (tier) => ask({ task: "scenes", tier, schema: SCENES_SCHEMA, view: phraseView(phrases.map((p) => ({ ...p, from: words[p.first].id, to: words[p.last].id }))), request, maxOutput: 2200, check, fallback: () => ({ contentType: "other", theme: "lab", scenes: hints }), signal, priority: 0 })
  let answer = await slot("balanced")
  // Refused before it answered (a plan without that tier): the budget model can still do this
  if (answer.source === "default" && answer.calls === 1) answer = await slot("budget")
  const { value } = answer
  if (answer.source !== "default" && verdict !== "on" && !EXPLAINS.has(value.contentType)) return { scenes: [], contentType: value.contentType, source: answer.source, dropped: [] }
  const themed = restyle((value.scenes ?? []).map((scene) => ({ ...scene, theme: value.theme })))
  const { scenes, dropped } = arrangeScenes(themed, { index, asset, cuts, limit })
  return { scenes, contentType: value.contentType ?? null, source: answer.source, dropped }
}
