// The Director's motion graphics (MOTION_GRAPHICS.md, EDD-58): it proposes titles, a name
// strap, an opening title, an end card, quotes and numbers from the motion kit; code decides
// what may be shown. Words on screen are the speaker's or the person's own typed words, never
// the model's; a number is one that was said. Nothing here writes code or draws: the kit does.

import { cleanGraphic, GRAPHIC_ACCENTS, GRAPHIC_FONTS, GRAPHIC_KINDS, GRAPHIC_TONES, graphicLength, SUBTITLE_MAX, TEXT_MAX } from "../engine/graphics.js"
import { paperEdit } from "../index/views.js"
import { groundProblems } from "./beats.js"

const FLICKS = 705_600_000
export const MAX_GRAPHICS = 8
const GAP = 1 * FLICKS // the frame rests between graphics
const NEAR = 6 * FLICKS // a number is "said here" within this of the graphic
const ONCE = new Set(["intro", "end", "lower"])
const ID = { type: "string", maxLength: 64 }

export const GRAPHICS_SCHEMA = {
  type: "object",
  properties: {
    graphics: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        properties: { kind: { type: "string", enum: Object.keys(GRAPHIC_KINDS) }, style: { type: "string", maxLength: 16 }, text: { type: "string", maxLength: TEXT_MAX }, subtitle: { type: "string", maxLength: SUBTITLE_MAX }, at: ID },
        required: ["kind", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["graphics"],
  additionalProperties: false,
}

// "no graphics", "without titles" turn them off; naming one asks for them
const OFF = /\b(?:no|without|skip|remove (?:the|all)(?: the)?|drop the)\s+(?:any\s+)?(?:motion[- ])?(?:graphics?|titles?|text on screen|lower[- ]thirds?|name straps?)\b/i
const ON = /\b(?:motion[- ]graphics?|graphics|lower[- ]thirds?|name (?:strap|tag|card)|end ?card|outro|intro(?:duction)? (?:title|card)|opening title|title cards?|chapter (?:cards?|titles?)|animated (?:titles?|text)|kinetic)\b/i

/** What the person's words say about motion graphics: "on", "off" or null. */
export const graphicsIn = (text) => (OFF.test(String(text ?? "")) ? "off" : ON.test(String(text ?? "")) ? "on" : null)

/** The brand kit in the person's words: a colour, a tone, a font. Code reads it; hex stays in code. */
export function brandIn(text) {
  const said = String(text ?? "")
  const out = {}
  const accent = Object.keys(GRAPHIC_ACCENTS).find((name) => new RegExp(`\\b${name}\\b[^.]{0,24}\\b(?:graphics?|titles?|accent|brand|colou?r)|\\b(?:accent|brand|colou?r)\\b[^.]{0,16}\\b${name}\\b`, "i").test(said))
  if (accent) out.accent = accent
  if (/\blight (?:graphics?|titles?|plates?|cards?)\b/i.test(said)) out.tone = "light"
  else if (/\bdark (?:graphics?|titles?|plates?|cards?)\b/i.test(said)) out.tone = "dark"
  const font = Object.keys(GRAPHIC_FONTS).find((name) => new RegExp(`\\b${name}(?:[- ]?serif)?\\b[^.]{0,12}\\b(?:font|type|titles?|text)\\b`, "i").test(said))
  if (font) out.font = /\bsans\b/i.test(said) && font === "serif" ? "sans" : font
  return out
}

/**
 * Why a graphic's words can't be shown; empty when they can. Every word is the speaker's or
 * one the person typed, and a number is said near the graphic or typed by the person.
 * @param {object} graphic from cleanGraphic
 * @param {{ spoken: string, near: string, person: string }} said the take's words, those around the graphic, and the person's own messages
 */
export function graphicProblems(graphic, { spoken, near, person }) {
  return groundProblems({ title: graphic.text, items: graphic.subtitle ? [{ text: graphic.subtitle }] : [] }, { all: `${spoken} ${person}`, near: `${near} ${person}` })
}

/**
 * The graphics a cut can carry, in the order they play: each cleaned, grounded, on a word that
 * is still in the take, clear of the scenes and of each other. The opening title sits on the
 * first word and the end card on the end; one of each, and one name strap.
 * @param {object[]} raw
 * @param {{ index: object, asset: string, cuts?: { from: number, to: number }[], person?: string, scenes?: { from: string, to: string }[], brand?: object, limit?: number }} context cuts in seconds of the take
 * @returns {{ graphics: object[], dropped: { graphic: object, reason: string }[] }}
 */
export function arrangeGraphics(raw, { index, asset, cuts = [], person = "", scenes = [], brand = {}, limit = MAX_GRAPHICS }) {
  const trimmed = (w) => cuts.some((c) => (w.start + w.end) / 2 >= c.from * FLICKS && (w.start + w.end) / 2 < c.to * FLICKS)
  const words = (index.words ?? []).filter((w) => w.asset === asset && !trimmed(w))
  const byId = new Map(words.map((w) => [w.id, w]))
  const spoken = words.map((w) => w.text).join(" ")
  const under = scenes.map((s) => [byId.get(s.from), byId.get(s.to)]).filter(([a, b]) => a && b).map(([a, b]) => ({ start: a.start, end: b.end }))
  const graphics = []
  const dropped = []
  const once = new Set()
  const candidates = (Array.isArray(raw) ? raw : []).map((item) => cleanGraphic({ ...item, ...brand })).filter(Boolean)
  // Where each starts in the take: the opening title first, the end card last
  const placed = candidates.map((graphic) => ({ graphic, word: graphic.kind === "intro" ? words[0] : graphic.kind === "end" ? words.at(-1) : byId.get(graphic.at) }))
  const order = (p) => (p.graphic.kind === "intro" ? -Infinity : p.graphic.kind === "end" ? Infinity : (p.word?.start ?? 0))
  let free = -Infinity
  for (const { graphic, word } of placed.sort((a, b) => order(a) - order(b))) {
    const drop = (reason) => dropped.push({ graphic, reason })
    if (!word) drop("it isn't on a word of this take")
    else if (ONCE.has(graphic.kind) && once.has(graphic.kind)) drop(`there is already ${graphic.kind === "end" ? "an end card" : graphic.kind === "intro" ? "an opening title" : "a name strap"}`)
    else if (graphics.length >= limit) drop("that is more graphics than this cut can carry")
    else {
      const edge = graphic.kind === "intro" || graphic.kind === "end"
      const near = edge ? spoken : words.filter((w) => w.end >= word.start - NEAR && w.start <= word.start + NEAR).map((w) => w.text).join(" ")
      const problems = graphicProblems(graphic, { spoken, near, person })
      if (problems.length) drop(problems[0])
      else if (!edge && under.some((s) => word.start >= s.start && word.start < s.end)) drop("an animated scene is on screen there")
      else if (!edge && word.start < free) drop("another graphic is still on screen there")
      else {
        once.add(graphic.kind)
        if (!edge) free = word.start + graphicLength(graphic) + GAP
        const { at: _from, ...rest } = graphic
        graphics.push(edge ? rest : { ...rest, at: word.id })
      }
    }
  }
  return { graphics, dropped }
}

/**
 * The graphics for a plan. The person's words come first: "no graphics" means none and no
 * call. A revision that doesn't mention them keeps the ones on the card, restyled if a colour
 * or font was asked for.
 * @returns {Promise<{ graphics: object[], source: string, dropped: object[] }>}
 */
export async function planGraphics({ ask, index, asset, text, history = [], previous = null, cuts = [], scenes = [], signal }) {
  const said = [...history.filter((h) => h.who === "you").map((h) => h.text), text]
  const person = said.join("\n")
  const verdict = said.map(graphicsIn).filter(Boolean).at(-1) ?? null
  if (verdict === "off") return { graphics: [], source: "person", dropped: [] }
  const kept = previous?.settings?.graphics
  const was = Array.isArray(kept) && kept[0] ? { accent: kept[0].accent, tone: kept[0].tone, font: kept[0].font } : {}
  const brand = said.map(brandIn).reduce((all, one) => ({ ...all, ...one }), was)
  const context = { index, asset, cuts, person, scenes, brand }
  if (Array.isArray(kept) && !graphicsIn(text)) return { ...arrangeGraphics(kept, context), source: "kept" }
  const words = (index.words ?? []).filter((w) => w.asset === asset)
  const usable = words.length ? (words.at(-1).end - words[0].start) / FLICKS : 0
  if (words.length < 4) return { graphics: [], source: "code", dropped: [] }
  // About one every eight seconds at most; a short clip still has room for a title and one more
  const limit = Math.max(1, Math.min(MAX_GRAPHICS, Math.ceil(usable / 8)))
  const kinds = Object.entries(GRAPHIC_KINDS).map(([id, kind]) => `- ${id} (styles: ${kind.styles.join(", ")}): ${kind.when}`).join("\n")
  const request = [
    `The person says (their own words, trusted): ${JSON.stringify(String(text).slice(0, 1200))}`,
    "You are the Director choosing the motion graphics for this cut, the way a top editor dresses a video: a few, each with a reason, never decoration. The speaker stays the film.",
    `Choose up to ${limit}, fewer for a short or personal video. \`at\` is the word id where a graphic appears (the opening title and the end card need none: code places them on the first and last seconds). The kinds:\n${kinds}`,
    `Hard rules, checked by code, which throws away a graphic that breaks them: every word on a graphic is either said by the speaker or typed by the person in their request, in that language, at most ${TEXT_MAX} characters (${SUBTITLE_MAX} for a subtitle); a number only if it is said near that word or the person typed it. Never write a title, name, handle or claim of your own, however good. A name strap, an opening title or an end card only if the person gave its words or the speaker says them.`,
    verdict === "on" ? "The person asked for motion graphics, so use them where they fit." : "If nothing earns a graphic, answer with none.",
    scenes.length ? "Animated scenes already cover some lines; code drops a graphic placed inside one." : "",
  ].filter(Boolean).join("\n")
  // A graphic that fails is dropped below; only an answer with nothing usable goes back to the model
  const check = ({ graphics }) => {
    if (!graphics.length) return []
    const tried = arrangeGraphics(graphics, { ...context, limit })
    return tried.graphics.length ? [] : tried.dropped.slice(0, 3).map((d) => `${d.graphic.kind} "${d.graphic.text}": ${d.reason}`)
  }
  const answer = await ask({ task: "graphics", tier: "budget", schema: GRAPHICS_SCHEMA, view: paperEdit(index, { assets: [asset] }), request, maxOutput: 1200, check, fallback: () => ({ graphics: [] }), signal, priority: 0 })
  return { ...arrangeGraphics(answer.value.graphics ?? [], { ...context, limit }), source: answer.source }
}

/** One line a person reads for a graphic, built by code. */
export const graphicLine = (graphic) => `${GRAPHIC_KINDS[graphic.kind].label} "${graphic.text}"${graphic.subtitle ? `, "${graphic.subtitle}"` : ""}`
export { GRAPHIC_TONES }
