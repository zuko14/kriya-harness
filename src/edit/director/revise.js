// The Director console (DIRECTOR_AND_AGENT §1, UX_SPEC §5): one request in the
// person's words becomes typed operations on stable ids, in one small call. The
// result is a proposal: applied to a copy, shown as ghost clips with what changed in
// plain words built from the operations by code, and landing only when accepted.

import { apply } from "../core/ops.js"
import { solve } from "../core/solver.js"
import { paperEdit, shotDigest } from "../index/views.js"

const FLICKS = 705_600_000

// What the console may ask for: edits that render today. Captions, motion and sound
// design arrive with their phases (ED8, ED9) and are refused until then
export const CONSOLE_OPS = ["keep_range", "remove_range", "use_take", "reorder", "trim", "split", "ripple_delete", "punch_in", "reframe", "speed", "set_format", "mark"]

const ID = { type: "string", maxLength: 64 }
const EDGE = { type: "string", enum: ["start", "end"] }
const REF = {
  anyOf: [
    { type: "integer", minimum: 0 },
    { type: "object", properties: { word: ID, edge: EDGE, exact: { type: "boolean" } }, required: ["word", "edge"], additionalProperties: false },
    { type: "object", properties: { shot: ID, edge: EDGE }, required: ["shot"], additionalProperties: false },
    { type: "object", properties: { clip: ID, edge: EDGE, offset: { type: "integer" } }, required: ["clip", "edge"], additionalProperties: false },
  ],
}
const RATE = { type: "object", properties: { n: { type: "integer", minimum: 1 }, d: { type: "integer", minimum: 1 } }, required: ["n", "d"], additionalProperties: false }

export const OPS_SCHEMA = {
  type: "object",
  properties: {
    ops: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        properties: {
          op: { type: "string", enum: CONSOLE_OPS },
          asset: ID,
          clip: ID,
          after: { anyOf: [ID, { type: "null" }] },
          from: REF,
          to: REF,
          at: REF,
          until: REF,
          in: REF,
          out: REF,
          duration: { type: "integer", minimum: 1 },
          scale: { type: "number", minimum: 1, maximum: 3 },
          ease: { type: "string", maxLength: 32 },
          mode: { type: "string", enum: ["subject", "fixed"] },
          x: { type: "integer" },
          y: { type: "integer" },
          rate: RATE,
          fps: RATE,
          width: { type: "integer", minimum: 2 },
          height: { type: "integer", minimum: 2 },
          name: { type: "string", maxLength: 80 },
        },
        required: ["op"],
        additionalProperties: false,
      },
    },
    // Words the recogniser got wrong, when the person asks to fix the transcript
    corrections: {
      type: "array",
      maxItems: 40,
      items: { type: "object", properties: { word: ID, text: { type: "string", maxLength: 60 } }, required: ["word", "text"], additionalProperties: false },
    },
    // A request about the whole video ("make it stunning", "edit all of it"): the Director's make job does that
    direct: {
      anyOf: [
        { type: "null" },
        { type: "boolean" },
        { type: "object", properties: { seconds: { type: "integer", minimum: 5, maximum: 600 }, captions: { type: "string", enum: ["clean", "karaoke", "boxed"] } }, additionalProperties: false },
      ],
    },
  },
  required: ["ops"],
  additionalProperties: false,
}

/**
 * What models often send that means nothing: every optional field present as null,
 * and empty lists or no `ops` at all. Tidied before the schema, never invented.
 */
export function tidyConsole(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const ops = Array.isArray(value.ops) ? value.ops.map((op) => (op && typeof op === "object" ? Object.fromEntries(Object.entries(op).filter(([key, v]) => v !== null || key === "after")) : op)) : (value.ops ?? [])
  const out = { ...value, ops }
  if (out.corrections === null) delete out.corrections
  if (out.direct === false) out.direct = null
  return out
}

/** A correction's text: one word or a short name, no markup or line breaks. */
export const cleanWord = (text) => (typeof text === "string" ? text.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 60) : "")

const seconds = (flicks) => `${(flicks / FLICKS).toFixed(2)} s`

/** What one operation did, in plain words, from the operation and the index only (track-A rule 7). */
export function describe(op, index) {
  const words = new Map((index.words ?? []).map((w) => [w.id, w]))
  const place = (ref) => {
    if (typeof ref === "number") return seconds(ref)
    if (ref?.word) return `"${words.get(ref.word)?.text ?? ref.word}"`
    if (ref?.shot) return `shot ${ref.shot}`
    if (ref?.clip) return `the ${ref.edge ?? "start"} of ${ref.clip}`
    return "?"
  }
  switch (op.op) {
    case "keep_range":
      return `Kept ${place(op.from)} to ${place(op.to)}`
    case "remove_range":
      return `Cut ${place(op.from)} to ${place(op.to)}`
    case "use_take":
      return `Used another take in ${op.clip}: ${place(op.from)} to ${place(op.to)}`
    case "reorder":
      return op.after === null ? `Moved ${op.clip} to the start` : `Moved ${op.clip} after ${op.after}`
    case "trim":
      return `Trimmed ${op.clip}`
    case "split":
      return `Split ${op.clip} at ${place(op.at)}`
    case "ripple_delete":
      return `Removed ${op.clip} and closed the gap`
    case "punch_in":
      return `Punched in ${op.scale}× at ${place(op.at)}`
    case "reframe":
      return op.mode === "subject" ? `Reframed ${op.clip} to follow the speaker` : `Reframed ${op.clip} to a fixed crop`
    case "speed":
      return `Changed the speed of ${op.clip} to ${op.rate.n}/${op.rate.d}`
    case "set_format":
      return `Set the frame to ${op.width ?? "same"}×${op.height ?? "same"}`
    case "set_brief":
      return `Set the brief: ${op.format}, about ${seconds(op.targetDuration)}`
    case "mark":
      return `Marked "${op.name}" at ${place(op.at)}`
    case "caption_style":
      return op.words?.length ? `Captioned ${op.words.map((id) => `"${words.get(id)?.text ?? id}"`).join(" ")} (${op.look})` : `Set the caption look to ${op.look}`
    case "text_behind":
      return `Put ${op.clip} behind the speaker`
    case "set_music":
      return `Set the music to ${op.asset}`
    case "music_shape":
      return op.fit ? "Fitted the music to the cut on its downbeats" : "Shaped the music's fades"
    case "duck":
      return "Ducked the music under the speech"
    case "add_deliverable":
      return `Set up the export: ${op.size?.width ?? "?"}×${op.size?.height ?? "?"}${op.loudness ? `, mastered to ${op.loudness.lufs} LUFS` : ""}${op.burnCaptions ? ", captions burned in" : ""}`
    default:
      return op.op
  }
}

/** The selection as the person made it, for the model: words, a time range or a clip. */
function selectionText(selection, index) {
  if (!selection) return "Nothing is selected."
  if (selection.words) {
    const [first, last] = selection.words
    return `The person selected the words ${first} to ${last} in the paper edit, and means them by "this", "here" or "that part".`
  }
  if (selection.clip) return `The person selected clip ${selection.clip}, and means it by "this", "here" or "that clip".`
  if (Number.isInteger(selection.from) && Number.isInteger(selection.to)) return `The person selected the timeline from ${selection.from} to ${selection.to} flicks.`
  if (Number.isInteger(selection.at)) return `The playhead is at ${selection.at} flicks on the timeline.`
  return "Nothing is selected."
}

/** Validates what the person sent as a selection: ids must exist; anything else is dropped. */
export function cleanSelection(selection, project, index) {
  if (!selection || typeof selection !== "object") return null
  const words = new Set((index.words ?? []).map((w) => w.id))
  if (Array.isArray(selection.words) && selection.words.length === 2 && selection.words.every((id) => typeof id === "string" && words.has(id))) return { words: selection.words }
  const clips = new Set(project.sequences.flatMap((q) => q.clips.map((c) => c.id)))
  if (typeof selection.clip === "string" && clips.has(selection.clip)) return { clip: selection.clip }
  if (Number.isSafeInteger(selection.from) && Number.isSafeInteger(selection.to) && selection.from >= 0 && selection.to > selection.from) return { from: selection.from, to: selection.to }
  if (Number.isSafeInteger(selection.at) && selection.at >= 0) return { at: selection.at }
  return null
}

/**
 * The word a note pinned to a moment of the cut lands on, so it survives re-cuts
 * (TAVI_INTEGRATION §6). A picture piece maps the moment back to its source.
 * @returns {string | null} a word id; null when nothing is spoken near there
 */
export function noteWord(project, index, at) {
  const { picture } = solve(project, index)
  const piece = picture.find((p) => at >= p.at && at < p.end) ?? picture.at(-1)
  if (!piece) return null
  const span = piece.end - piece.at
  const t = piece.in + Math.round(((Math.min(at, piece.end) - piece.at) * (piece.out - piece.in)) / (span || 1))
  const words = (index.words ?? []).filter((w) => w.asset === piece.asset)
  return (words.find((w) => t >= w.start && t < w.end) ?? words.find((w) => w.start >= t) ?? words.at(-1))?.id ?? null
}

function clipsView(project, index) {
  const { picture } = solve(project, index)
  const lines = picture.map((p) => `[${p.clip} ${p.asset} source ${p.in}-${p.out} at ${p.at}-${p.end}]`)
  return `Clips on the timeline, in order:\n${lines.join("\n") || "(none yet)"}`
}

/**
 * One request in words → a proposal.
 * @param {{ ask: ReturnType<import("./ask.js").createAsk>, project: object, index: object, text: string, selection?: object, signal?: AbortSignal }} input
 * @returns {Promise<{ ops: object[], changes: string[], project: object | null, source: string, reason?: string, calls: number }>}
 */
export async function revise({ ask, project, index, text, selection, signal }) {
  const assets = project.assets.map((a) => a.id)
  const view = [paperEdit(index, { assets }), shotDigest(index, { assets }), clipsView(project, index), selectionText(selection, index)].join("\n\n")
  const request = [
    `The person asks (their own words, trusted): ${JSON.stringify(String(text).slice(0, 2000))}`,
    "Answer with JSON only. Put in `ops` the operations that do exactly what they ask, and nothing else.",
    "If they ask to fix or correct the transcript (names, misheard words), put each wrong word in `corrections` as {word: its id, text: the right word}, only where you are confident from the context.",
    "If they ask for the whole video to be made, directed, edited or improved (not one part of it), set `direct` to an object (with `seconds` and a caption look if they say so) and leave `ops` empty: the Director makes the whole cut.",
    'If none of these can do it, answer {"ops": []}.',
  ].join("\n")
  const words = new Map((index.words ?? []).map((w) => [w.id, w]))
  // Operations must apply; a correction on an unknown word is only dropped, never worth a second call
  const check = ({ ops }) => {
    if (!ops.length) return []
    const tried = apply(project, ops, { index, author: "agent" })
    return tried.applied ? [] : tried.diagnostics.map((d) => `operation ${d.op + 1}: ${d.message}`)
  }
  const answer = await ask({ task: "console", tier: "budget", schema: OPS_SCHEMA, view, request, maxOutput: 2000, check, clean: tidyConsole, fallback: () => ({ ops: [] }), signal, priority: 0 })
  const ops = answer.value.ops
  const tried = ops.length ? apply(project, ops, { index, author: "agent" }) : null
  // A correction that changes nothing, or isn't a known word, isn't offered
  const corrections = (answer.value.corrections ?? []).map((c) => ({ word: c.word, text: cleanWord(c.text) })).filter((c) => words.has(c.word) && c.text && c.text !== words.get(c.word).text)
  const direct = answer.value.direct === true ? {} : answer.value.direct && typeof answer.value.direct === "object" ? answer.value.direct : null
  return {
    ops: tried?.applied ? ops : [],
    changes: tried?.applied ? ops.map((op) => describe(op, index)) : [],
    corrections: corrections.map((c) => ({ ...c, change: `Corrected "${words.get(c.word).text}" to "${c.text}"` })),
    direct,
    project: tried?.applied ? tried.project : null,
    source: answer.source,
    reason: answer.reason,
    calls: answer.calls,
  }
}
