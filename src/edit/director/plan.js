// The Director's plan (2026-11-09): the person says what they want in their own words; the
// Director proposes the whole cut the way an editor pitches it (the opening, the pacing, the
// captions, the look, the music, the sound, the length) with the exact settings behind it.
// Nothing is made until the person approves; a change of mind revises the plan, and again
// nothing is made. Every setting is checked by code: ids must exist, values must be ones the
// engine renders, and a cold open must be a short stretch of one take.

import { FORMATS, GRADES } from "../recipes/reel.js"
import { MOODS } from "../engine/music-bed.js"
import { SFX } from "../engine/sfx.js"
import { paperEdit, shotDigest } from "../index/views.js"

const FLICKS = 705_600_000
const ID = { type: "string", maxLength: 64 }

export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    say: { type: "string", maxLength: 900 },
    steps: { type: "array", maxItems: 10, items: { type: "string", maxLength: 240 } },
    settings: {
      type: "object",
      properties: {
        format: { type: "string", enum: Object.keys(FORMATS) },
        seconds: { type: "integer", minimum: 5, maximum: 600 },
        captions: { type: "string", enum: ["none", "clean", "karaoke", "boxed"] },
        grade: { type: "string", enum: ["natural", ...Object.keys(GRADES)] },
        music: { type: "string", enum: ["none", "reference", ...Object.keys(MOODS)] },
        cleanVoice: { type: "boolean" },
        hook: { anyOf: [{ type: "null" }, ID] },
        coldOpen: { anyOf: [{ type: "null" }, { type: "object", properties: { from: ID, to: ID, mono: { type: "boolean" } }, required: ["from", "to"], additionalProperties: false }] },
        cutSound: { type: "string", enum: ["none", "whoosh", "pop"] },
        introSound: { type: "string", enum: ["none", "riser", "hit"] },
        punches: { type: "integer", minimum: 0, maximum: 8 },
        angles: { type: "boolean" },
        broll: { type: "string", enum: ["none", "own"] },
        titles: { type: "boolean" },
        ramps: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  required: ["say", "steps", "settings"],
  additionalProperties: false,
}

/** What the plan's settings ask of a make job, as the make route takes them. */
export function briefOf(settings = {}) {
  return {
    ...(settings.format ? { format: settings.format } : {}),
    ...(settings.seconds ? { seconds: settings.seconds } : {}),
    ...(settings.captions && settings.captions !== "none" ? { captions: settings.captions } : {}),
    ...(settings.grade && settings.grade !== "natural" ? { grade: settings.grade } : {}),
    ...(settings.music && Object.hasOwn(MOODS, settings.music) ? { music: `generated:${settings.music}` } : {}),
    ...(settings.cleanVoice ? { cleanVoice: true } : {}),
    ...(settings.hook ? { hook: settings.hook } : {}),
    ...(settings.coldOpen ? { coldOpen: settings.coldOpen } : {}),
    ...(settings.cutSound && Object.hasOwn(SFX, settings.cutSound) ? { cutSound: settings.cutSound } : {}),
    ...(settings.introSound && Object.hasOwn(SFX, settings.introSound) ? { introSound: settings.introSound } : {}),
    ...(Number.isInteger(settings.punches) ? { punches: settings.punches } : {}),
    ...(settings.angles ? { angles: true } : {}),
    ...(settings.broll === "own" ? { broll: "own" } : {}),
    ...(settings.titles ? { titles: true } : {}),
    ...(settings.ramps ? { ramps: true } : {}),
  }
}

// The frame the person asked for in their own words. Code decides it, not the model: found in
// use, a plan approved for 16:9 left `format` out and the make fell back to 9:16.
const RATIO = (a, b) => new RegExp(`\\b${a}\\s*(?::|x|×|/|by|to)\\s*${b}\\b`, "gi")
const FORMAT_CUES = [
  ["16:9", RATIO(16, 9), 2],
  ["9:16", RATIO(9, 16), 2],
  ["1:1", RATIO(1, 1), 2],
  ["4:5", RATIO(4, 5), 2],
  ["16:9", /\b(?:landscape|horizontal|wide ?screen|youtube(?! ?shorts?))\b/gi, 1],
  ["9:16", /\b(?:vertical|portrait|reels?|shorts|tiktok|stories)\b/gi, 1],
  ["1:1", /\bsquare\b/gi, 1],
]
// "not 9:16", "instead of a reel", "from 9:16 to 16:9", "but it made 9:16": a mention turned away from
const AWAY = /(?:\bnot|\bno|\bisn't|\bwasn't|instead of|rather than|\bthan|\bfrom|\bmade(?: it| me)?|\bgave(?: me)?|came out|turned out|\bcurrently|\bbut it's|output (?:is|was))\s+(?:(?:a|an|the|in|at|as|like)\s+)?$/i

/** The format one message asks for: a ratio beats a word ("a reel in 16:9"), the last mention wins; null if none. */
export function formatIn(text) {
  const said = String(text ?? "")
  let best = null
  for (const [format, cue, strength] of FORMAT_CUES) {
    for (const m of said.matchAll(cue)) {
      if (AWAY.test(said.slice(Math.max(0, m.index - 24), m.index))) continue
      if (!best || strength > best.strength || (strength === best.strength && m.index > best.at)) best = { format, strength, at: m.index }
    }
  }
  return best?.format ?? null
}

/** The format the person wants: this message, then their earlier messages (latest first), then the plan being revised. */
export function formatAsked(text, history = [], previous = null) {
  for (const said of [text, ...history.filter((h) => h.who === "you").map((h) => h.text).reverse()]) {
    const format = formatIn(said)
    if (format) return format
  }
  return Object.hasOwn(FORMATS, previous?.settings?.format ?? "") ? previous.settings.format : null
}

/** Problems with a plan's settings against this project: unknown ids, a cold open that isn't one short stretch. */
export function planProblems(settings, index) {
  const problems = []
  const words = new Map((index.words ?? []).map((w) => [w.id, w]))
  if (settings.hook && !(index.sentences ?? []).some((s) => s.id === settings.hook)) problems.push(`hook "${settings.hook}" isn't a sentence id from the paper edit`)
  if (settings.coldOpen) {
    const from = words.get(settings.coldOpen.from)
    const to = words.get(settings.coldOpen.to)
    if (!from || !to) problems.push("the cold open must name two word ids from the paper edit")
    else if (from.asset !== to.asset || to.end <= from.start) problems.push("a cold open runs forward within one take: its first word, then its last")
    else if (to.end - from.start > 8 * FLICKS) problems.push("a cold open is short: 8 seconds at most")
  }
  return problems
}

/**
 * @param {{ ask: Function, project: object, index: object, text: string, history?: object[], previous?: object, references?: { name: string, lines: string[] }[], choices?: object, signal?: AbortSignal }} input
 * @returns {Promise<{ say: string, steps: string[], settings: object, source: string, reason?: string }>}
 */
export async function planCut({ ask, project, index, text, history = [], previous = null, references = [], choices = {}, signal }) {
  const assets = project.assets.filter((a) => a.kind === "video" || a.kind === "audio").map((a) => a.id)
  const refs = references.length ? `References the person added, measured by code:\n${references.map((r) => `- ${r.name}: ${r.lines.join("; ")}`).join("\n")}` : "No references added."
  const view = [paperEdit(index, { assets }), shotDigest(index, { assets }), refs, `The person's current choices in the Studio: ${JSON.stringify(choices)}`].join("\n\n")
  const asked = formatAsked(text, history, previous)
  const earlier = history.length ? `Earlier in this chat:\n${history.map((h) => `${h.who === "you" ? "Person" : "Kriya"}: ${JSON.stringify(h.text)}`).join("\n")}\n\n` : ""
  const request = [
    `${earlier}The person says (their own words, trusted): ${JSON.stringify(String(text).slice(0, 2000))}`,
    asked ? `The person wants the ${asked} format: settings.format is "${asked}", and your pitch says ${asked}.` : "",
    previous ? `Your previous plan, which they want changed: ${JSON.stringify(previous).slice(0, 3000)}. Revise it by what they say now; keep what they didn't ask to change.` : "",
    "You are the Director: plan the whole cut the way a top editor pitches it. Decide the opening (a hook sentence first, or a cold open: one strong later moment of 2 to 6 seconds played first, in black and white, before the story starts), the pacing (punch-ins), captions, the colour look, music, sound design (a sound on each cut, a riser into the story after a cold open), whether to clean background noise from the voice, the format and the length. You can also cut one camera like two (angles: wide then tight on alternate clips), lay the person's other clips over the story as B-roll (broll 'own', only if the project has other video), pop key words on screen as title cards (titles, when there are no captions), and ramp the speed out of a cold open into the story (ramps). Follow the references where they say something. Don't promise what these settings can't do: no stock footage or generated video.",
    "Answer with JSON only: `say` is your pitch in 2 to 4 plain sentences, `steps` the concrete things you'll do, and `settings` exactly what will be made. Use sentence ids for `hook` and word ids for `coldOpen`, only from the paper edit. Music 'reference' means follow the music reference.",
  ].filter(Boolean).join("\n")
  const check = ({ settings }) => planProblems(settings, index)
  const fallback = () => ({
    say: "I couldn't reach the Director's model, so here's a plan from your current choices: the best takes, fillers out, and your settings as they are.",
    steps: ["Keep each line's best take and cut fillers and restarts", "Use the format, length, captions, look and music you've chosen"],
    settings: { format: choices.format ?? "9:16", ...(choices.seconds ? { seconds: choices.seconds } : {}), captions: choices.captions ?? "none", grade: choices.grade ?? "natural", music: (choices.music ?? "").replace(/^generated:/, "") || "none", cleanVoice: !!choices.cleanVoice },
  })
  const answer = await ask({ task: "plan", tier: "budget", schema: PLAN_SCHEMA, view, request, maxOutput: 1500, check, fallback, signal, priority: 0 })
  const clean = (value) => String(value ?? "").replace(/[\u0000-\u001f<>]/g, " ").trim()
  // The frame is always set, and set by what the person said, never left to a default
  const settings = { ...(answer.value.settings ?? {}) }
  settings.format = asked ?? (Object.hasOwn(FORMATS, settings.format ?? "") ? settings.format : Object.hasOwn(FORMATS, choices.format ?? "") ? choices.format : "9:16")
  return { say: clean(answer.value.say).slice(0, 900), steps: (answer.value.steps ?? []).map((s) => clean(s).slice(0, 240)).filter(Boolean), settings, source: answer.source, ...(answer.reason ? { reason: answer.reason } : {}) }
}
