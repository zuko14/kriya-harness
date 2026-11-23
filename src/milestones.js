import { createHash } from "node:crypto"
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { planStatus } from "./loop.js"
import { projectRoot } from "./skill-switches.js"
import { progressFiles, readProgress, VerifyError } from "./verify.js"

// Harness 2.0 milestones (Kriya-Tavi docs/kriya-harness/upgrade_2.0/
// ORCHESTRA.md §4, WD-12): long work as a ledger of at most 12 milestones,
// each one bounded plan (MAX_STEPS and MAX_ATTEMPTS unchanged). The ledger
// lives in ~/.kriya/progress/<project>/milestones.json, outside the project,
// written only by this code: a milestone is done only when its plan's every
// step passed the person's check, never because the model says so. The head
// plans milestone i+1 only after milestone i is done; a blocked one stops the
// work for the person. Off unless kriya was started with --milestones.

export const MAX_MILESTONES = 12
export const LOCK_STALE_MS = 10_000
const LOCK_WAIT_MS = 2_000

/** The ledger's file: beside the project's progress records. */
export function milestonesFile(root) {
  return join(dirname(progressFiles(root, "ledger").json), "milestones.json")
}

/** The ledger, or undefined. */
export function readMilestones(root) {
  try {
    return JSON.parse(readFileSync(milestonesFile(root), "utf8"))
  } catch {
    return undefined
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Runs `change(ledger)` under the ledger's lock and writes its result
 * atomically (temp file + rename). Two sessions in one project may run at
 * once: a second writer waits briefly, then is told; a lock older than
 * LOCK_STALE_MS (a crashed session) is taken over.
 */
export async function updateMilestones(root, change, { now = Date.now, waitMs = LOCK_WAIT_MS } = {}) {
  const file = milestonesFile(root)
  const lock = `${file}.lock`
  mkdirSync(dirname(file), { recursive: true })
  const started = now()
  for (;;) {
    try {
      closeSync(openSync(lock, "wx", 0o600))
      break
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      let age = 0
      try {
        age = now() - statSync(lock).mtimeMs
      } catch {
        continue
      }
      if (age > LOCK_STALE_MS) {
        rmSync(lock, { force: true })
        continue
      }
      if (now() - started >= waitMs) throw new VerifyError("Another session is updating milestones; try again in a moment.")
      await sleep(50)
    }
  }
  try {
    const next = change(readMilestones(root))
    if (next !== undefined) {
      const temp = `${file}.${process.pid}.tmp`
      writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
      renameSync(temp, file)
    }
    return next
  } finally {
    rmSync(lock, { force: true })
  }
}

const text = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "")

/** 1 to 12 milestones, each a title and a done-when, roles checked against `roles` when given. */
export function validateMilestones(input, roles) {
  const list = Array.isArray(input) ? input : []
  if (!list.length) throw new VerifyError("Milestones need at least one milestone.")
  if (list.length > MAX_MILESTONES) throw new VerifyError(`At most ${MAX_MILESTONES} milestones; split the work differently.`)
  const out = list.map((m, i) => {
    const title = text(m?.title, 200)
    const doneWhen = text(m?.done_when ?? m?.doneWhen, 500)
    if (!title || !doneWhen) throw new VerifyError(`Milestone ${i + 1} needs a title and done_when.`)
    const asked = Array.isArray(m?.roles) ? [...new Set(m.roles.filter((r) => typeof r === "string"))] : []
    if (roles && asked.some((r) => !roles.includes(r))) throw new VerifyError(`Milestone ${i + 1} names a role Kriya doesn't have.`)
    return { title, doneWhen, roles: roles ? asked : [], status: "todo" }
  })
  if (new Set(out.map((m) => m.title.toLowerCase())).size !== out.length) throw new VerifyError("Two milestones have the same title.")
  return out
}

const open = (ledger) => ledger?.milestones?.some((m) => m.status !== "done")

/**
 * Records the milestones. While some are still open, a new list is refused
 * unless `replan` (the person chose to replace them, asked by the harness).
 */
export async function saveMilestones(root, input, { roles, replan = false, now = () => new Date().toISOString() } = {}) {
  const milestones = validateMilestones(input, roles)
  return updateMilestones(root, (ledger) => {
    if (open(ledger) && !replan) throw new VerifyError("This project already has milestones in progress. Work through them with kriya_plan, one milestone at a time; only the person can replace them.")
    return { version: 1, createdAt: now(), milestones, ...(ledger && { replaced: (ledger.replaced ?? 0) + 1 }) }
  })
}

const planHash = (plan) => createHash("sha256").update(JSON.stringify(plan)).digest("hex").slice(0, 16)

/** The first milestone not done: the only one a plan may be for. */
export const currentMilestone = (ledger) => ledger?.milestones?.findIndex((m) => m.status !== "done") ?? -1

/** Before a plan is recorded: refused when every milestone is done or the current one is blocked. */
export function checkPlanAllowed(root) {
  const ledger = readMilestones(root)
  if (!ledger) return
  const i = currentMilestone(ledger)
  if (i === -1) throw new VerifyError("Every milestone is done. Tell the person; they can set new milestones.")
  if (ledger.milestones[i].status === "blocked")
    throw new VerifyError(`Milestone ${i + 1} (${ledger.milestones[i].title}) is blocked. Stop and tell the person what failed.`)
}

/** After a plan is recorded: it belongs to the current milestone, which becomes active. */
export function bindPlan(root, sessionId, { now = () => new Date().toISOString() } = {}) {
  const plan = readProgress(root, sessionId).plan
  if (!plan) return Promise.resolve(undefined)
  return updateMilestones(root, (ledger) => {
    if (!ledger) return undefined
    const i = currentMilestone(ledger)
    if (i === -1) return undefined
    const m = ledger.milestones[i]
    ledger.milestones[i] = { ...m, status: "active", startedAt: m.startedAt ?? now(), plan: { sessionId, hash: planHash(plan) }, verdicts: [] }
    return ledger
  })
}

/**
 * After a step: the active milestone's status from its plan's records, by
 * code. Done only when every step passed; blocked when a step is blocked.
 */
export function syncMilestones(cwd, sessionId, { now = () => new Date().toISOString() } = {}) {
  const root = projectRoot(cwd)
  const ledger = readMilestones(root)
  const i = currentMilestone(ledger)
  if (i === -1 || ledger.milestones[i].plan?.sessionId !== sessionId) return Promise.resolve(ledger)
  const rows = planStatus(cwd, sessionId)
  if (!rows) return Promise.resolve(ledger)
  const hash = planHash(readProgress(root, sessionId).plan)
  return updateMilestones(root, (current) => {
    const m = current?.milestones?.[i]
    if (!m || m.plan?.sessionId !== sessionId || m.plan.hash !== hash) return undefined
    const verdicts = rows.map((r) => ({ n: r.n, title: r.title, status: r.status }))
    const status = rows.every((r) => r.status === "pass") ? "done" : rows.some((r) => r.status === "blocked") ? "blocked" : "active"
    current.milestones[i] = { ...m, status, verdicts, ...(status === "done" && { doneAt: now() }) }
    return current
  })
}

/** The late system-prompt section: where the long work stands, for a new or resumed session. Empty without milestones. */
export function milestonesText(root) {
  const ledger = readMilestones(root)
  if (!ledger?.milestones?.length) return ""
  const i = currentMilestone(ledger)
  const lines = ["# Milestones (from Kriya's ledger; only passing checks complete one)", ""]
  ledger.milestones.forEach((m, n) => lines.push(`${n + 1}. ${m.title}: ${m.status}`))
  lines.push("")
  if (i === -1) lines.push("Every milestone is done.")
  else {
    const m = ledger.milestones[i]
    lines.push(`Current: milestone ${i + 1}, ${m.title}. Done when: ${m.doneWhen}.${m.roles.length ? ` Roles: ${m.roles.join(", ")}.` : ""}`)
    if (m.verdicts?.length) lines.push(`Last verdicts: ${m.verdicts.map((v) => `${v.n}. ${v.title}: ${v.status}`).join("; ")}.`)
    lines.push(
      m.status === "blocked"
        ? "It is blocked: stop and tell the person what failed."
        : m.plan
          ? "Run its plan's remaining steps with kriya_step; the next milestone is planned only after this one is done."
          : "Plan it with kriya_plan (one plan for this milestone only)."
    )
  }
  return lines.join("\n")
}
