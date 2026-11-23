import { basename } from "node:path"

import { currentMilestone } from "./milestones.js"
import { MAX_ATTEMPTS, stepLabel } from "./verify.js"

// Harness 2.0 W18 (WD-23; Kriya-Tavi docs/kriya-harness/upgrade_2.0/HARNESS_UX.md):
// what the Run strip, the gate chips and Mission Control show, computed only
// from the loop's ledger (progress file, the live build record, the milestone
// ledger) and Kriya's /me figures. Never from model text (track-A rule 7).
// Pure, so the browser halves only draw what this returns.

/** The four right-column tracks and the existing tab kinds they are (the old ids stay valid). */
export const TRACKS = Object.freeze({ live: "kriya-preview", proof: "kriya-progress", changes: "kriya-changes", project: "kriya-overview" })
export const TRACK_ORDER = Object.freeze(["live", "proof", "changes", "project"])

/** A gate chip's five states (HARNESS_UX §3.2) and the word each shows; colour is never alone. */
export const CHIP_STATES = Object.freeze(["waiting", "running", "passed", "failed", "not-checked"])
const WORD = { waiting: "waiting", running: "checking", passed: "passed", failed: "failed", "not-checked": "not checked" }
const FROM_RUN = { pass: "passed", fail: "failed", not_checked: "not-checked", running: "running", waiting: "waiting" }

export const gateName = (id) => String(id ?? "").replace(/^G-/, "")
const oneLine = (text, limit) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, limit)

/**
 * One gate result as a chip. `pending`: the step is being built again, so a
 * recorded result is only waiting to be re-checked.
 * @param {{ id: string, status?: string, reason?: string, note?: string }} gate
 */
export function chipOf(gate, { pending = false } = {}) {
  const state = pending ? "waiting" : (FROM_RUN[gate?.status] ?? "waiting")
  const detail = state === "failed" || state === "not-checked" ? oneLine(gate.reason ?? gate.note, 80) : ""
  return { id: String(gate?.id ?? ""), state, text: `${gateName(gate?.id)} · ${WORD[state]}${detail ? `: ${detail}` : ""}` }
}

/** Micro-INR (an integer) as rupees and paise, for display only; no float crosses this line. */
export function formatInr(micro) {
  const paise = Math.round(Math.max(0, Math.trunc(Number(micro) || 0)) / 10_000)
  return `₹${Math.trunc(paise / 100)}.${String(paise % 100).padStart(2, "0")}`
}

/** "6m", "1h 04m", "42s": the strip's elapsed time. */
export function formatElapsed(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`
}

/**
 * The Run strip for one session, or `{ running: false }` when nothing is
 * being built (the strip is then 0 px).
 * @param {{ sessionId: string, progress: any, live?: any, ledger?: any, orchestra?: { head: string, worker: string }, names?: Record<string, string>, since?: number, spend?: { inr: string, estimated: boolean } | null, now?: number }} input
 */
export function stripState({ sessionId, progress, live, ledger, orchestra, names = {}, since, spend = null, now = Date.now() }) {
  const plan = progress?.plan
  if (!live || !plan?.steps?.[live.n - 1]) return { running: false }
  const label = stepLabel(plan, live.n)
  const runs = (progress.runs ?? []).filter((r) => r.step === label)
  const builders = (progress.builders ?? []).filter((b) => b.step === label && !b.polish)
  const tier = (t) => (typeof t === "string" && t ? { level: orchestra && t === orchestra.head ? "Head" : "Worker", model: oneLine(names[t], 80) || `Kriya ${t}` } : null)
  const m = currentMilestone(ledger)
  return {
    running: true,
    sessionId,
    milestone: ledger?.milestones?.length && m !== -1 ? { n: m + 1, of: ledger.milestones.length } : null,
    step: { n: live.n, of: plan.steps.length, title: oneLine(plan.steps[live.n - 1].title, 120) },
    attempt: { n: Math.min(runs.length + 1, MAX_ATTEMPTS), of: MAX_ATTEMPTS, ...(live.polish && { polish: true }) },
    tier: tier(live.tier),
    gates: (runs.at(-1)?.gates ?? []).map((g) => chipOf(g, { pending: true })),
    elapsedMs: Math.max(0, now - (since ?? live.startedAt)),
    spend,
    attempts: [
      ...runs.map((r, i) => ({
        n: i + 1,
        tier: tier(builders[i]?.tier)?.level ?? null,
        outcome: r.status === "pass" ? "passed" : (r.kind ?? (r.status === "blocked" ? "blocked" : "failed")),
        gates: (r.gates ?? []).map((g) => chipOf(g)),
        durationMs: (builders[i]?.ms ?? 0) + (r.durationMs ?? 0),
      })),
      { n: runs.length + 1, tier: tier(live.tier)?.level ?? null, outcome: "building", gates: [], durationMs: Math.max(0, now - live.startedAt) },
    ],
  }
}

/** Each plan step's chips: its last run's gates (Proof track). */
export const stepChips = (progress) =>
  (progress?.plan?.steps ?? []).map((_, i) => {
    const label = stepLabel(progress.plan, i + 1)
    return { n: i + 1, chips: ((progress.runs ?? []).findLast((r) => r.step === label)?.gates ?? []).map((g) => chipOf(g)) }
  })

/** The latest result of the page gates (G-UI, G-A11Y) the Live track draws over the frame. */
export function liveGates(progress) {
  const seen = new Map()
  for (const r of progress?.runs ?? []) for (const g of r.gates ?? []) if (g.id === "G-UI" || g.id === "G-A11Y") seen.set(g.id, chipOf(g))
  return [...seen.values()]
}

/**
 * Mission Control's rows: one per milestone ledger (a mission), with what it
 * waits for, decided by code from the ledger's statuses.
 * @param {Array<{ root: string, ledger: any, running?: boolean }>} entries
 */
export function missionRows(entries) {
  return entries
    .filter((e) => e.ledger?.milestones?.length)
    .map(({ root, ledger, running = false }) => {
      const list = ledger.milestones
      const i = currentMilestone(ledger)
      const done = list.filter((x) => x.status === "done").length
      const current = i === -1 ? null : list[i]
      const status = i === -1 ? "done" : current.status === "blocked" ? "blocked" : running ? "running" : current.status === "active" ? "active" : "todo"
      const waiting = {
        done: "Nothing: every milestone is done.",
        blocked: `You: milestone ${i + 1} is blocked; see its Proof track.`,
        running: "Nothing: a step is being built.",
        active: "You: ask the agent to go on with this milestone.",
        todo: "You: ask the agent to plan the next milestone.",
      }[status]
      return { project: basename(root), root, done, of: list.length, current: current ? { n: i + 1, title: oneLine(current.title, 120) } : null, status, waiting }
    })
}
