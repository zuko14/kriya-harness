// Watch and fix (TP8, CRAFT_UPGRADE §6.1, EDD-68): each finding of the Viewer's Report maps to
// one typed fix, made by code: a punch-in on a still stretch, a graphic moved off a crowded
// moment, a pause trimmed, a repeated cutaway swapped or removed, a jump in level evened. The
// draft is rendered and gated again, and a fix is kept only when the score rises and the gates
// are no worse; a cut that passes its gates is never replaced by one that doesn't (EH-74). The
// rounds are the repair ladder's own, not more on top of them.

import { apply } from "../core/ops.js"
import { better, rankOf, ROUNDS } from "../loop/repair.js"
import { sayFinding } from "./viewer.js"

const FLICKS = 705_600_000
const PUNCH = 1.12
const PAD = Math.round(0.25 * FLICKS)
export const FIX_ROUNDS = 2

/** The fix rounds a candidate has left: two at most, out of what its repair ladder didn't use. */
export const roundsLeft = (repairs = []) => Math.max(0, Math.min(FIX_ROUNDS, ROUNDS - repairs.length))

const levelOf = (clip) => clip?.effects.find((e) => e.type === "level")?.db ?? 0
const clipOf = (project, id) => project.sequences.find((q) => q.id === project.active).clips.find((c) => c.id === id)

/**
 * The typed operations for a report's findings. A finding with no safe fix is left for the person.
 * @param {{ findings: object[] }} report
 * @param {ReturnType<import("./viewer.js").timelineOf>} timeline
 * @returns {{ fixes: { kind: string, at: number, ops: object[], why: string }[], left: object[] }}
 */
export function fixesFor(report, project, index, timeline) {
  const fixes = []
  const left = []
  const indexWords = index.words ?? []
  const pictures = project.assets.filter((a) => a.kind === "video" && a.facts?.width && (a.facts.duration ?? 0) > FLICKS)
  for (const f of report.findings) {
    if (f.kind === "dull") {
      const at = f.at + Math.round((f.end - f.at) / 3)
      const duration = Math.min(Math.round(1.5 * FLICKS), f.end - at)
      if (duration > FLICKS / 2 && !timeline.zooms.some((z) => z.at < at + duration && z.end > at)) fixes.push({ kind: f.kind, at: f.at, ops: [{ op: "punch_in", at, duration, scale: PUNCH }], why: `Punched in on ${sayFinding(f)}.` })
      else left.push(f)
    } else if (f.kind === "crowded") {
      // The latest graphic of the moment moves to where nothing else is on screen; a scene stays on its words
      const graphic = timeline.texts.filter((t) => f.clips.includes(t.clip) && t.kind === "graphic").sort((a, b) => b.at - a.at)[0]
      const length = graphic ? graphic.end - graphic.at : 0
      const clear = graphic && [f.end, ...timeline.texts.map((t) => t.end)].sort((a, b) => a - b).find((t) => t >= f.end && t + length <= timeline.duration && timeline.texts.filter((x) => x.clip !== graphic.clip && x.at < t + length && x.end > t).length < 2)
      if (graphic && clear !== undefined) fixes.push({ kind: f.kind, at: f.at, ops: [{ op: "ripple_delete", clip: graphic.clip }, { op: "add_motion", block: graphic.block.blockId, version: graphic.block.version, variables: graphic.block.variables, at: clear, duration: length }], why: `Moved a graphic off ${sayFinding(f)}.` })
      else left.push(f)
    } else if (f.kind === "dead_air") {
      // Trimmed inside its own clip, a quarter second kept each side, never through a word
      const piece = timeline.base.find((p) => p.at <= f.at && p.end >= f.end)
      const from = piece && piece.in + (f.at - piece.at) + PAD
      const to = piece && piece.in + (f.end - piece.at) - PAD
      if (piece && to - from > FLICKS / 4 && !indexWords.some((w) => w.asset === piece.asset && w.start < to && w.end > from)) fixes.push({ kind: f.kind, at: f.at, ops: [{ op: "remove_range", asset: piece.asset, from, to }], why: `Trimmed ${sayFinding(f)}.` })
      else left.push(f)
    } else if (f.kind === "repeated_cutaway") {
      // Another of the person's clips not already on screen nearby, from its start; else the repeat goes
      const near = new Set(timeline.cutaways.filter((c) => Math.abs(c.at - f.at) < 10 * FLICKS).map((c) => c.asset))
      const base = new Set(timeline.base.map((p) => p.asset))
      const other = pictures.find((a) => !near.has(a.id) && !base.has(a.id) && a.facts.duration >= f.end - f.at)
      fixes.push({ kind: f.kind, at: f.at, ops: [{ op: "ripple_delete", clip: f.clip }, ...(other ? [{ op: "place_broll", asset: other.id, at: f.at, in: 0, duration: f.end - f.at }] : [])], why: other ? `Swapped ${sayFinding(f)} for another of your clips.` : `Took out ${sayFinding(f)}.` })
    } else if (f.kind === "level_jump") {
      // The louder side's own clips come down toward the quieter, never past it
      const louder = timeline.base.filter((p) => p.at < f.louder.end && p.end > f.louder.at)
      const quieter = new Set(timeline.base.filter((p) => !louder.includes(p)).map((p) => p.clip))
      const clips = [...new Set(louder.map((p) => p.clip))].filter((id) => !quieter.has(id))
      const down = Math.round((Math.abs(f.db) - 2) * 10) / 10
      if (clips.length) fixes.push({ kind: f.kind, at: f.at, ops: clips.map((id) => ({ op: "set_level", clip: id, db: Math.round((levelOf(clipOf(project, id)) - down) * 10) / 10 })), why: `Evened ${sayFinding(f)} (${down} dB).` })
      else left.push(f)
    }
  }
  return { fixes, left }
}

const passing = (checked) => checked.blocking === 0 && checked.briefMisses === 0

/** The keep rule (ET-DL-03, EH-74): a higher score, gates no worse, and never a passing cut swapped for a failing one. */
export function keepFix(before, after) {
  if (passing(before.checked) && !passing(after.checked)) return { kept: false, reason: "it would fail a gate the cut passed" }
  if (better(rankOf(before.checked), rankOf(after.checked))) return { kept: false, reason: "the gates were worse" }
  if (!(after.report.score > before.report.score)) return { kept: false, reason: `the score didn't rise (${before.report.score} → ${after.report.score})` }
  return { kept: true }
}

/**
 * The loop over one checked attempt.
 * @param {{ project: object, ops: object[], file: string, plan: object, checked: object }} start
 * @param {{ index: object, view: (attempt: object) => Promise<{ report: object, timeline: object }>, render: (project: object) => Promise<{ file: string, plan: object }>, check: (file: string, plan: object, project: object) => Promise<object>, rounds?: number, fixes?: typeof fixesFor, signal?: AbortSignal }} io
 * @returns {Promise<{ best: object, rounds: object[], left: object[] }>}
 */
export async function watchAndFix(start, { index, view, render, check, rounds = FIX_ROUNDS, fixes = fixesFor, signal }) {
  let best = { ...start, ...(await view(start)) }
  const log = []
  const tried = new Set()
  for (let round = 1; round <= Math.min(rounds, FIX_ROUNDS); round++) {
    if (signal?.aborted || !best.report.findings.length) break
    const proposed = fixes(best.report, best.project, index, best.timeline).fixes.filter((fix) => !tried.has(JSON.stringify(fix.ops)))
    if (!proposed.length) break
    proposed.forEach((fix) => tried.add(JSON.stringify(fix.ops)))
    const ops = proposed.flatMap((fix) => fix.ops)
    const step = apply(best.project, ops, { index, author: "code" })
    const said = proposed.map(({ ops: _, ...fix }) => fix)
    if (!step.applied) {
      log.push({ round, fixes: said, kept: false, reason: step.diagnostics[0].message })
      continue
    }
    const { file, plan } = await render(step.project)
    const checked = await check(file, plan, step.project)
    const attempt = { project: step.project, ops: [...best.ops, ...ops], file, plan, checked }
    Object.assign(attempt, await view(attempt))
    const verdict = keepFix(best, attempt)
    log.push({ round, fixes: said, was: best.report.score, score: attempt.report.score, ...verdict })
    if (verdict.kept) best = attempt
  }
  return { best, rounds: log, left: best.report.findings }
}

/** What the loop did, in the person's words: each kept fix, and each dropped round with its reason. */
export function sayWatch(rounds) {
  return rounds.map((r) => (r.kept ? `Director: ${r.fixes.map((f) => f.why).join(" ")} Score ${r.was} → ${r.score}.` : `Director: tried ${r.fixes.map((f) => f.why.replace(/\.$/, "").toLowerCase()).join("; ")}, and kept the cut as it was: ${r.reason}.`))
}
