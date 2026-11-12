// edit_motion (MG2, TP9; DIRECTOR_AND_AGENT §11, CRAFT_UPGRADE §7): a request no kit graphic covers,
// written by a model as data (engine/custom.js), behind editing.customMotion, only where the OS can
// confine Chrome, and only on `balanced` when Kriya lists it for this person (EH-65). One slot through
// the Director's `ask`, so the Governor paces it and it is counted: at most two calls (the answer and
// one repair), then it says it couldn't and names the nearest kit graphic. Never a loop.

import { CUSTOM_BLOCK, CUSTOM_VERSION, customVariables, LIMITS, PARTS_SCHEMA, partsProblems } from "../engine/custom.js"
import { ALL_GRAPHIC_KINDS } from "../engine/graphics.js"
import { groundProblems } from "./beats.js"

const FLICKS = 705_600_000
export const MOTION_TIER = "balanced"
export const MOTION_SECONDS = { min: 1, max: 8, fallback: 4 }

// The kit graphic a request comes closest to, in the person's words; a title when nothing else fits
const NEAREST = [
  [/\b(?:name|who|strap|lower[- ]?third)\b/i, "lower"],
  [/\b(?:number|count|percent|%|\d)/i, "stat"],
  [/\b(?:list|steps?|points?|bullets?)\b/i, "list"],
  [/\b(?:circle|ring|arrow|point(?:er)?|highlight|callout)\b/i, "callout"],
  [/\b(?:quote|said|line)\b/i, "quote"],
  [/\b(?:chapter|section|part)\b/i, "chapter"],
  [/\b(?:end|outro|subscribe|follow)\b/i, "end"],
  [/\b(?:full[- ]?frame|card)\b/i, "card"],
]
/** @returns {{ kind: string, label: string }} */
export function nearestKit(text) {
  const kind = NEAREST.find(([pattern]) => pattern.test(String(text ?? "")))?.[1] ?? "title"
  return { kind, label: ALL_GRAPHIC_KINDS[kind].label }
}

/** How long a custom animation stays up, in flicks: what was asked, inside 1 to 8 s; 4 s when nothing was. */
export const motionLength = (duration) => (Number.isInteger(duration) ? Math.min(MOTION_SECONDS.max * FLICKS, Math.max(MOTION_SECONDS.min * FLICKS, duration)) : MOTION_SECONDS.fallback * FLICKS)

/** Why a model's parts can't be shown: structure first, then every word against what was said or typed. */
export function motionProblems(parts, { spoken, person }) {
  const { problems, texts } = partsProblems(parts)
  if (problems.length) return problems
  // VISUAL_SCENES §3.2: each word the speaker's or the person's own; a number said or typed
  if (!texts.length) return []
  return groundProblems({ title: texts[0], items: texts.slice(1).map((text) => ({ text })) }, { all: `${spoken} ${person}`, near: `${spoken} ${person}` }).slice(0, 4)
}

const request = ({ person, describe, canvas, seconds }) =>
  [
    `The person asks (their own words, trusted): ${JSON.stringify(String(person).slice(-1200))}`,
    describe ? `What the console understood they want animated: ${JSON.stringify(String(describe).slice(0, 300))}` : "",
    `Design one motion graphic that no kit graphic covers, ${canvas.width}×${canvas.height} px, ${seconds} seconds, over the footage on a transparent background. Answer with JSON: { "name": a few words, "css": CSS, "body": markup, "animations": [ { "id", "keyframes", "options" } ], "texts": [ words on screen ] }.`,
    "Rules, checked by code, which refuses the whole answer if one is broken:",
    "- No script, no event handlers, no links, no addresses, no fonts or images from anywhere, no clock, no randomness. The markup uses only div, span, svg, g, path, circle, ellipse, rect, line, polyline, polygon, with attributes id, class, data-slot and SVG geometry and paint (fill, stroke, transform, opacity…); attribute values have no colon, slash or quote.",
    "- The markup has no words in it. Each line of words goes in `texts`, and where it shows is an empty <span data-slot=\"N\"></span> (N its index). Each word must be the speaker's (above) or typed by the person; a number only if it is said or typed. Never write a title, name or claim of your own.",
    "- CSS: plain ASCII; selectors of those elements, #ids and .classes; only @keyframes as an at-rule; no url(), no content other than \"\", no comments. Position things inside the frame, clear of the bottom fifth where captions sit; text on its own solid plate, at least 4.5:1 against it, at least 3% of the frame's height.",
    `- Animations as Web Animations data: keyframes of offset, easing, opacity, transform, colors, stroke dash, clipPath, sizes, borderRadius; options duration, delay, iterations (a whole number, at most 50), easing, fill, direction; all finite and done within ${seconds} s. CSS @keyframes animations are allowed too. Motion should arrive in the first second.`,
  ].filter(Boolean).join("\n")

/**
 * @param {{ ask: Function, tiers: string[] | null, allowed: boolean, which: { kind: string | null, missing?: string }, person: string, describe?: string, spoken: string, view?: string, canvas: { width: number, height: number }, duration?: number, signal?: AbortSignal }} input
 *   tiers: GET /models for this person, null when Kriya couldn't say; allowed: editing.customMotion; which: confinement()
 * @returns {Promise<{ node: object, calls: number, source: string } | { refused: string, reason: string, nearest: { kind: string, label: string }, calls: number }>}
 */
export async function writeMotion({ ask, tiers, allowed, which, person, describe = "", spoken, view = "", canvas, duration, signal }) {
  const nearest = nearestKit(`${describe} ${person}`)
  const refuse = (refused, reason, calls = 0) => ({ refused, reason, nearest, calls })
  if (allowed !== true) return refuse("custom_motion_off", "Custom motion is switched off.")
  if (!which?.kind) return refuse("no_confinement", which?.missing ?? "This system can't confine the renderer.")
  // EH-65: only a tier Kriya lists for this person; none listed or Kriya unsure, no call at all
  if (!Array.isArray(tiers) || !tiers.includes(MOTION_TIER)) return refuse("no_tier", "Writing a custom animation needs a stronger model than this plan lists.")
  const length = motionLength(duration)
  const seconds = Math.round((length / FLICKS) * 10) / 10
  const answer = await ask({
    task: "motion",
    tier: MOTION_TIER,
    schema: PARTS_SCHEMA,
    view,
    request: request({ person, describe, canvas, seconds }),
    maxOutput: 4000,
    check: (value) => motionProblems(value, { spoken, person }),
    fallback: () => null,
    signal,
    priority: 0,
  })
  if (!answer.value) return refuse("failed", answer.reason ?? "The model couldn't write it.", answer.calls)
  const variables = customVariables(answer.value)
  if (!variables) return refuse("failed", "The answer didn't hold together.", answer.calls)
  return { node: { blockId: CUSTOM_BLOCK, version: CUSTOM_VERSION, variables, duration: length }, calls: answer.calls, source: answer.source }
}

export { LIMITS }
