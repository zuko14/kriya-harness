// S-3 (Kriya-Tavi docs/kriya-harness/TASK_PROOF.md; owner decisions 2026-11-24):
// what a task started from Kriya reports back, computed by code on this
// computer. The verdict, each step's attempts, who built each attempt and the
// gates come from the loop's own ledger (verify.js verdict), never from model
// text. Changes are file names with line counts: no code leaves the computer.

import { snapshot, trackedRoot, treeChanges } from "./checkpoints.js"
import { stepLabel, verdict } from "./verify.js"

const GATE = /^G-[A-Z0-9-]{2,20}$/
export const MAX_FILES = 200

const modelNames = (env) => {
  try {
    return JSON.parse(env.KRIYA_MODEL_NAMES || "{}")
  } catch {
    return {}
  }
}

/** The steps' proof from a progress ledger, or undefined without a plan */
export function stepsProof(progress, env = process.env) {
  const plan = progress?.plan
  if (!plan?.steps?.length) return undefined
  const ledger = { ...progress, runs: progress.runs ?? [] }
  const v = verdict(ledger)
  const named = modelNames(env)
  const head = env.KRIYA_ORCHESTRA_HEAD
  const who = (tier) => ({
    level: head && env.KRIYA_ORCHESTRA === "on" ? (tier === head ? "head" : "worker") : "single",
    name: String(named[tier] ?? `Kriya ${tier}`).slice(0, 80),
    ...(tier === "local" && { local: true }),
  })
  const steps = plan.steps.map((step, i) => {
    const label = stepLabel(plan, i + 1)
    const found = v.steps.find((s) => s.step === label)
    const last = ledger.runs.findLast((r) => r.step === label)
    return {
      n: i + 1,
      title: String(step.title ?? "").slice(0, 120),
      verdict: found?.status ?? "not run",
      attempts: found?.attempts ?? 0,
      builtBy: (progress.builders ?? []).filter((b) => b.step === label && !b.polish && typeof b.tier === "string" && b.tier).slice(0, 8).map((b) => who(b.tier)),
      gates: (last?.gates ?? []).filter((g) => GATE.test(g?.id ?? "")).slice(0, 20).map((g) => ({ id: g.id, status: String(g.status).slice(0, 20) })),
    }
  })
  return { verdict: v.status, steps: steps.slice(0, 12), ...(v.touched?.length && { touchedChecks: v.touched.slice(0, 20).map((p) => String(p).slice(0, 300)) }) }
}

/** The folder's working tree before a task, or null where it can't be read */
export async function baseline(folder) {
  try {
    const tracked = await trackedRoot(folder)
    return tracked ? { root: tracked.root, tree: await snapshot(tracked.root) } : null
  } catch {
    return null
  }
}

/** Files changed since `base`: names, status and line counts only */
export async function changesSince(base) {
  if (!base) return null
  try {
    const files = await treeChanges(base.root, base.tree, await snapshot(base.root))
    const total = files.reduce((t, f) => ({ added: t.added + (f.added ?? 0), deleted: t.deleted + (f.deleted ?? 0) }), { added: 0, deleted: 0 })
    return {
      files: files.slice(0, MAX_FILES).map((f) => ({
        path: String(f.path).slice(0, 300),
        status: f.status,
        ...(f.binary ? { binary: true } : { added: f.added ?? 0, deleted: f.deleted ?? 0 }),
      })),
      count: files.length,
      ...total,
    }
  } catch {
    return null
  }
}
