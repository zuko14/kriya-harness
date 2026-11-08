// The repair ladder (QUALITY_GATES §4, EDD-19, ED10). A failure carries a kind, and
// each kind has a known fix: rung 0 is a deterministic fix by code, rung 1 a re-solve
// with a changed constraint, rung 3 the person. Rules: at most three rounds; never keep
// a worse attempt; never cut a must-keep to pass a gate; never weaken a threshold
// (the ladder has none to weaken: the gates' thresholds are closed over by `check`).
// shortcut: rung 2 (a bounded model call, e.g. rewrite a caption that won't fit) isn't built; those go to the person.

import { apply } from "../core/ops.js"

export const ROUNDS = 3

const LOOK_MIN_SIZE = 0.025

/** Ranks lexicographically: blocking failures, then brief misses, then notes. Lower is better. */
export const rankOf = (checked) => [checked.blocking, checked.briefMisses, checked.notes]
export const better = (a, b) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i]
  return false
}

const clipsOf = (project, role) => {
  const sequence = project.sequences.find((q) => q.id === project.active)
  const tracks = new Map(sequence.tracks.map((t) => [t.id, t.role]))
  return sequence.clips.filter((c) => tracks.get(c.track) === role)
}
const levelOf = (clip) => clip.effects.find((e) => e.type === "level")?.db ?? 0

/**
 * The fixes code knows for a set of gate results, cheapest rung first. Each fix is
 * typed operations, never a threshold. A kind with no fix goes to the person.
 * @returns {{ fixes: { rung: number, gate: string, kind: string, ops: object[], why: string }[], person: { gate: string, kind: string, message: string }[] }}
 */
export function fixesFor(gates, project) {
  const fixes = []
  const person = []
  const look = project.look.caption ?? {}
  const failed = gates.filter((g) => g.status === "failed" && g.severity === "block")
  for (const gate of failed) {
    const kinds = new Set((gate.failures ?? [{ kind: gate.numbers?.first?.kind ?? "failed" }]).map((f) => f.kind))
    for (const kind of kinds) {
      const first = (gate.failures ?? []).find((f) => f.kind === kind) ?? gate.numbers?.first ?? {}
      if (gate.id === "QG-09" && kind === "low_contrast" && look.scrim !== true) fixes.push({ rung: 0, gate: gate.id, kind, ops: [{ op: "set_look", caption: { scrim: true } }], why: "Added a scrim behind the captions for contrast." })
      else if (gate.id === "QG-08" && ["on_face", "outside_safe_zone", "overlap", "clipped"].includes(kind) && (look.size ?? 0.046) * 0.85 >= LOOK_MIN_SIZE) fixes.push({ rung: 1, gate: gate.id, kind, ops: [{ op: "set_look", caption: { size: Math.round((look.size ?? 0.046) * 0.85 * 1000) / 1000 } }], why: "Made the captions smaller, so the layout solver has room to place them clear." })
      else if (gate.id === "QG-06" && kind === "music_masks_speech") {
        const ops = clipsOf(project, "music").map((c) => ({ op: "set_level", clip: c.id, db: Math.round((levelOf(c) - (first.needed - first.margin + 1)) * 10) / 10 }))
        if (ops.length) fixes.push({ rung: 0, gate: gate.id, kind, ops, why: `Brought the music down ${Math.round((first.needed - first.margin + 1) * 10) / 10} dB under the speech.` })
      } else if (gate.id === "QG-06" && kind === "effect_over_voice") {
        const ops = clipsOf(project, "sfx").map((c) => ({ op: "set_level", clip: c.id, db: Math.round((levelOf(c) - (first.over - first.allowed + 1)) * 10) / 10 }))
        if (ops.length) fixes.push({ rung: 0, gate: gate.id, kind, ops, why: `Brought the sound effects down ${Math.round((first.over - first.allowed + 1) * 10) / 10} dB.` })
      } else person.push({ gate: gate.id, kind, message: gate.message })
    }
  }
  return { fixes: fixes.sort((a, b) => a.rung - b.rung), person }
}

/**
 * Runs the ladder from a checked attempt.
 * @param {{ project: object, ops: object[], file: string, plan: object, checked: object }} start
 * @param {{ index: object, render: (project: object) => Promise<{ file: string, plan: object }>, check: (file: string, plan: object, project: object) => Promise<object>, keepsMustKeeps: (project: object) => boolean, rounds?: number, fixes?: typeof fixesFor, signal?: AbortSignal }} io
 * @returns {Promise<{ best: object, attempts: object[], person: object[] }>}
 */
export async function repairLadder(start, { index, render, check, keepsMustKeeps, rounds = ROUNDS, fixes = fixesFor, signal }) {
  let best = start
  const attempts = []
  let person = []
  const tried = new Set()
  for (let round = 1; round <= rounds; round++) {
    if (signal?.aborted) break
    if (best.checked.blocking === 0 && best.checked.briefMisses === 0) break
    const proposed = fixes(best.checked.gates, best.project)
    person = proposed.person
    const fresh = proposed.fixes.filter((fix) => !tried.has(JSON.stringify(fix.ops)))
    if (!fresh.length) break
    fresh.forEach((fix) => tried.add(JSON.stringify(fix.ops)))
    const ops = fresh.flatMap((fix) => fix.ops)
    const step = apply(best.project, ops, { index, author: "code" })
    if (!step.applied) {
      attempts.push({ round, fixes: fresh.map(({ ops: _, ...f }) => f), accepted: false, reason: step.diagnostics[0].message })
      continue
    }
    // Never cut a must-keep to pass a gate: such a fix is the person's to make
    if (!keepsMustKeeps(step.project)) {
      attempts.push({ round, fixes: fresh.map(({ ops: _, ...f }) => f), accepted: false, reason: "it would cut a line the brief must keep" })
      continue
    }
    const { file, plan } = await render(step.project)
    const checked = await check(file, plan, step.project)
    const attempt = { project: step.project, ops: [...best.ops, ...ops], file, plan, checked }
    const accepted = better(rankOf(checked), rankOf(best.checked))
    attempts.push({ round, fixes: fresh.map(({ ops: _, ...f }) => f), rank: rankOf(checked), accepted })
    // Never keep a worse attempt: it is set aside and the better one stays
    if (accepted) best = attempt
  }
  if (best.checked.blocking > 0 || best.checked.briefMisses > 0) person = fixes(best.checked.gates, best.project).person
  else person = []
  return { best, attempts, person }
}
