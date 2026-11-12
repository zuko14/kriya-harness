// The Director console (DIRECTOR_AND_AGENT §1, UX_SPEC §5): one request in the
// person's words becomes typed operations on stable ids, in one small call. The
// result is a proposal: applied to a copy, shown as ghost clips with what changed in
// plain words built from the operations by code, and landing only when accepted.

import { apply } from "../core/ops.js"
import { solve } from "../core/solver.js"
import { ALL_GRAPHIC_KINDS, cleanGraphic, GRAPHIC_BLOCK, GRAPHIC_KINDS, GRAPHIC_VERSION, graphicLength, STEP_MAX, STEPS_MAX, SUBTITLE_MAX, TEXT_MAX } from "../engine/graphics.js"
import { ALL_LOOKS } from "../engine/captions.js"
import { paperEdit, shotDigest } from "../index/views.js"
import { TRANSITION_LABELS, transitionLength, TRANSITIONS } from "../core/transitions.js"
import { brandIn, graphicProblems } from "./graphics.js"
import { withoutPlaces } from "./mentions.js"
import { grounded, tidyIntent } from "./intent.js"
import { EFFECTS as FX, MOVES } from "../core/effects.js"

const FLICKS = 705_600_000

// What the console may ask for: edits that render today, captions and titles included
// (drawn in the runtime's Chrome when it has no HyperFrames)
export const CONSOLE_OPS = ["keep_range", "remove_range", "use_take", "reorder", "trim", "split", "ripple_delete", "punch_in", "reframe", "speed", "set_format", "mark", "caption_style", "caption_edit", "caption_emphasis", "add_title", "grade", "clean_voice", "set_level", "speed_ramp", "freeze", "place_broll"]
export const CAPTION_LOOKS = ["clean", "karaoke", "boxed"]

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
          look: { type: "string", enum: CAPTION_LOOKS },
          words: { type: "array", maxItems: 40, items: ID },
          caption: ID,
          word: ID,
          text: { type: "string", maxLength: 200 },
          lift: { type: "number", minimum: -0.5, maximum: 0.5 },
          gamma: { type: "number", minimum: 0.5, maximum: 2 },
          gain: { type: "number", minimum: 0.5, maximum: 2 },
          saturation: { type: "number", minimum: 0, maximum: 2 },
          temperature: { type: "number", minimum: 2000, maximum: 12000 },
          vibrance: { type: "number", minimum: -2, maximum: 2 },
          vignette: { type: "number", minimum: 0, maximum: 1 },
          strength: { type: "number", minimum: 0, maximum: 1 },
          db: { type: "number", minimum: -40, maximum: 20 },
          peak: RATE,
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
    // A short answer in words: what Kriya did, or the answer to a question
    say: { type: "string", maxLength: 600 },
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

// With editing.motion on, chat can also put a kit graphic on screen (MOTION_GRAPHICS.md). Off,
// the console's schema is the same object as before
const ITEMS = OPS_SCHEMA.properties.ops.items
const MOTION_SCHEMA = { ...OPS_SCHEMA, properties: { ...OPS_SCHEMA.properties, ops: { ...OPS_SCHEMA.properties.ops, items: { ...ITEMS, properties: { ...ITEMS.properties, op: { type: "string", enum: [...CONSOLE_OPS, "add_graphic", "transition"] }, kind: { type: "string", enum: [...Object.keys(GRAPHIC_KINDS), ...Object.keys(TRANSITIONS)] }, style: { type: "string", maxLength: 16 }, subtitle: { type: "string", maxLength: SUBTITLE_MAX } } } } } }
export const consoleSchema = (motion) => (motion ? MOTION_SCHEMA : OPS_SCHEMA)

/** With editing.craft on (TP5), chat may also add a registry effect or a named move; off, `base` is returned as it is. */
export function craftSchema(base, craft) {
  if (!craft) return base
  const items = base.properties.ops.items
  return { ...base, properties: { ...base.properties, ops: { ...base.properties.ops, items: { ...items, properties: { ...items.properties, op: { type: "string", enum: [...items.properties.op.enum, "add_effect", "add_adjustment", "remove_effect"] }, effect: { type: "string", enum: Object.keys(FX) }, params: { type: "object", additionalProperties: { type: "number" } }, move: { type: "string", enum: Object.keys(MOVES) } } } } } }
}
/** With editing.typeKit on (TP7), chat may also use the fourteen caption looks and motion kit 2; off, `base` is returned as it is. */
export function typeKitSchema(base, typeKit) {
  if (!typeKit) return base
  const items = base.properties.ops.items
  const kinds = items.properties.kind ? { kind: { type: "string", enum: Object.keys(ALL_GRAPHIC_KINDS) }, steps: { type: "array", maxItems: STEPS_MAX, items: { type: "string", maxLength: STEP_MAX } } } : {}
  return { ...base, properties: { ...base.properties, ops: { ...base.properties.ops, items: { ...items, properties: { ...items.properties, look: { type: "string", enum: Object.keys(ALL_LOOKS) }, ...kinds } } } } }
}
/**
 * TP9 (CRAFT_UPGRADE §7): with editing.customMotion on, chat may ask for a custom animation
 * (`custom_motion`, written afterwards by code's own slot, director/custom-motion.js); with a box drawn
 * on the frame, it may act on it (`use_mark`). Neither, and `base` is returned as it is.
 */
export function pointingSchema(base, { customMotion = false, mark = false } = {}) {
  if (!customMotion && !mark) return base
  const items = base.properties.ops.items
  const ops = [...items.properties.op.enum, ...(customMotion ? ["custom_motion"] : []), ...(mark ? ["use_mark"] : [])]
  return { ...base, properties: { ...base.properties, ops: { ...base.properties.ops, items: { ...items, properties: { ...items.properties, op: { type: "string", enum: ops }, ...(customMotion ? { reuse: ID } : {}), ...(mark ? { use: { type: "string", enum: MARK_USES } } : {}) } } } } }
}
export const MARK_USES = ["callout", "blur", "zoom", "mask"]
export const CUSTOM_MOTION_PROMPT = "Only for an animation that no kit graphic and no operation above can make (a logo that spins, a shape that draws itself, an animated diagram), custom_motion with text: what to animate, in the person's words, at (a word anchor) and duration only if they said how long. Code has it written, checks it and shows it to the person to approve. To place a saved custom animation again, custom_motion with reuse: its clip id, and at. At most one custom_motion."
const MARK_KINDS = { box: "box", ring: "ring", arrow: "arrow" }

/** Where a drawn box is, in words a model reads (code alone knows its numbers). */
export function markView(mark) {
  const across = mark.x + mark.w / 2 < 333 ? "left" : mark.x + mark.w / 2 > 667 ? "right" : "centre"
  const down = mark.y + mark.h / 2 < 333 ? "top" : mark.y + mark.h / 2 > 667 ? "bottom" : "middle"
  const share = Math.round((mark.w * mark.h) / 10_000)
  return `The person drew a ${MARK_KINDS[mark.kind] ?? "box"} on the frame at ${clock(mark.at)}, in the ${down} ${across}, about ${share}% of the frame. "This", "here", "that" or "it" means what they drew. To act on it, use_mark with use: callout (mark it; an optional short label in text, the speaker's or the person's own words), blur (blur what is inside it), zoom (zoom in on it) or mask (darken everything else); duration in flicks only if they said how long. Code places it exactly where they drew: never give coordinates.`
}

/**
 * `use_mark` as Edit Core operations, placed by code at the drawn box (TP9): a callout round it, a blur
 * or a mask in it over the shot (from the moment drawn to the end of its piece), or a punch-in centred on
 * it. The model chose what to do; the numbers are the person's drawing.
 * @returns {{ ops: object[], problems: string[] }}
 */
export function expandMark(ops, { mark, project, index, person }) {
  const problems = []
  if (!ops.some((op) => op?.op === "use_mark")) return { ops, problems }
  const { picture, duration: length } = solve(project, index)
  const piece = picture.find((p) => mark.at >= p.at && mark.at < p.end)
  const spoken = (index.words ?? []).map((w) => w.text).join(" ")
  const region = { x: mark.x, y: mark.y, w: mark.w, h: mark.h }
  // How long: what was asked, else the rest of the shot (capped), never past the cut's end; half a second at least
  const span = (op, fallback) => Math.max(FLICKS / 2, Math.min(Number.isInteger(op.duration) ? op.duration : fallback, length - mark.at))
  const rest = piece ? piece.end - mark.at : 3 * FLICKS
  const out = ops.map((op, i) => {
    if (op?.op !== "use_mark") return op
    if (!MARK_USES.includes(op.use)) return problems.push(`operation ${i + 1}: use is one of ${MARK_USES.join(", ")}`), op
    if (mark.at >= length) return problems.push(`operation ${i + 1}: the box was drawn past the end of the cut`), op
    if (op.use === "callout") {
      const graphic = cleanGraphic({ kind: "callout", style: MARK_KINDS[mark.kind] ?? "box", text: op.text ?? "", mark: region, ...brandIn(person) }, ALL_GRAPHIC_KINDS)
      if (!graphic) return problems.push(`operation ${i + 1}: that label can't be a callout's`), op
      const said = graphic.text ? graphicProblems(graphic, { spoken, near: spoken, person }) : []
      if (said.length) return problems.push(`operation ${i + 1}: ${said[0]}; a callout's label is the speaker's or the person's own words`), op
      return { op: "add_motion", block: GRAPHIC_BLOCK, version: GRAPHIC_VERSION, variables: graphic, at: mark.at, duration: span(op, 3 * FLICKS) }
    }
    if (op.use === "zoom") {
      // Fit the drawn box in the frame, a little room round it, between 1.1× and 3×
      const scale = Math.round(Math.min(3, Math.max(1.1, 0.9 * Math.min(1000 / mark.w, 1000 / mark.h))) * 100) / 100
      return { op: "punch_in", at: mark.at, duration: span(op, Math.min(rest, 3 * FLICKS)), scale, ease: "smooth", x: Math.round(mark.x + mark.w / 2), y: Math.round(mark.y + mark.h / 2) }
    }
    const effect = op.use === "blur" ? { effect: "blur", params: { amount: 20 } } : { effect: "mask" }
    return { op: "add_adjustment", at: mark.at, duration: span(op, Math.min(rest, 30 * FLICKS)), ...effect, region }
  })
  return { ops: out, problems }
}

export const TYPE_KIT_PROMPT = `Caption looks for caption_style: ${Object.keys(ALL_LOOKS).join(", ")}. With add_graphic you may also use ${Object.entries(ALL_GRAPHIC_KINDS).filter(([id]) => !GRAPHIC_KINDS[id]).map(([id, kind]) => `${id}: ${kind.label.toLowerCase()}`).join("; ")}; a list's lines go in \`steps\`, each the speaker's own words; a handle or call to action only in words the person typed.`

export const CRAFT_PROMPT = `To put an effect on a clip, add_effect with clip, effect (${Object.entries(FX).map(([id, row]) => `${id}: ${row.label.toLowerCase()}`).join("; ")}) and only the values the person asks for in params; over a stretch of the cut, add_adjustment with at (a word anchor), until or duration, and effect; remove_effect with clip and effect. For a change over time, pick a named move instead of numbers: ${Object.entries(MOVES).map(([id, m]) => `${id} (${m.effect}: ${m.label})`).join("; ")}. Add an effect only when the person asks for it.`

/**
 * `add_graphic` as the engine's own operation: the graphic cleaned, its words held to the
 * speaker's and the person's, its length set by code. Every other operation passes through.
 * @param {object[]} ops
 * @param {{ index: object, person: string }} context person: the person's own messages
 * @returns {{ ops: object[], problems: string[] }}
 */
export function expandGraphics(ops, { index, person, kinds = GRAPHIC_KINDS }) {
  const problems = []
  const spoken = (index.words ?? []).map((w) => w.text).join(" ")
  const out = ops.map((op, i) => {
    // A transition's length is code's: the default, or what was asked, inside the allowed range
    if (op?.op === "transition") return Object.hasOwn(TRANSITIONS, op.kind ?? "") ? { op: "transition", clip: op.clip, kind: op.kind, duration: transitionLength(op.duration) } : (problems.push(`operation ${i + 1}: a transition's kind is one of ${Object.keys(TRANSITIONS).join(", ")}`), op)
    if (op?.op !== "add_graphic") return op
    const graphic = cleanGraphic({ ...op, ...brandIn(person), at: undefined }, kinds)
    if (!graphic) return problems.push(`operation ${i + 1}: that isn't a graphic the kit draws (a "stat" is digits; text is up to ${TEXT_MAX} characters)`), op
    if (op.at === undefined) return problems.push(`operation ${i + 1}: add_graphic needs \`at\`, a word anchor or a clip edge`), op
    const said = graphicProblems(graphic, { spoken, near: spoken, person })
    if (said.length) return problems.push(`operation ${i + 1}: ${said[0]}; a graphic's words are the speaker's or the person's own`), op
    return { op: "add_motion", block: GRAPHIC_BLOCK, version: GRAPHIC_VERSION, variables: graphic, at: op.at, duration: Number.isInteger(op.duration) ? Math.min(op.duration, 8 * FLICKS) : graphicLength(graphic) }
  })
  return { ops: out, problems }
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
    case "caption_edit":
      return `Changed caption ${op.caption} to "${op.text}"`
    case "caption_emphasis":
      return `Emphasised "${words.get(op.word)?.text ?? op.word}" in caption ${op.caption}`
    case "transition":
      return `Added a ${(TRANSITION_LABELS[op.kind] ?? op.kind).toLowerCase()} transition into ${op.clip}`
    case "add_title":
      return `Added the title "${op.text}" at ${place(op.at)}`
    case "add_motion":
      if (op.block === "custom") return `Added a custom animation${op.variables?.name ? ` "${op.variables.name}"` : ""} at ${place(op.at)}`
      if (op.block === GRAPHIC_BLOCK && op.variables?.mark) return `Marked what you drew with a ${op.variables.style ?? "box"} callout${op.variables.text ? `, "${op.variables.text}"` : ""}, at ${place(op.at)} for ${seconds(op.duration ?? 0)}`
      if (op.block === GRAPHIC_BLOCK) return `Added ${/^[aeiou]/i.test(ALL_GRAPHIC_KINDS[op.variables?.kind]?.label ?? "g") ? "an" : "a"} ${(ALL_GRAPHIC_KINDS[op.variables?.kind]?.label ?? "graphic").toLowerCase()} "${op.variables?.text ?? ""}"${op.variables?.subtitle ? `, "${op.variables.subtitle}"` : ""} at ${place(op.at)}`
      return op.block === "scene" ? `Added an animated ${op.variables?.kind ?? ""} scene, "${op.variables?.text ?? ""}", at ${place(op.at)}` : op.op
    case "grade":
      return `Graded ${op.clip}${op.saturation !== undefined ? `, saturation ${op.saturation}` : ""}${op.gain !== undefined ? `, contrast ${op.gain}` : ""}${op.gamma !== undefined ? `, gamma ${op.gamma}` : ""}${op.lift !== undefined ? `, lift ${op.lift}` : ""}`
    case "speed_ramp":
      return op.peak.n > op.peak.d ? `Ramped ${op.clip} up to ${(op.peak.n / op.peak.d).toFixed(1)}× and back, from ${place(op.from)} to ${place(op.to)}` : `Slow motion in ${op.clip} (${(op.peak.n / op.peak.d).toFixed(2)}×), eased in and out, from ${place(op.from)} to ${place(op.to)}`
    case "freeze":
      return `Froze the frame at ${place(op.at)} for ${seconds(op.duration)}`
    case "add_sfx":
      return `Added a sound effect at ${place(op.peak_at)}`
    case "place_broll":
      return `Laid B-roll ${op.asset} over ${place(op.at)}${op.duration ? ` for ${seconds(op.duration)}` : ""}`
    case "clean_voice":
      return `Cleaned the background noise out of ${op.clip}'s voice`
    case "set_level":
      return `Set ${op.clip} to ${op.db} dB`
    case "add_adjustment":
      // TP9: only a drawn region has words here; any other adjustment reads as it always did
      if (op.region) return `${op.effect === "mask" ? "Darkened everything but" : "Blurred"} what you drew, from ${place(op.at)} for ${seconds(op.duration ?? 0)}`
      return op.op
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
  if (Number.isInteger(selection.from) && Number.isInteger(selection.to)) return `The person marked ${clock(selection.from)} to ${clock(selection.to)} on the cut's timeline, and means it by "this", "here" or "that part" (what it points at is below).`
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

/** A time on the cut as the person reads it in the Studio: 1:02.5 */
export const clock = (flicks) => {
  const total = Math.max(0, flicks) / FLICKS
  const minutes = Math.floor(total / 60)
  return `${minutes}:${(total - minutes * 60).toFixed(1).padStart(4, "0")}`
}

function clipsView(project, index) {
  const { picture, captions, duration } = solve(project, index)
  const lines = picture.map((p) => `[${p.clip} ${clock(p.at)}-${clock(p.end)} from ${p.asset} ${seconds(p.in)}-${seconds(p.out)}; flicks source ${p.in}-${p.out} at ${p.at}-${p.end}]`)
  const said = captions.map((c) => `[caption ${c.clip} ${clock(c.at)}-${clock(c.end)} ${c.look ?? ""} ${JSON.stringify(String(c.text).replace(/[<>]/g, ""))}]`)
  return [`The cut, on its own timeline: it starts at 0:00 and is ${clock(duration)} long. Clips in order:`, lines.join("\n") || "(none yet)", ...(said.length ? ["Captions on screen:", said.join("\n")] : [])].join("\n")
}

const JOIN = /^\s*(?:-|–|—|to|until|till|and|through)\s*$/i
// Seconds as people type them, typos included: s, sec, secs, second, seconds, secods, secnds
const UNIT = "(?:s|sec\\w*|se?c?o?n?d?s?\\b)(?![a-z])"

/**
 * Times in the person's words, on the cut's timeline: 0:05, 1:02.5, 5s, 5 sec, 5 seconds,
 * and ranges joined by to, -, until or and ("from 5 to 9 seconds", "between 0:05 and 0:09").
 * @returns {{ at: number, to?: number }[]} in flicks
 */
export function timesIn(text, { duration = null } = {}) {
  // A mention's place (⟦1⟧, TP1) is never a time; without one this is the text as it was
  const said = withoutPlaces(text)
  // Relative stretches first: "the first 5 seconds", "the last 5 s" (needs the cut's length)
  const relative = []
  for (const m of said.matchAll(new RegExp(`\\b(first|last|final|opening)\\s+(\\d+(?:\\.\\d+)?)\\s*${UNIT}`, "gi"))) {
    const n = Math.round(Number(m[2]) * FLICKS)
    if (/first|opening/i.test(m[1])) relative.push({ at: 0, to: n })
    else if (duration) relative.push({ at: Math.max(0, duration - n), to: duration })
  }
  const text2 = said.replace(new RegExp(`\\b(first|last|final|opening)\\s+\\d+(?:\\.\\d+)?\\s*${UNIT}`, "gi"), (m) => " ".repeat(m.length))
  const tokens = [...text2.matchAll(new RegExp(`(\\d{1,2}):(\\d{2}(?:\\.\\d+)?)|(\\d+(?:\\.\\d+)?)(\\s*${UNIT})?`, "gi"))].map((m) => ({
    t: m[1] !== undefined ? Number(m[1]) * 60 + Number(m[2]) : Number(m[3]),
    unit: m[1] !== undefined || !!m[4],
    start: m.index,
    end: m.index + m[0].length,
  }))
  const between = (a, b) => text2.slice(a.end, b.start)
  const before = (tok) => text2.slice(Math.max(0, tok.start - 24), tok.start)
  // A bare number is a time only as the first half of a range whose second half is one
  const times = tokens.filter((tok, i) => tok.unit || (tokens[i + 1]?.unit && JOIN.test(between(tok, tokens[i + 1]))))
  const out = [...relative]
  for (let i = 0; i < times.length; i++) {
    const next = times[i + 1]
    const at = Math.round(times[i].t * FLICKS)
    if (next && JOIN.test(between(times[i], next)) && next.t > times[i].t) {
      out.push({ at, to: Math.round(next.t * FLICKS) })
      i++
    } else if (duration && /\b(?:after|from|form|frm|fron|since|onwards?|starting(?: at)?|beyond|past)\s*(?:the\s*)?$/i.test(before(times[i]))) out.push({ at, to: duration })
    else if (/\b(?:before|until|till|up to|upto)\s*(?:the\s*)?$/i.test(before(times[i]))) out.push({ at: 0, to: at })
    else out.push({ at })
  }
  return out.slice(0, 8)
}

/** Where a moment of the cut comes from: its clip, and the source time inside it. */
function sourceAt(picture, t) {
  const piece = picture.find((p) => t >= p.at && t < p.end)
  if (!piece) return null
  return { piece, t: piece.in + Math.round(((t - piece.at) * (piece.out - piece.in)) / (piece.end - piece.at || 1)) }
}

/**
 * What each mentioned time points at, worked out by code so the model never does
 * arithmetic on flicks: the clip, the words (with ids) and the captions there.
 */
export function timesView(text, project, index) {
  const { picture, captions, duration } = solve(project, index)
  const asked = timesIn(text, { duration })
  if (!asked.length) return ""
  const words = index.words ?? []
  const wordAt = (piece, t) => words.find((w) => w.asset === piece.asset && t >= w.start && t < w.end) ?? words.find((w) => w.asset === piece.asset && w.start >= t && w.start < piece.out)
  const quote = (list) => JSON.stringify(list.map((w) => w.text).join(" ").replace(/[<>]/g, "").slice(0, 300))
  const lines = asked.map(({ at, to }) => {
    if (at >= duration) return `${clock(at)}: past the end of the cut (${clock(duration)} long).`
    if (to === undefined) {
      const found = sourceAt(picture, at)
      const word = found && wordAt(found.piece, found.t)
      const on = captions.filter((c) => at >= c.at && at < c.end).map((c) => `caption ${c.clip}`)
      return `${clock(at)}: clip ${found?.piece.clip ?? "?"}${word ? `, word ${word.id} ${JSON.stringify(word.text)}` : ", no word spoken there"}${on.length ? `, ${on.join(", ")}` : ""}.`
    }
    const end = Math.min(to, duration)
    const pieces = picture.filter((p) => p.at < end && p.end > at)
    const spans = pieces.map((p) => {
      const from = sourceAt(picture, Math.max(at, p.at))?.t ?? p.in
      const until = Math.min(p.out, Math.max(from + 1, (sourceAt(picture, Math.min(end, p.end) - 1)?.t ?? p.out) + 1))
      return { asset: p.asset, from, until }
    })
    const inside = spans.flatMap(({ asset, from, until }) => words.filter((w) => w.asset === asset && w.end > from && w.start < until))
    const on = captions.filter((c) => c.at < end && c.end > at).map((c) => `caption ${c.clip}`)
    const spoken = inside.length ? `words ${inside[0].id} to ${inside.at(-1).id}: ${quote(inside)}` : "no words spoken"
    // The exact operation to take this stretch out, in each source's own flicks, so a removal
    // never depends on where words happen to fall (found in use: "remove from 25 seconds")
    const removal = spans.map(({ asset, from, until }) => JSON.stringify({ op: "remove_range", asset, from, to: until })).join(" ")
    return `${clock(at)}-${clock(end)}: clip${pieces.length === 1 ? "" : "s"} ${pieces.map((p) => p.clip).join(", ") || "?"}, ${spoken}${on.length ? `; ${on.join(", ")}` : ""}. To take it out exactly: ${removal}`
  })
  return `Times the person mentioned, worked out by code on the cut's timeline:\n${lines.join("\n")}`
}

/**
 * One request in words → a proposal.
 * @param {{ ask: ReturnType<import("./ask.js").createAsk>, project: object, index: object, text: string, selection?: object, signal?: AbortSignal }} input
 * @returns {Promise<{ ops: object[], changes: string[], project: object | null, source: string, reason?: string, calls: number }>}
 */
export async function revise({ ask, project, index, text, selection, history = [], motion = false, pointed = "", intent = false, craft = false, typeKit = false, customMotion = false, mark = null, customBlocks = [], signal }) {
  const assets = project.assets.map((a) => a.id)
  // A marked range reads like a typed one: code says what it points at
  const marked = Number.isInteger(selection?.from) && Number.isInteger(selection?.to) ? ` from ${clock(selection.from)} to ${clock(selection.to)}` : ""
  const times = timesView(`${text}${marked}`, project, index)
  const bin = `Footage in the project: ${project.assets.filter((a) => ["video", "audio"].includes(a.kind)).map((a) => `${a.id} (${a.kind}, ${seconds(a.facts.duration ?? 0)})`).join(", ")}`
  // pointed: the clips the person mentioned (mentions.js), fenced as data; empty, the view is what it was
  // TP9: a drawn box and the saved custom animations, only when there are any; else the view is what it was
  const saved = customMotion && customBlocks.length ? `Saved custom animations: ${customBlocks.map((b) => `${b.clip}${b.name ? ` ${JSON.stringify(b.name)}` : ""}`).join(", ")}` : ""
  const view = [paperEdit(index, { assets }), shotDigest(index, { assets }), clipsView(project, index), bin, selectionText(selection, index), times, pointed, saved, mark ? markView(mark) : ""].filter(Boolean).join("\n\n")
  // The last turns of this chat, so "shorter" or "no, the other one" mean something. The
  // person's lines are theirs; Kriya's are what it said before, not instructions
  const earlier = history.length ? `Earlier in this chat:\n${history.map((h) => `${h.who === "you" ? "Person" : "Kriya"}: ${JSON.stringify(h.text)}`).join("\n")}\n\n` : ""
  const request = [
    `${earlier}The person asks (their own words, trusted): ${JSON.stringify(String(text).slice(0, 2000))}`,
    ...(pointed ? ["A place like ⟦1⟧ in their words is a clip they pointed at; the list above says which asset each is. Use that asset id."] : []),
    "Answer with JSON only. Put in `ops` the operations that do exactly what they ask, and nothing else.",
    "Times like 0:05 are on the cut's timeline; the lines above say which clip, words and captions each time points at. Use those ids, never compute flicks yourself. To take out a stretch the person names by time, use the exact remove_range given for it above, unchanged; for a stretch named by words, remove_range from its first word (edge start) to its last word (edge end). To change what a caption says, caption_edit with its caption id; to remove a caption, ripple_delete its caption id; to caption words, caption_style with their word ids and a look; to put a title on screen, add_title with text and a word anchor; to take background noise out of the voice, clean_voice on each picture clip; to warm or cool the picture, grade with temperature (lower is warmer, 6500 neutral), vibrance or vignette; for a speed ramp or slow motion, speed_ramp on the clip with from and to (source flicks from the lines above, or word anchors) and peak {n, d} (2/1 speeds up and back, 1/2 is eased slow motion); for a constant speed, speed; to lay other footage over a moment, place_broll with a video asset id from the project, at a word anchor or clip edge, and duration in flicks.",
    ...(motion ? [`To put a motion graphic on screen, add_graphic with kind (${Object.entries(GRAPHIC_KINDS).map(([id, kind]) => `${id}: ${kind.label.toLowerCase()}`).join("; ")}), text, subtitle where the kind has a second line, and at (a word anchor). Its words must be the speaker's or the person's own from their request, never yours; a stat's text is digits the speaker says.`, `To dress a cut, transition with the clip the picture arrives in (never the first clip) and kind (${Object.keys(TRANSITIONS).join(", ")}); the cut itself doesn't move.`] : []),
    "Put one plain sentence in `say`: what you changed, or the answer if they asked a question.",
    "If they ask to fix or correct the transcript (names, misheard words), put each wrong word in `corrections` as {word: its id, text: the right word}, only where you are confident from the context.",
    "If they ask for the whole video to be made, directed, edited or improved (not one part of it), set `direct` to an object (with `seconds` and a caption look if they say so) and leave `ops` empty: the Director makes the whole cut.",
    'If none of these can do it, answer {"ops": []}.',
    // editing.intent (TP4): nothing they asked is lost; off, the request is the text it was
    ...(craft ? [CRAFT_PROMPT] : []),
    ...(typeKit ? [TYPE_KIT_PROMPT] : []),
    ...(customMotion ? [CUSTOM_MOTION_PROMPT] : []),
    ...(intent ? ["Also put in `cannot` every piece of their request these operations can't do: their exact words as `evidence`, copied as written, and the nearest thing you can do as `nearest` if there is one. Empty when everything is done."] : []),
  ].join("\n")
  const words = new Map((index.words ?? []).map((w) => [w.id, w]))
  // Operations must apply; a correction on an unknown word is only dropped, never worth a second call
  const person = [...history.filter((h) => h.who === "you").map((h) => h.text), text].join("\n")
  // TP9: custom_motion is answered afterwards by its own slot, so it is set aside here, checked for shape only
  const customClips = new Set(customBlocks.map((b) => b.clip))
  const customProblems = (ops) =>
    ops.flatMap((op, i) => {
      if (op?.op !== "custom_motion") return []
      if (!customMotion) return [`operation ${i + 1}: custom_motion isn't available`]
      if (op.at === undefined) return [`operation ${i + 1}: custom_motion needs \`at\`, a word anchor or a clip edge`]
      if (op.reuse !== undefined) return customClips.has(op.reuse) ? [] : [`operation ${i + 1}: ${op.reuse} isn't a saved custom animation`]
      return typeof op.text === "string" && op.text.trim() ? [] : [`operation ${i + 1}: custom_motion needs text: what to animate`]
    })
  const expand = (asked) => {
    const graphics = motion ? expandGraphics(asked, { index, person, ...(typeKit ? { kinds: ALL_GRAPHIC_KINDS } : {}) }) : { ops: asked, problems: [] }
    const marked = mark ? expandMark(graphics.ops, { mark, project, index, person }) : { ops: graphics.ops, problems: [] }
    const custom = customProblems(marked.ops)
    if (marked.ops.filter((op) => op?.op === "custom_motion").length > 1) custom.push("only one custom_motion at a time")
    return { ops: marked.ops.filter((op) => op?.op !== "custom_motion"), custom: marked.ops.filter((op) => op?.op === "custom_motion"), problems: [...graphics.problems, ...marked.problems, ...custom] }
  }
  const check = ({ ops: asked }) => {
    if (!asked.length) return []
    const { ops, problems } = expand(asked)
    if (problems.length) return problems
    const tried = apply(project, ops, { index, author: "agent" })
    return tried.applied ? [] : tried.diagnostics.map((d) => `operation ${d.op + 1}: ${d.message}`)
  }
  const base = pointingSchema(typeKitSchema(craftSchema(consoleSchema(motion), craft), typeKit), { customMotion, mark: !!mark })
  const schema = intent ? { ...base, properties: { ...base.properties, cannot: { type: "array", maxItems: 8, items: { type: "object", properties: { evidence: { type: "string", maxLength: 300 }, nearest: { type: "string", maxLength: 160 } }, required: ["evidence"], additionalProperties: false } } } } : base
  // The `cannot` list is tidied before the schema sees it, so it never costs a repair call (EH-64)
  const tidy = intent ? (value) => ({ ...tidyConsole(value), cannot: tidyIntent({ cannot: value?.cannot }, {}).cannot }) : tidyConsole
  const answer = await ask({ task: "console", tier: "budget", schema, view, request, maxOutput: 2000, check, clean: tidy, fallback: () => ({ ops: [] }), signal, priority: 0 })
  const expanded = expand(answer.value.ops)
  const ops = expanded.problems.length ? [] : expanded.ops
  const custom = expanded.problems.length ? [] : expanded.custom.map((op) => ({ at: op.at, ...(Number.isInteger(op.duration) ? { duration: op.duration } : {}), ...(op.reuse !== undefined ? { reuse: op.reuse } : { text: String(op.text).replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, 300) }) }))
  const tried = ops.length ? apply(project, ops, { index, author: "agent" }) : null
  // A correction that changes nothing, or isn't a known word, isn't offered
  const corrections = (answer.value.corrections ?? []).map((c) => ({ word: c.word, text: cleanWord(c.text) })).filter((c) => words.has(c.word) && c.text && c.text !== words.get(c.word).text)
  const direct = answer.value.direct === true ? {} : answer.value.direct && typeof answer.value.direct === "object" ? answer.value.direct : null
  return {
    ops: tried?.applied ? ops : [],
    changes: tried?.applied ? ops.map((op) => describe(op, index)) : [],
    corrections: corrections.map((c) => ({ ...c, change: `Corrected "${words.get(c.word).text}" to "${c.text}"` })),
    direct,
    say: typeof answer.value.say === "string" ? answer.value.say.replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, 600) : "",
    project: tried?.applied ? tried.project : null,
    source: answer.source,
    reason: answer.reason,
    calls: answer.calls,
    // TP9: a custom animation to write (or a saved one to place), for the Host's own slot; only with the switch on
    ...(custom.length ? { custom } : {}),
    // What it couldn't do, in the person's own words: only words that are in their message
    ...(intent ? { cannot: (answer.value.cannot ?? []).filter((c) => grounded(c.evidence, text, "")).map((c) => ({ said: c.evidence.replace(/[\u0000-\u001f<>]/g, " ").trim(), ...(c.nearest ? { nearest: c.nearest.replace(/[\u0000-\u001f<>]/g, " ").trim() } : {}) })) } : {}),
  }
}
