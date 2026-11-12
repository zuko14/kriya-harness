// "Watch the Director edit" (editing.livePreview): the make's own operations, grouped by
// what they do and applied in order onto the cut it started from, so the Studio can show the
// film as each layer lands, live while a make runs and as a replay after. Every layer is real
// code state: the operations the Director produced, applied by apply(). Nothing here writes
// the project's history: the views are previews, never evidence (the render and gates are).

import { apply } from "../core/ops.js"
import { solve } from "../core/solver.js"
import { describe } from "../director/revise.js"
import { previewOf } from "./preview.js"

/** The layers, in the order they're shown. `raw` is the cut before the make. */
export const LAYERS = [
  { id: "raw", label: "Raw footage" },
  { id: "cuts", label: "Cuts & pacing" },
  { id: "broll", label: "B-roll & transitions" },
  { id: "look", label: "Look & filters" },
  { id: "captions", label: "Captions & motion" },
  { id: "audio", label: "Audio mix" },
]
const RANK = Object.fromEntries(LAYERS.map((layer, i) => [layer.id, i]))
const OF = {
  broll: ["place_broll", "place_over", "transition"],
  look: ["grade", "match_color", "apply_lut", "fix_exposure", "set_look", "add_effect", "add_adjustment", "remove_effect"],
  captions: ["caption_style", "caption_edit", "caption_emphasis", "add_title", "add_lower_third", "add_motion", "text_behind", "set_type_kit"],
  audio: ["add_sfx", "set_music", "music_shape", "duck", "clean_voice", "set_level", "room_tone"],
}
const LAYER_OF = new Map(Object.entries(OF).flatMap(([layer, ops]) => ops.map((op) => [op, layer])))
// Everything else (cuts, framing, assets, the brief) goes in the first layer: later ones may need it
export const layerOf = (op) => LAYER_OF.get(op?.op) ?? "cuts"

/**
 * Each layer's project: layer k is the start with every operation of layer ≤ k applied, in the
 * make's own order. A prefix that doesn't apply on its own is said, and the layer shows the one before.
 * @returns {{ id: string, label: string, ops: number, changes: string[], project: object, skipped?: string }[]}
 */
export function layersOf(before, ops, index) {
  const out = [{ ...LAYERS[0], ops: 0, changes: [], project: before }]
  let last = before
  for (const layer of LAYERS.slice(1)) {
    const own = ops.filter((op) => layerOf(op) === layer.id)
    const upTo = ops.filter((op) => RANK[layerOf(op)] <= RANK[layer.id])
    const changes = own.filter((op) => !(op.op === "caption_style" && op.words?.length)).slice(0, 4).map((op) => safeDescribe(op, index))
    if (!own.length) {
      out.push({ ...layer, ops: 0, changes, project: last })
      continue
    }
    const step = apply(before, upTo, { index, author: "agent" })
    if (step.applied) last = step.project
    out.push({ ...layer, ops: own.length, changes, project: last, ...(step.applied ? {} : { skipped: step.diagnostics[0]?.message ?? "it doesn't apply on its own" }) })
  }
  return out
}

function safeDescribe(op, index) {
  try {
    return describe(op, index)
  } catch {
    return op.op.replaceAll("_", " ")
  }
}

/** What the monitor and the timeline draw for a project: its preview plan and the solver's timeline. */
export function viewOf(project, index, { runtimeVersion, tiles, fonts }) {
  const { picture, audio, overlays, captions, duration } = solve(project, index)
  return { preview: previewOf(project, index, { runtimeVersion, tiles, ...(fonts ? { fonts } : {}) }), timeline: { picture, audio, overlays, captions, duration } }
}

/**
 * The newest finished make whose cut is in the project's history, as the agent's entry it landed
 * as: its parent is the cut it started from, its operations what it did. Null when there's none.
 */
export function lastMadeEntry(rows, log) {
  for (const row of [...rows].reverse()) {
    if (row.kind !== "make") continue
    let head = null
    try {
      head = JSON.parse(row.dispatch ?? "{}").head ?? null
    } catch {}
    const entry = log.entries.find((e) => e.id === head && e.author === "agent")
    if (entry) return { entry, job: row.id }
  }
  return { entry: null, job: null }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`

/** A gate result as the Studio lists it: its id, status and the gate's own message, nothing else. */
export const gateRow = ({ id, status, severity, message }) => ({ id, status, severity, ...(message ? { message } : {}) })

/**
 * The make's live events (makeReel's onLive) turned into what the Studio shows, sent through `send`.
 * A view that can't be drawn is left out; a failure here never touches the make.
 */
export function liveFeed({ index, runtimeVersion, tiles, fonts, send }) {
  const view = (project) => {
    try {
      return viewOf(project, index, { runtimeVersion, tiles, fonts })
    } catch {
      return {}
    }
  }
  return (event) => {
    try {
      if (event.stage === "plan") {
        send({ stage: "story", text: `Chose the story: ${plural(event.ops.length, "planned change")}${event.round > 1 ? ` (round ${event.round})` : ""}.`, round: event.round })
        for (const layer of layersOf(event.before, event.ops, index).slice(1)) {
          if (!layer.ops) continue
          send({ stage: layer.id, text: `${layer.label}: ${plural(layer.ops, "change")}.`, changes: layer.changes, round: event.round, ...(layer.skipped ? { skipped: layer.skipped } : {}), ...view(layer.project) })
        }
        return
      }
      if (event.stage === "render") return send({ stage: "render", text: event.repair ? "Rendering a repaired cut to check it again." : "Rendering the master to check it.", ...(event.project ? view(event.project) : {}) })
      if (event.stage === "check") {
        const gates = (event.gates ?? []).map(gateRow)
        const passed = gates.filter((g) => g.status === "passed").length
        const failed = gates.filter((g) => g.status === "failed").length
        const rest = gates.length - passed - failed
        return send({ stage: "check", text: `Checked: ${passed} passed, ${failed} failed${rest ? `, ${rest} not checked or not applicable` : ""}.`, gates })
      }
      if (event.stage === "repair") {
        const attempts = (event.attempts ?? []).map((a) => ({ round: a.round, accepted: a.accepted === true, fixes: (a.fixes ?? []).map((f) => f.why ?? f.kind ?? "fix"), ...(a.reason ? { reason: a.reason } : {}) }))
        const kept = attempts.filter((a) => a.accepted).length
        return send({ stage: "repair", text: attempts.length ? `Repairs: ${plural(attempts.length, "round")} tried, ${kept} kept.` : "No repair could help: this is yours to decide.", attempts, ...(event.project ? view(event.project) : {}) })
      }
      if (event.stage === "watch") {
        const rounds = (event.rounds ?? []).map((r) => ({ round: r.round, kept: r.kept === true, fixes: (r.fixes ?? []).map((f) => f.kind), ...(r.reason ? { reason: r.reason } : {}) }))
        return send({ stage: "watch", text: `Watched the draft: ${plural(rounds.length, "round")}, ${rounds.filter((r) => r.kept).length} kept.`, rounds, ...(event.project ? view(event.project) : {}) })
      }
    } catch {
      // A live view is a courtesy: the make goes on without it
    }
  }
}
