// A "make" job (DIRECTOR_AND_AGENT §3): brief → recipe → story → assemble → dress →
// check, through the Edit Loop. Candidates climb the fidelity ladder (EDIT_LOOP §5):
// each is judged at F0 on its plan, and only a sound plan is rendered as a master
// and gated (F5). The person's HEAD is the starting best, so stopping at any point
// leaves a playable project; the winner lands as one entry, rebased if the person
// edited meanwhile, and their edit never moves (§9).

import { apply } from "../core/ops.js"
import { compile } from "../core/plan.js"
import { runGates } from "../gates/index.js"
import { planReel, recipeFor } from "../recipes/reel.js"
import { search } from "./loop.js"
import { repairLadder } from "./repair.js"

const FLICKS = 705_600_000

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
 * }} input
 */
export async function makeReel({ project, head, index, asset, brief = {}, ask, render, sourcePath, signal, onStage = () => {}, run, gateKit = {} }) {
  const recipe = recipeFor(brief)
  let calls = 0
  const notes = []
  const slots = {}

  const variantOf = async (variant) => {
    onStage("story")
    const made = await planReel({ project, index, asset, ask, brief, variant, signal })
    calls += made.calls
    Object.assign(slots, made.slots)
    for (const note of made.notes) if (!notes.includes(note)) notes.push(note)
    return { ...made, variant }
  }

  const evaluate = async (candidate) => {
    if (candidate.start) return { blocking: Infinity, briefMisses: Infinity, notes: 0, quality: 0, level: "start" }
    const f0 = planVerdict(candidate.project, index, recipe)
    if (f0.blocking || f0.briefMisses) return { ...f0, plan: undefined }
    onStage("check")
    const deliverable = candidate.project.deliverables.find((d) => d.preset === recipe.deliverable.preset)
    const check = (file, plan, project) => runGates({ file, plan, project, index, sourcePath, thresholds: recipe.thresholds, ...gateKit, ...(run ? { run } : {}) })
    const { file, plan } = await render(candidate.project, deliverable.id, signal)
    let attempt = { project: candidate.project, ops: candidate.ops, file, plan, checked: await check(file, plan, candidate.project) }
    // The repair ladder (QUALITY_GATES §4): code's fixes first, never a looser threshold, never a must-keep cut
    if (attempt.checked.blocking > 0 || attempt.checked.briefMisses > 0) {
      onStage("repair")
      const mustKeeps = (project) => planVerdict({ ...project, brief: { ...project.brief, targetDuration: undefined } }, index, recipe).briefMisses === 0
      const ladder = await repairLadder(attempt, { index, render: (project) => render(project, deliverable.id, signal), check, keepsMustKeeps: mustKeeps, signal })
      attempt = ladder.best
      candidate.repairs = ladder.attempts
      candidate.person = ladder.person
    }
    Object.assign(candidate, { project: attempt.project, ops: attempt.ops, file: attempt.file, plan: attempt.plan, gates: attempt.checked })
    const checked = attempt.checked
    return { level: "F5", blocking: checked.blocking, briefMisses: checked.briefMisses, notes: checked.notes, quality: f0.quality, verdict: checked.verdict }
  }

  const outcome = await search({
    start: { start: true, project },
    // Round 1: the recipe as planned. Later rounds: a tighter cut, then the original order
    propose: async (best, round) => [await variantOf(round === 1 ? {} : round === 2 ? { tighter: 0.85 } : { noHook: true })],
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
