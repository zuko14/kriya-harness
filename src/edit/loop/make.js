// A "make" job (DIRECTOR_AND_AGENT §3): brief → recipe → story → assemble → dress →
// check, through the Edit Loop. Candidates climb the fidelity ladder (EDIT_LOOP §5):
// each is judged at F0 on its plan, and only a sound plan is rendered as a master
// and gated (F5). The person's HEAD is the starting best, so stopping at any point
// leaves a playable project; the winner lands as one entry, rebased if the person
// edited meanwhile, and their edit never moves (§9).

import { apply } from "../core/ops.js"
import { compile } from "../core/plan.js"
import { runGates } from "../gates/index.js"
import { remapIds, remapOp, replayable } from "../director/continuity.js"
import { planReel, recipeFor } from "../recipes/reel.js"
import { search } from "./loop.js"
import { repairLadder } from "./repair.js"
import { roundsLeft, watchAndFix } from "../director/watch-fix.js"

const FLICKS = 705_600_000
const TEXT_GATES = new Set(["QG-08", "QG-09", "QG-10", "QG-11"])

/** F0: what the plan alone shows. Nothing renders for an attempt that fails here (ET-LOOP-04). */
export function planVerdict(project, index, recipe, { engineVersion = "f0", runtimeVersion = "f0" } = {}) {
  const plan = compile(project, index, { engineVersion, runtimeVersion })
  const brief = project.brief
  let briefMisses = 0
  if (brief?.targetDuration && Math.abs(plan.duration - brief.targetDuration) > brief.targetDuration * (recipe.thresholds?.lengthTolerance ?? 0.15)) briefMisses++
  const plays = (word) => plan.segments.some((s) => s.node.picture.some((p) => p.asset === word.asset && word.start >= p.in && word.end <= p.out))
  for (const id of brief?.mustKeep ?? []) {
    const sentence = index.sentences.find((s) => s.id === id)
    const words = sentence ? index.words.filter((w) => w.asset === sentence.asset && w.start >= sentence.start && w.end <= sentence.end && !w.flags.includes("filler")) : []
    if (!words.length || !words.every(plays)) briefMisses++
  }
  const blocking = plan.duration === 0 ? 1 : 0
  return { level: "F0", plan, blocking, briefMisses, notes: plan.issues.length, quality: brief?.targetDuration ? Math.max(0, 1 - Math.abs(plan.duration - brief.targetDuration) / brief.targetDuration) : 0 }
}

/**
 * @param {{
 *   project: object, head: string | null, index: object, asset: string, brief?: object,
 *   ask: Function, render: (project: object, deliverable: string, signal?: AbortSignal) => Promise<{ file: string, plan: object }>,
 *   sourcePath: (asset: string) => string, signal?: AbortSignal, onStage?: (stage: string) => void, run?: Function,
 *   gateKit?: { tilePath?: Function, motion?: object, work?: string }, the Engine's tiles and Chrome, for QG-08 and QG-09
 *   watch?: { view: (attempt: object) => Promise<{ report: object, timeline: object }> } | null, the Director's watch-and-fix (TP8, editing.directorLoop); absent, the make as before
 *   onLive?: (event: object) => void, the make's real state as it happens (editing.livePreview): each planned candidate, each render, gate results, repairs and watch rounds. Never written to history; a throw here is ignored
 * }} input
 */
export async function makeReel({ project, head, index, asset, brief = {}, ask, render, sourcePath, signal, onStage = () => {}, run, gateKit = {}, planner = null, plannerRecipe = null, edits = [], watch = null, onLive = null }) {
  // edits: what the person did to the last cut, replayed on each candidate before it is rendered and gated
  // planner: a recipe with no variants to try (a programme, a montage), instead of the reel
  const recipe = plannerRecipe ?? recipeFor(brief)
  let calls = 0
  const notes = []
  const slots = {}
  const live = (event) => {
    if (!onLive) return
    try {
      onLive(event)
    } catch {}
  }

  const variantOf = async (variant) => {
    onStage("story")
    const made = planner ? await planner() : await planReel({ project, index, asset, ask, brief, variant, signal })
    calls += made.calls
    Object.assign(slots, made.slots)
    for (const note of made.notes) if (!notes.includes(note)) notes.push(note)
    const candidate = { ...carryEdits(made, edits, { before: project, index }), variant }
    live({ stage: "plan", before: project, ops: candidate.ops, round: variant.tighter ? 2 : variant.noHook ? 3 : 1 })
    return candidate
  }

  const evaluate = async (candidate) => {
    if (candidate.start) return { blocking: Infinity, briefMisses: Infinity, notes: 0, quality: 0, level: "start" }
    const f0 = planVerdict(candidate.project, index, recipe)
    if (f0.blocking || f0.briefMisses) return { ...f0, plan: undefined }
    onStage("check")
    const deliverable = candidate.project.deliverables.find((d) => d.preset === recipe.deliverable.preset)
    const check = (file, plan, project) => runGates({ file, plan, project, index, sourcePath, thresholds: recipe.thresholds, ...gateKit, ...(run ? { run } : {}) })
    live({ stage: "render", project: candidate.project })
    const { file, plan } = await render(candidate.project, deliverable.id, signal)
    let attempt = { project: candidate.project, ops: candidate.ops, file, plan, checked: await check(file, plan, candidate.project) }
    live({ stage: "check", gates: attempt.checked.gates })
    // The repair ladder (QUALITY_GATES §4): code's fixes first, never a looser threshold, never a must-keep cut
    if (attempt.checked.blocking > 0 || attempt.checked.briefMisses > 0) {
      onStage("repair")
      const mustKeeps = (project) => planVerdict({ ...project, brief: { ...project.brief, targetDuration: undefined } }, index, recipe).briefMisses === 0
      const ladder = await repairLadder(attempt, { index, render: (project) => (live({ stage: "render", repair: true, project }), render(project, deliverable.id, signal)), check, keepsMustKeeps: mustKeeps, signal })
      attempt = ladder.best
      live({ stage: "repair", attempts: ladder.attempts, project: attempt.project })
      live({ stage: "check", gates: attempt.checked.gates })
      candidate.repairs = ladder.attempts
      candidate.person = ladder.person
    }
    // TP8: the Director watches what was rendered and fixes it, in the rounds the ladder left (EH-74)
    const left = watch ? roundsLeft(candidate.repairs) : 0
    if (left > 0) {
      onStage("watch")
      const watched = await watchAndFix(attempt, { index, view: watch.view, render: (project) => render(project, deliverable.id, signal), check, rounds: left, signal })
      attempt = watched.best
      live({ stage: "watch", rounds: watched.rounds, project: attempt.project })
      live({ stage: "check", gates: attempt.checked.gates })
      candidate.watched = { rounds: watched.rounds, left: watched.left, score: watched.best.report?.score ?? null }
    }
    Object.assign(candidate, { project: attempt.project, ops: attempt.ops, file: attempt.file, plan: attempt.plan, gates: attempt.checked })
    const checked = attempt.checked
    return { level: "F5", blocking: checked.blocking, briefMisses: checked.briefMisses, notes: checked.notes, quality: f0.quality, verdict: checked.verdict, failed: checked.gates?.filter((g) => g.status === "failed" && g.severity !== "note").map((g) => g.id) ?? [] }
  }

  const outcome = await search({
    start: { start: true, project },
    // Round 1: the recipe as planned. Later rounds: a tighter cut, then the original order
    // Another length or order can't fix what's wrong with how text is drawn: those rounds only cost time
    propose: async (best, round) => (round > 1 && (planner || (best.verdict.briefMisses === 0 && best.verdict.failed?.length && best.verdict.failed.every((id) => TEXT_GATES.has(id)))) ? [] : [await variantOf(round === 1 ? {} : round === 2 ? { tighter: 0.85 } : { noHook: true })]),
    evaluate,
    signal,
    rounds: 3,
    patience: 2,
    floor: 0,
    effort: brief.effort ?? "best",
  })
  const best = outcome.best.candidate
  return { best: best.start ? null : best, outcome, notes, calls, slots, head }
}

/**
 * The person's edits since the last make, replayed on a remade cut: each pointed at the clip
 * that replaced its own, applied if it still fits and listed if it doesn't, never forced.
 * @returns the candidate with those operations after its own, and `dropped`
 */
export function carryEdits(made, edits, { before, index }) {
  const worth = replayable(edits, before)
  if (!worth.length) return made
  const ids = remapIds(before, made.project, index)
  const { ops, dropped } = rebase(made.project, worth.map((op) => remapOp(op, ids)), index)
  const landed = ops.length ? apply(made.project, ops, { index, author: "agent" }) : null
  return { ...made, ops: [...made.ops, ...ops], project: landed?.applied ? landed.project : made.project, carried: landed?.applied ? ops : [], dropped }
}

/**
 * Lands the winner on HEAD. Unchanged HEAD: one entry. Changed: each operation is tried
 * on the new HEAD, and one that conflicts is dropped and listed, never forced.
 * @returns {{ ops: object[], dropped: { op: object, reason: string }[] }}
 */
export function rebase(current, ops, index) {
  const whole = apply(current, ops, { index, author: "agent" })
  if (whole.applied) return { ops, dropped: [] }
  const kept = []
  const dropped = []
  let project = current
  for (const op of ops) {
    const step = apply(project, [op], { index, author: "agent" })
    if (step.applied) {
      kept.push(op)
      project = step.project
    } else dropped.push({ op, reason: step.diagnostics[0].message })
  }
  return { ops: kept, dropped }
}

export const seconds = (flicks) => Math.round((flicks / FLICKS) * 10) / 10
