// A change asked for after a cut exists is a change to that cut (2026-11-10): the Director
// revises the plan it made, the story stays unless the length or the trims change, and the
// person's own edits since are replayed on the remade cut. Pure: the Host keeps the record.

import { solve } from "../core/solver.js"

// The plan sets these on every make, so an older one isn't carried over it
const PLANS_OWN = new Set(["set_brief", "set_format", "add_deliverable", "name_version"])

/**
 * The operations landed after a version, oldest first: what the person (or the console, on
 * their accepting) did to the cut since it was made.
 * @returns {object[] | null} null when HEAD doesn't descend from that version (the make was undone)
 */
export function editsSince(log, head) {
  const byId = new Map(log.entries.map((e) => [e.id, e]))
  const chain = []
  for (let at = log.head; at !== head; at = byId.get(at).parent) {
    if (at === null || !byId.has(at)) return null
    chain.unshift(byId.get(at))
  }
  return chain.flatMap((e) => e.ops).filter((op) => !PLANS_OWN.has(op.op))
}

/** The last make's story, when this brief cuts the same footage to the same length; else null and it's chosen again. */
export function storyFor(last, brief = {}) {
  if (!last?.story || !last.brief) return null
  // A film of several files keeps a story per part; a single take keeps one. Neither is read as the other,
  // and a record with no `parts` (written before TP2) is a single take's
  if ((last.story.parts !== undefined) !== (brief.assembly !== undefined)) return null
  const same = last.brief.targetDuration === brief.targetDuration && JSON.stringify(last.brief.cuts ?? []) === JSON.stringify(brief.cuts ?? [])
  return same ? last.story : null
}

/**
 * Where each clip of the cut before went in the remade one (a remake gives every clip a new
 * id): a caption by its first word, footage by its track and the most source time it shares.
 * A clip's own source is word anchors, so the times come from the solved timelines.
 * @returns {Map<string, string>}
 */
export function remapIds(before, after, index) {
  const clipsOf = (project) => project.sequences.find((q) => q.id === project.active)?.clips ?? []
  const caption = (clip) => clip.effects?.find((e) => e.type === "caption")
  // Each footage clip's stretch of its source, as played: asset, first in, last out
  const spans = (project) => {
    const out = new Map()
    for (const p of solve(project, index).picture) {
      if (p.hold) continue
      const span = out.get(p.clip)
      if (span) Object.assign(span, { in: Math.min(span.in, p.in), out: Math.max(span.out, p.out) })
      else out.set(p.clip, { asset: p.asset, in: p.in, out: p.out, echo: !!p.echo })
    }
    return out
  }
  const [was, now] = [spans(before), spans(after)]
  const next = clipsOf(after)
  const ids = new Map()
  for (const old of clipsOf(before)) {
    if (next.some((c) => c.id === old.id)) continue // it survived the remake as it is
    const words = caption(old)?.words
    let found = null
    if (words?.length) found = next.find((c) => caption(c)?.words?.[0] === words[0])?.id ?? null
    else if (was.has(old.id)) {
      const a = was.get(old.id)
      // By the overlap of source stretches, never by file alone: one file can be two parts of a film, and an
      // edit made on one half must not land on the other (EH-61). Equal overlaps go to the nearer start
      let most = 0
      let near = Infinity
      for (const [id, b] of now) {
        if (b.asset !== a.asset || b.echo !== a.echo || clipsOf(after).find((c) => c.id === id)?.track !== old.track) continue
        const shared = Math.min(a.out, b.out) - Math.max(a.in, b.in)
        const off = Math.abs(b.in - a.in)
        if (shared > most || (shared > 0 && shared === most && off < near)) ((most = shared), (near = off), (found = id))
      }
    }
    if (found) ids.set(old.id, found)
  }
  return ids
}

// What a remake undoes: edits to the picture, the captions and the voice, which it rebuilds.
// A title, a graphic, B-roll, a marker or a sound sits on its own track and is still there, so
// replaying it would put it on screen twice; the music and the opening are the plan's to set
const REMADE = new Set(["keep_range", "remove_range", "use_take", "reorder", "trim", "split", "ripple_delete", "punch_in", "reframe", "speed", "speed_ramp", "freeze", "stabilize", "set_camera", "caption_style", "caption_edit", "caption_emphasis", "text_behind", "transition", "clean_voice", "set_level", "grade", "match_color", "apply_lut", "fix_exposure"])

/**
 * The edits worth replaying on a remade cut: those the remake undid. One aimed at a clip
 * that was already gone before the remake has nothing left to do, and is left out quietly.
 */
export function replayable(edits, before) {
  const there = new Set((before.sequences.find((q) => q.id === before.active)?.clips ?? []).map((c) => c.id))
  return edits.filter((op) => REMADE.has(op.op) && ["clip", "caption"].every((key) => typeof op[key] !== "string" || there.has(op[key])))
}

/** An operation pointed at the remade cut's clips. */
export function remapOp(op, ids) {
  const out = { ...op }
  for (const key of ["clip", "caption", "after"]) if (typeof out[key] === "string" && ids.has(out[key])) out[key] = ids.get(out[key])
  return out
}

const count = (noun) => (list) => (list?.length ? `${list.length} ${noun}${list.length === 1 ? "" : "s"}` : "none")
const onOff = (value) => (value ? "on" : "off")
const plain = (value) => (value === undefined || value === null || value === false || value === "" ? "none" : String(value))
const LINES = [
  ["format", "Format", plain],
  ["seconds", "Length", (v) => (v ? `${v} s` : "the recipe's")],
  ["captions", "Captions", plain],
  ["grade", "Colour look", plain],
  ["music", "Music", (v) => plain(v).replace(/^generated:/, "")],
  ["cleanVoice", "Voice cleanup", onOff],
  ["hook", "Hook line", (v) => (v ? "chosen" : "none")],
  ["coldOpen", "Cold open", (v) => (v ? `${v.from} to ${v.to}` : "none")],
  ["cutSound", "Sound on cuts", plain],
  ["introSound", "Sound into the story", plain],
  ["punches", "Punch-ins", plain],
  ["angles", "Wide and tight angles", onOff],
  ["broll", "B-roll", plain],
  ["titles", "Title cards", onOff],
  ["ramps", "Speed ramp", onOff],
  ["cuts", "Trims", count("stretch")],
  ["scenes", "Animated scenes", count("scene")],
  ["graphics", "Motion graphics", count("graphic")],
  ["transition", "Transitions", plain],
  ["transitionAll", "Transitions on every cut", onOff],
  ["pictures", "Pictures", count("picture")],
  ["terms", "Definitions", count("definition")],
  ["assembly", "The film's order", (v) => (v?.parts?.length ? `${v.parts.length} parts` : "none")],
]

/** What a revised plan changes, in words, from the two briefs alone: never from a model's pitch. */
export function planDiff(before = {}, after = {}) {
  return LINES.flatMap(([key, label, show]) => {
    const [was, now] = [show(before[key]), show(after[key])]
    return was === now && JSON.stringify(before[key]) === JSON.stringify(after[key]) ? [] : was === now ? [`${label}: changed`] : [`${label}: ${was} → ${now}`]
  })
}
