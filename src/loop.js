import { readFileSync, writeFileSync } from "node:fs"

import { RANK } from "./failure.js"
import { checkPremortem } from "./sentinel.js"
import { PLAN_LIMITS, taskKind, TASK_KINDS } from "./strict.js"
import { confirmCheck, markStalled, MAX_ATTEMPTS, readProgress, stepLabel, trimOutput, verdict, VerifyError, writeProgress } from "./verify.js"
import { projectRoot } from "./skill-switches.js"
import { stepsProof } from "./proof.js"
import { cartridgeSection } from "./cartridges.js"
import { polishSection } from "./critic.js"
import { directionHints, EXPLORE_ROLES, MAX_TAKES, MIN_TAKES, takeSection } from "./explore.js"

// The Kriya loop's plan and steps (H14c; KRIYA_LOOP.md in the Kriya
// repository). The task is split into at most MAX_STEPS ordered steps
// (kriya_plan); each step is built by a fresh agent that sees only the
// goal, the plan and its own step (kriya_step), then checked by the
// harness itself with the project's confirmed check. A failure goes back
// to a new builder with its output, up to MAX_ATTEMPTS runs; then the step
// is blocked. Code decides pass, retry and blocked; the model only builds.

export const MAX_STEPS = 7
// A session may re-plan twice: a new plan starts its steps over, so an
// unlimited re-plan would undo "blocked" and the spend bound with it
export const MAX_PLANS = 3
const TITLE = 120
const DONE_WHEN = 300
const GOAL = 600
const FILES = 12
const MAX_ACCEPTANCE = 3

// A step's builder is bounded by code, apart from the turn budget (which
// gives every agent 150 steps and 60 minutes, so 4 runs of one step could
// take 4 hours with nothing to show). Found on a real long task: a step-1
// builder with no confirmed check spent 100 steps and 17 minutes on
// screenshots and contrast audits while the parent showed one pending call.
// Near the limit the builder is told once to wrap up; at the limit its next
// step is refused and the harness's check runs on what it left.
const whole = (value, fallback) => {
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : fallback
}
/** One builder's limits, from the launch environment; defaults when unset or unusable. */
export function builderLimits(env = process.env) {
  return { maxSteps: whole(env.KRIYA_BUILDER_STEPS, 40), maxMinutes: whole(env.KRIYA_BUILDER_MINUTES, 15) }
}

// Builds in progress, for the Progress tab: session id → the live record
// runStep hands to spawn ({ n, attempt, startedAt, steps, last, stopped }).
// In memory only: a build lives exactly as long as its kriya_step call.
const building = new Map()
/** The step being built in a session right now, if any */
export const liveBuild = (sessionId) => building.get(sessionId)

const clean = (value, limit) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "")

/**
 * Loop v2: the steps a step needs first, as step numbers. Each must be an
 * earlier step, so every plan is a DAG listed in a topological order (no
 * cycle can be written down). Absent: the step before it, as in v1.
 */
function dependencies(value, n) {
  if (value === undefined) return n > 1 ? [n - 1] : []
  if (!Array.isArray(value)) throw new VerifyError(`Step ${n}: after is a list of earlier step numbers.`)
  const deps = [...new Set(value.map(Number))]
  for (const d of deps) if (!Number.isInteger(d) || d < 1 || d >= n) throw new VerifyError(`Step ${n} can only come after earlier steps (1 to ${n - 1}); list the steps in an order where each needs only steps above it.`)
  return deps.sort((a, b) => a - b)
}

/**
 * A plan as the agent proposed it, checked: a goal and 1..MAX_STEPS steps,
 * each with a title, a done-when sentence and the files it expects to touch;
 * with v2, also the earlier steps each one needs (`after`).
 * With strict, the task contract too: its kind (which bounds the plan), the
 * paths that must not change and commands that must also exit 0. A contract
 * can only add to what must hold; it can't replace the person's check.
 * @returns {{ goal: string, steps: Array<{ title: string, doneWhen: string, files: string[], after?: number[] }>, kind?: string, invariants?: string[], acceptance?: string[] }}
 */
export function validatePlan(input, { v2 = false, strict = false, defensive = false, roles, contracts: contractNames, specTests = false, explore = false } = {}) {
  const goal = clean(input?.goal, GOAL)
  if (!goal) throw new VerifyError("A plan needs a goal: one sentence on what the task is for.")
  const steps = Array.isArray(input?.steps) ? input.steps : []
  if (!steps.length) throw new VerifyError("A plan needs at least one step.")
  if (steps.length > MAX_STEPS) throw new VerifyError(`A plan has at most ${MAX_STEPS} steps; merge some, or split the task into separate jobs.`)
  const out = steps.map((step, i) => {
    const title = clean(step?.title, TITLE)
    const doneWhen = clean(step?.done_when ?? step?.doneWhen, DONE_WHEN)
    if (!title) throw new VerifyError(`Step ${i + 1} needs a title.`)
    if (!doneWhen) throw new VerifyError(`Step ${i + 1} needs done_when: what is true when it's finished.`)
    const files = (Array.isArray(step?.files) ? step.files : []).map((f) => clean(f, 300)).filter(Boolean).slice(0, FILES)
    // Harness 2.0 cartridges: an optional role from Kriya's list; without `roles`, never read
    const role = roles && step?.role !== undefined && step?.role !== null && step?.role !== "" ? String(step.role) : undefined
    if (role && !roles.includes(role)) throw new VerifyError(`Step ${i + 1}'s role is one of: ${roles.join(", ")}; or leave it out.`)
    // Harness 2.0 gates: the contract slices this step builds to ("api#/paths/~1orders"); without the option, never read
    let contracts
    if (contractNames && Array.isArray(step?.contracts) && step.contracts.length) {
      contracts = step.contracts.map((c) => String(c).trim()).filter(Boolean).slice(0, 8)
      const bad = contracts.find((c) => !contractNames.includes(c.split("#")[0]) || (c.includes("#") && !/^[a-z_]+#\/\S*$/.test(c)))
      if (bad) throw new VerifyError(`Step ${i + 1}'s contract "${bad}" isn't one of ${contractNames.join(", ")}, optionally with #/a/json/pointer.`)
    }
    // Harness 2.0 W5: a spec-test step (judged red, ORCHESTRA §7); without the option, never read
    const spec = specTests && step?.spec_tests === true
    // Harness 2.0 W14 (WD-18): 2 or 3 takes of a creative step; without the option, never read
    let takes
    if (explore && step?.explore !== undefined && step?.explore !== null && step?.explore !== 0) {
      takes = Number(step.explore)
      if (!Number.isInteger(takes) || takes < MIN_TAKES || takes > MAX_TAKES) throw new VerifyError(`Step ${i + 1}'s explore is ${MIN_TAKES} or ${MAX_TAKES} takes; or leave it out.`)
      if (!EXPLORE_ROLES.includes(role)) throw new VerifyError(`Step ${i + 1} explores only with role ${EXPLORE_ROLES.join(", ")}: takes are for creative work.`)
    }
    return { title, doneWhen, files, ...(v2 && { after: dependencies(step?.after, i + 1) }), ...(role && { role }), ...(contracts?.length && { contracts }), ...(spec && { specTests: true }), ...(takes && { explore: takes }) }
  })
  // A spec step writes tests from the contracts and criteria before the code exists: nothing that
  // builds the code may come before it
  const first = out.findIndex((s) => s.specTests)
  if (first !== -1) {
    const early = out.slice(0, first).find((s) => s.role && IMPLEMENTING.has(s.role))
    if (early) throw new VerifyError(`Step ${first + 1} writes spec tests, so it comes before the code they test; "${early.title}" (${early.role}) builds code and is listed first. Put the spec step right after the contracts.`)
  }
  const titles = new Set(out.map((s) => s.title.toLowerCase()))
  if (titles.size !== out.length) throw new VerifyError("Two steps have the same title; each step is one distinct piece of work.")
  const { premortem, problem } = defensive ? checkPremortem(input?.premortem, out.length) : {}
  if (problem) throw new VerifyError(problem)
  return { goal, steps: out, ...(strict && contract(input, goal, out.length)), ...(premortem && { premortem }) }
}

function contract(input, goal, steps) {
  const kind = input?.kind ?? taskKind(goal)
  if (!TASK_KINDS.includes(kind)) throw new VerifyError(`kind is one of: ${TASK_KINDS.join(", ")}.`)
  if (steps > PLAN_LIMITS[kind]) throw new VerifyError(`A ${kind} plan has at most ${PLAN_LIMITS[kind]} steps; do it directly, or name the kind that fits.`)
  const list = (value, limit, size) => (Array.isArray(value) ? value : []).map((v) => clean(v, size)).filter(Boolean).slice(0, limit)
  const acceptance = list(input?.acceptance, MAX_ACCEPTANCE, 300)
  return { kind, invariants: list(input?.invariants, FILES, 300), acceptance }
}

export { stepLabel }

/** Roles whose steps build the code a spec step's tests are about (Harness 2.0) */
export const IMPLEMENTING = new Set(["frontend", "backend", "fullstack", "mobile", "game", "devops", "cloud", "systems", "data", "ml"])

/**
 * Saves the session's plan beside its runs. A new plan starts its steps
 * over; the earlier plans and runs are kept, and at most MAX_PLANS are made.
 */
export function savePlan(cwd, sessionId, input, now = () => new Date(), options = {}) {
  const plan = validatePlan(input, options)
  const root = projectRoot(cwd)
  const progress = readProgress(root, sessionId)
  const earlier = [...(progress.earlier ?? []), ...(progress.plan ? [{ plan: progress.plan, runs: progress.runs }] : [])]
  if (earlier.length >= MAX_PLANS) throw new VerifyError(`This session already made ${MAX_PLANS} plans; stop and tell the person where it stands.`)
  writeProgress(root, sessionId, { ...progress, earlier, plan: { ...plan, at: now().toISOString() }, runs: progress.plan ? [] : progress.runs })
  return plan
}

/**
 * A flow from Kriya (SD-14 in the Kriya repository): the person's own plan,
 * which the daemon hands over in a file. While one is set it is the session's
 * plan as written, so the model can't rewrite it.
 */
export function seededPlan(env = process.env) {
  if (!env.KRIYA_SEED_PLAN) return undefined
  try {
    return JSON.parse(readFileSync(env.KRIYA_SEED_PLAN, "utf8"))
  } catch {
    return undefined
  }
}

/** Where a seeded plan stands, for the daemon to report; a safety net, never a gate */
export function writeSnapshot(cwd, sessionId, { current, env = process.env } = {}) {
  if (!env.KRIYA_PROGRESS_FILE) return
  try {
    const plan = planStatus(cwd, sessionId)?.map((s) => ({ ...s, ...(s.n === current && !s.building && { building: { attempt: s.attempts + 1 } }) }))
    // S-3: with Kriya's proof asked for, the code-computed verdict too (src/proof.js)
    const proof = env.KRIYA_TASK_PROOF === "on" ? stepsProof(readProgress(projectRoot(cwd), sessionId), env) : undefined
    writeFileSync(env.KRIYA_PROGRESS_FILE, JSON.stringify({ plan, ...(proof && { proof }) }))
  } catch {
    // The run doesn't depend on being reported
  }
}

export function readPlan(cwd, sessionId) {
  return readProgress(projectRoot(cwd), sessionId).plan
}

/** Where each step stands, from the recorded runs */
export function planStatus(cwd, sessionId) {
  const progress = readProgress(projectRoot(cwd), sessionId)
  if (!progress.plan) return undefined
  const { steps } = verdict(progress)
  const live = building.get(sessionId)
  const rows = []
  progress.plan.steps.forEach((step, i) => {
    const label = stepLabel(progress.plan, i + 1)
    const found = steps.find((s) => s.step === label)
    // Built by kriya_step with no check confirmed: done for ordering, never a pass
    const built = !found && progress.built?.some((b) => b.step === label)
    // v2: a step that needs a blocked or skipped step is skipped; one pass in plan order suffices, since deps point back
    const stuck = !found && step.after?.some((d) => ["blocked", "skipped"].includes(rows[d - 1].status))
    rows.push({
      n: i + 1,
      title: step.title,
      status: stuck ? "skipped" : (found?.status ?? (built ? "built" : "not started")),
      attempts: found?.attempts ?? 0,
      ...(step.after && { after: step.after }),
      ...(live?.n === i + 1 && { building: { attempt: live.attempt, steps: live.steps, startedAt: live.startedAt, ...(live.last && { last: live.last }) } }),
    })
  })
  return rows
}

/**
 * The step a stopping agent should have gone on to, if any (loop guard). A
 * blocked step ends a v1 plan, as the guidance says; in v2 only the steps
 * that need it. Nothing while a step is being built.
 */
export function nextStep(rows) {
  if (!rows || rows.some((r) => r.building)) return undefined
  const ready = (r) => (r.after ? r.after.every((d) => ["pass", "built"].includes(rows[d - 1].status)) : !rows.some((o) => o.n < r.n && o.status === "blocked"))
  return rows.find((r) => ["not started", "fail"].includes(r.status) && ready(r))
}

/**
 * Loop v2, long tasks: where the work stands, from the loop's own records,
 * for a late system-prompt section that compaction never condenses. A small
 * context window loses older turns to summaries; this keeps the goal, every
 * step's status and the next step in front of the agent. Empty without a plan.
 */
export function loopStateText(cwd, sessionId) {
  const progress = readProgress(projectRoot(cwd), sessionId)
  if (!progress.plan) return ""
  const rows = planStatus(cwd, sessionId)
  const STATE = { pass: "passed", fail: "failing", blocked: "blocked", skipped: "skipped", built: "built, not checked (no check confirmed)", "not started": "not started" }
  const next = rows.find((r) => r.status === "not started" || r.status === "fail")
  const last = progress.runs.at(-1)
  const lines = [
    "Where this task stands, kept by Kriya Harness from its own check runs (it outranks any summary of the conversation):",
    `Goal: ${progress.plan.goal}`,
    ...rows.map((r) => `${r.n}. ${r.title}: ${STATE[r.status] ?? r.status}${r.attempts ? ` (${r.attempts} run${r.attempts === 1 ? "" : "s"})` : ""}`),
    next ? `Next: kriya_step with step ${next.n}.` : "Every step has passed, been blocked or been skipped: report each step's result.",
  ]
  if (last) lines.push(`Last check: ${last.step}, ${last.status === "pass" ? "passed" : `failed (exit ${last.exitCode ?? "none"}${last.kind ? `, ${last.kind}` : ""})`}.`)
  return lines.join("\n")
}

/** What a fresh builder is told: the goal, the plan, its one step and, on a retry, what failed; with v2, the person's confirmed rules */
export function builderPrompt(plan, n, previous, rules = [], { limits = builderLimits(), checked = true, briefing = [], cartridge, slices, polish } = {}) {
  const step = plan.steps[n - 1]
  const lines = [
    // Harness 2.0: the role's cartridge first and byte-stable, so a cached prefix holds across builders
    ...(cartridge ? cartridgeSection(cartridge.name, cartridge.body) : []),
    // Harness 2.0 contract bus: this step's slices, stable for all its attempts
    ...(slices ? ["Contracts for this step. Build to them as written; only the role that owns a contract changes it, and the harness fails a step that changes one it doesn't own.", "", slices, "", "---", ""] : []),
    `You are building one step of a larger task. Do only this step, then stop.`,
    "",
    `Goal of the task: ${plan.goal}`,
    "",
    "The plan (for context; other steps are done by others):",
    ...plan.steps.map((s, i) => `${i + 1}. ${s.title}${i + 1 === n ? "   <- your step" : ""}`),
    "",
    `Your step: ${n}. ${step.title}`,
    `It is done when: ${step.doneWhen}`,
  ]
  if (step.files.length) lines.push(`Files it is expected to touch: ${step.files.join(", ")}`)
  if (plan.invariants?.length) lines.push(`These must not change: ${plan.invariants.join(", ")}`)
  if (plan.acceptance?.length) lines.push(`These commands must also exit 0: ${plan.acceptance.join("; ")}`)
  if (plan.premortem) {
    lines.push("", "The plan's pre-mortem, which this work must defend against:")
    for (const f of plan.premortem.failures) lines.push(`- Could fail: ${f.what} (proved by ${f.coveredBy})`)
    lines.push(`- Shares this surface: ${plan.premortem.blastRadius.join("; ")}`, `- Bad inputs to handle: ${plan.premortem.negatives.join("; ")}`)
  }
  if (briefing.length) lines.push("", ...briefing)
  if (rules.length) lines.push("", "Rules for this project, confirmed by the person:", ...rules)
  lines.push(
    "",
    "Read the code you need, make the change, and keep it small. Don't change other steps' work unless your step needs it.",
    "Don't call kriya_plan or kriya_step: you are the step. You may call kriya_verify to test your change before you finish.",
    "When you finish, the harness runs the project's check; that result, not your summary, decides whether the step passes. End with two or three sentences on what you changed.",
    `You have at most ${limits.maxSteps} steps and ${limits.maxMinutes} minutes. At the limit you are stopped and the check runs on what you left, so make the step's core change first and polish after.`,
    "Don't leave servers or browsers running: start one only with run_in_background, and stop it before you finish."
  )
  if (!checked)
    lines.push(
      "No check is confirmed for this project, so nothing judges this step after you. Don't spend steps on open-ended manual QA (screenshots, pixel or contrast audits, repeated browser runs): " +
        "stop once the step's files are written and they build or load without errors. If the project has no build or test script yet, add a real one (e.g. in package.json): Kriya offers it to the person as the project's check."
    )
  if (previous)
    lines.push(
      "",
      `This is attempt ${previous.attempt + 1} of ${MAX_ATTEMPTS}. The previous attempt failed the project's check (\`${previous.command}\`, ${previous.timedOut ? "timed out" : `exit ${previous.exitCode}`}${previous.kind ? `; failure class: ${previous.kind}` : ""}). ${previous.kind ? "The lines that name the failure" : "Its output"}:`,
      "```",
      trimOutput(previous.output, 3000),
      "```",
      "Find the cause in the code and fix it; the files may already contain the previous attempt's changes."
    )
  if (previous?.kind === "tests changed")
    lines.push("The check passed only with changed tests or check files; on the originals it fails (above). Fix the code so the original tests pass; don't change existing tests.")
  if (previous?.note) lines.push(previous.note)
  // Harness 2.0 W6: one polish attempt after a pass, with the critic's major defects
  if (polish?.length) lines.push(...polishSection(polish))
  return lines.join("\n")
}

// Attempts in a row that don't parse or type-check before a step's files go back
export const BROKEN_ATTEMPTS = 2

// How often one step may come back "interrupted" before its builders count as attempts again
export const MAX_INTERRUPTIONS = 2

/** One builder's record beside the runs: what the bench and KRHE count; never shown to a model */
function noteBuilder(root, sessionId, builder) {
  const progress = readProgress(root, sessionId)
  writeProgress(root, sessionId, { ...progress, builders: [...(progress.builders ?? []), builder] })
}

/** Counts one interruption of a step; false once the step has had MAX_INTERRUPTIONS */
function noteInterruption(root, sessionId, label) {
  const progress = readProgress(root, sessionId)
  const count = progress.interrupted?.[label] ?? 0
  if (count >= MAX_INTERRUPTIONS) return false
  writeProgress(root, sessionId, { ...progress, interrupted: { ...progress.interrupted, [label]: count + 1 } })
  return true
}

const textOf = (blocks) =>
  (Array.isArray(blocks) ? blocks : [])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim()

/**
 * Runs one plan step to pass or blocked: a fresh builder, the harness's
 * check, and a new builder with the failure until MAX_ATTEMPTS runs.
 * With v2: only the step's own dependencies must have passed (one that is
 * blocked or skipped skips it, building nothing); each attempt's files are
 * saved, and an attempt that fails further from passing than the best one
 * so far (RANK: syntax < type < assertion) is set aside, the files going
 * back to the best attempt's before the next builder. Same attempt bound.
 * Each builder gets a live record (spawn's third argument; the Progress tab
 * reads it) and is bounded by `limits`; one stopped at its limit is still
 * checked, and the result says so. `hasCheck`: whether a check is confirmed.
 * With the guard (KRIYA_LOOP_GUARD=on): a step resumed after an interruption
 * starts from its last recorded failure; a builder that died on an error
 * before changing a file isn't an attempt (the step comes back "interrupted",
 * at most MAX_INTERRUPTIONS times); and more builders stop being spent when
 * they can't help: the same failure twice with no file changed, or a check
 * that can't run. Same attempt bound; only ever fewer builders.
 * With guard.restore (strict): a step is one transaction. Two attempts in a
 * row that break the build go back to the files the step began with, and a
 * blocked step leaves them that way; every replaced state stays in `kriya
 * undo --list`. Nothing but Kriya's own restore touches the person's git.
 * @param {{ cwd: string, sessionId: string, n: number, spawn: (prompt: string, label: string, live: { n: number, attempt: number, startedAt: number, steps: number, last?: string, stopped?: string }) => Promise<{ output: any[], stopReason?: string }>, verify: (label: string) => Promise<any>, v2?: { snapshot?: (label: string) => Promise<string | undefined>, restore?: (tree: string, label: string) => Promise<unknown>, rules?: string[] }, guard?: { snapshot?: (label: string) => Promise<string | undefined>, restore?: (tree: string, label: string) => Promise<unknown>, briefing?: (step: any) => Promise<string[]> }, hasCheck?: boolean, limits?: { maxSteps: number, maxMinutes: number }, now?: () => number }} input
 */
export async function runStep({ cwd, sessionId, n, spawn, verify, v2, guard, hasCheck = true, limits = builderLimits(), now = Date.now, pickCheck, cartridge: cartridgeFor, orchestra, slices: slicesFor, polish, explore }) {
  const plan = readPlan(cwd, sessionId)
  if (!plan) throw new VerifyError("There's no plan yet: call kriya_plan first.")
  if (!Number.isInteger(n) || n < 1 || n > plan.steps.length) throw new VerifyError(`The plan has steps 1 to ${plan.steps.length}.`)
  const status = planStatus(cwd, sessionId)
  const deps = plan.steps[n - 1].after
  if (deps) {
    const stuck = deps.map((d) => status[d - 1]).find((s) => s.status === "blocked" || s.status === "skipped")
    if (stuck) return { status: "skipped", step: n, title: plan.steps[n - 1].title, builders: [], note: `It needs step ${stuck.n} (${stuck.title}), which is ${stuck.status}, so nothing was built.` }
    const open = deps.map((d) => status[d - 1]).find((s) => s.status !== "pass" && s.status !== "built")
    if (open) throw new VerifyError(`Step ${n} needs step ${open.n} (${open.title}) first, and it hasn't passed yet.`)
  } else {
    const open = status.find((s) => s.n < n && !["pass", "blocked", "built"].includes(s.status))
    if (open) throw new VerifyError(`Steps run in order: step ${open.n} (${open.title}) isn't finished yet.`)
  }
  const label = stepLabel(plan, n)
  const builders = []
  const root = projectRoot(cwd)
  const save = v2?.snapshot ?? guard?.snapshot
  const lastRun = guard && status[n - 1].status === "fail" ? readProgress(root, sessionId).runs.findLast((r) => r.step === label) : undefined
  let previous = lastRun?.excerpt
    ? { attempt: status[n - 1].attempts, command: lastRun.command, exitCode: lastRun.exitCode, timedOut: lastRun.timedOut, output: lastRun.excerpt, kind: lastRun.kind, sig: lastRun.sig }
    : undefined
  let best
  // The files the next builder starts from
  let start = guard ? await save?.(`before step ${n}`) : undefined
  const base = start
  const briefing = (await guard?.briefing?.(plan.steps[n - 1])) ?? []
  // Harness 2.0: one cartridge for every attempt of this step (undefined: the prompt as before)
  const cartridge = cartridgeFor ? await cartridgeFor(plan.steps[n - 1]).catch(() => undefined) : undefined
  const slices = slicesFor && plan.steps[n - 1].contracts?.length ? slicesFor(plan.steps[n - 1]) : ""
  let broken = 0
  // Harness 2.0 orchestra: the failure before `previous`, whether a head-level builder already
  // ran on this step, and a one-time "use the head" instead of a stall (ARCHITECTURE §5)
  let earlierRun
  let headTried = false
  let forceHead = false
  const rollBack = async (why) => {
    if (!guard?.restore || !base) return false
    await guard.restore(base, why)
    const progress = readProgress(root, sessionId)
    writeProgress(root, sessionId, { ...progress, rollbacks: (progress.rollbacks ?? 0) + 1 })
    return true
  }
  // Harness 2.0 W14 (WD-18): a step marked explore builds its takes first (only with explore given)
  const takes = explore && status[n - 1].status !== "pass" && status[n - 1].attempts === 0 ? plan.steps[n - 1].explore : undefined
  if (takes) {
    if (explore.readOnly) throw new VerifyError("Read only mode can't explore: each take changes files.")
    const done = await exploreTakes({ plan, n, label, takes, root, cwd, sessionId, spawn, verify, explore, cartridge, slices, briefing, limits, hasCheck, v2, orchestra, builders, now })
    if (done.result) return done.result
    // No take passed: the normal retry rules go on from the best-ranked failure
    previous = done.previous
    start = done.tree
    status[n - 1] = { ...status[n - 1], status: "fail", attempts: done.attempts }
  }
  for (;;) {
    const before = status[n - 1]
    if (before.status === "pass") return { status: "pass", step: n, title: plan.steps[n - 1].title, attempts: before.attempts, builders, note: "This step already passed." }
    const live = { n, attempt: builders.length + 1, startedAt: now(), steps: 0 }
    const tier = orchestra?.tier({ attempt: (before.attempts ?? 0) + 1, previous, earlier: earlierRun, force: forceHead, step: plan.steps[n - 1] })
    if (tier) {
      live.tier = tier
      if (tier === orchestra.head) headTried = true
    }
    forceHead = false
    building.set(sessionId, live)
    let built
    try {
      built = await spawn(builderPrompt(plan, n, previous, v2?.rules, { limits, checked: hasCheck, briefing, ...(cartridge && { cartridge }), ...(slices && { slices }) }), `Step ${n}: ${plan.steps[n - 1].title}`, live)
    } finally {
      if (building.get(sessionId) === live) building.delete(sessionId)
    }
    builders.push({ stopReason: built.stopReason ?? "completed", summary: textOf(built.output).slice(-600), steps: live.steps, ...(live.stopped && { limit: live.stopped }) })
    noteBuilder(root, sessionId, { step: label, stopReason: builders.at(-1).stopReason, steps: live.steps, ms: now() - live.startedAt, ...(live.tokens && { tokens: live.tokens }), ...(live.stopped && { limit: live.stopped }), ...(cartridge && { cartridge: `${cartridge.id}@${cartridge.version}` }), ...(live.tier && { tier: live.tier }), ...(live.advice && { advice: live.advice }) })
    const tree = await save?.(`attempt ${builders.length} of step ${n}`)
    const untouched = tree !== undefined && tree === start
    if (guard && built.stopReason === "error" && untouched && noteInterruption(root, sessionId, label))
      return { status: "interrupted", step: n, title: plan.steps[n - 1].title, builders, note: "The builder stopped on an error before changing any file, so this wasn't an attempt and nothing was checked." }
    let checked = await verify(label)
    // A project built from nothing has no check until a step writes one: the person picks it now, so this step
    // is judged. Asked once a session; the answer comes from the person's UI, never from the model
    if (checked.status === "not configured" && pickCheck && checked.suggestions?.length && !readProgress(root, sessionId).checkAsked) {
      const command = await pickCheck(checked.suggestions)
      if (command) {
        confirmCheck(cwd, command)
        hasCheck = true
        checked = await verify(label)
      } else writeProgress(root, sessionId, { ...readProgress(root, sessionId), checkAsked: true })
    }
    if (checked.status === "not configured") {
      // Recorded apart from check runs, so the plan moves on and the verdict stays "not checked"
      const progress = readProgress(root, sessionId)
      progress.built = [...(progress.built ?? []).filter((b) => b.step !== label), { step: label, at: new Date(now()).toISOString() }]
      writeProgress(root, sessionId, progress)
      return { status: "not checked", step: n, title: plan.steps[n - 1].title, builders, suggestions: checked.suggestions }
    }
    const undone = checked.status === "blocked" && (await rollBack(`step ${n} blocked`))
    // Steps built before there was a check: the check covers the whole project, so they're judged by a run of their own
    if (checked.status === "pass") {
      const { built = [] } = readProgress(root, sessionId)
      const judged = verdict(readProgress(root, sessionId)).steps
      for (const b of built.filter((b) => !judged.some((s) => s.step === b.step))) checked.verdict = (await verify(b.step)).verdict
    }
    // Harness 2.0 W6 (WD-13): after a pass, the critic may earn one polish attempt; kept only if
    // every check and gate still passes, otherwise the passing files go back and are checked again
    if (checked.status === "pass" && polish) {
      const failures = verdict(readProgress(root, sessionId)).steps.find((s) => s.step === label)?.failures ?? 0
      const defects = failures + 1 < MAX_ATTEMPTS ? ((await polish.critique(plan.steps[n - 1], n).catch(() => [])) ?? []).filter((d) => d.severity === "major") : []
      const passing = defects.length ? await polish.snapshot(`step ${n} passed, before polish`).catch(() => undefined) : undefined
      if (passing) {
        const live = { n, attempt: builders.length + 1, startedAt: now(), steps: 0, polish: true }
        const tier = orchestra?.tier({ attempt: MAX_ATTEMPTS, step: plan.steps[n - 1] })
        if (tier) live.tier = tier
        building.set(sessionId, live)
        let built
        try {
          built = await spawn(builderPrompt(plan, n, undefined, v2?.rules, { limits, checked: hasCheck, briefing, ...(cartridge && { cartridge }), ...(slices && { slices }), polish: defects }), `Step ${n}: ${plan.steps[n - 1].title} (polish)`, live)
        } finally {
          if (building.get(sessionId) === live) building.delete(sessionId)
        }
        builders.push({ stopReason: built.stopReason ?? "completed", summary: textOf(built.output).slice(-600), steps: live.steps, polish: true })
        noteBuilder(root, sessionId, { step: label, stopReason: builders.at(-1).stopReason, steps: live.steps, ms: now() - live.startedAt, polish: defects.length, ...(live.tier && { tier: live.tier }), ...(cartridge && { cartridge: `${cartridge.id}@${cartridge.version}` }) })
        const after = await verify(label)
        if (after.status === "pass") return { status: "pass", step: n, title: plan.steps[n - 1].title, attempts: after.attempts, builders, command: after.command, output: "", verdict: after.verdict, polished: defects.length }
        await polish.restore(passing, `polish of step ${n} broke a check`)
        const again = await verify(label)
        return { status: again.status, step: n, title: plan.steps[n - 1].title, attempts: again.attempts, builders, command: again.command, output: again.output ?? "", verdict: again.verdict, polishReverted: true }
      }
    }
    if (checked.status === "pass" || checked.status === "blocked")
      return { status: checked.status, step: n, title: plan.steps[n - 1].title, attempts: checked.attempts, builders, command: checked.command, output: checked.output ?? "", verdict: checked.verdict, ...(undone && { rolledBack: true }) }
    const earlier = previous
    earlierRun = earlier
    previous = { attempt: checked.attempts, command: checked.command, exitCode: checked.exitCode, timedOut: checked.timedOut, output: checked.output, ...(checked.failure && { kind: checked.failure }), ...(checked.signature && { sig: checked.signature }) }
    const repeated = guard && checked.signature && earlier?.sig === checked.signature
    // A builder that died on an error says nothing about the code; its attempts just run out
    // Only exit 126/127 proves the command can't run; ENOENT or a missing module can be the code's own bug
    const cantRun = checked.exitCode === 126 || checked.exitCode === 127
    // Orchestra: a worker that repeats itself without changing a file gets one head-level attempt
    // first; the head repeating itself, or a check that can't run, stalls exactly as before
    if (repeated && built.stopReason !== "error" && untouched && !cantRun && orchestra && !headTried) forceHead = true
    else if (repeated && built.stopReason !== "error" && (untouched || cantRun)) {
      const reason = untouched ? "the same failure again with no file changed" : "the check can't run on this machine"
      const after = markStalled(root, sessionId, reason)
      const undone = await rollBack(`step ${n} blocked`)
      return { status: "blocked", step: n, title: plan.steps[n - 1].title, attempts: checked.attempts, builders, command: checked.command, output: checked.output ?? "", verdict: after.status, stalled: reason, ...(undone && { rolledBack: true }) }
    }
    if (repeated) previous.note = "This is the same failure as the attempt before it, so that approach didn't work: find another cause before changing code."
    start = tree
    broken = ["syntax", "type"].includes(checked.failure) ? broken + 1 : 0
    if (broken >= BROKEN_ATTEMPTS && (await rollBack(`attempts ${checked.attempts - 1} and ${checked.attempts} of step ${n} broke the build`))) {
      broken = 0
      start = base
      builders.at(-1).rolledBack = true
      previous.note = `The last ${BROKEN_ATTEMPTS} attempts broke the build, so all their changes were undone: the files are as they were before this step. Start again, smaller, and run the check as you go.`
    }
    if (v2) {
      const rank = RANK[checked.failure] ?? RANK.unknown
      if (best?.tree && v2.restore && rank < best.rank) {
        await v2.restore(best.tree, `back to attempt ${best.attempt} of step ${n}`)
        builders.at(-1).setAside = true
        start = best.tree
        previous = {
          ...best.previous,
          attempt: checked.attempts,
          note: `Attempt ${checked.attempts} failed further from passing (${checked.failure}) than attempt ${best.attempt} (${best.previous.kind}), so its changes were set aside: the files are as attempt ${best.attempt} left them, and the output above is that attempt's. Try a different fix.`,
        }
      } else best = { rank, tree, attempt: checked.attempts, previous }
    }
    status[n - 1] = { ...before, status: "fail", attempts: checked.attempts }
  }
}

/**
 * Harness 2.0 W14 (WD-18): Explore. `takes` (2–3) builders one after another
 * in the same folder, each from the step's starting files with its own
 * direction hint (src/explore.js), each snapshotted and checked (a failed take
 * counts as an attempt). Passing takes are offered to the person (`pick`);
 * with no answer, the critic's ranking (`rank`), else take order, decides. The
 * kept take's files are restored and checked again, so the step's last run is
 * the kept take's; every take stays in `kriya undo --list`. No polish here,
 * so takes + one retry stays inside MAX_ATTEMPTS.
 * @returns {Promise<{ result?: object, previous?: object, tree?: string, attempts?: number }>}
 */
async function exploreTakes({ plan, n, label, takes, root, cwd, sessionId, spawn, verify, explore, cartridge, slices, briefing, limits, hasCheck, v2, orchestra, builders, now }) {
  const step = plan.steps[n - 1]
  const hints = directionHints(step.role, takes, root)
  const base = await explore.snapshot(`before explore of step ${n}`)
  const done = []
  for (let v = 1; v <= takes; v++) {
    if (v > 1) await explore.restore(base, `explore: back to the start of step ${n} for take ${v}`)
    const hint = hints[v - 1]
    const served = await explore.served?.()
    const live = { n, attempt: builders.length + 1, startedAt: now(), steps: 0, take: v }
    // Takes are built on the worker level (the first attempt's level)
    const tier = orchestra?.tier({ attempt: 1, step })
    if (tier) live.tier = tier
    building.set(sessionId, live)
    let built
    try {
      const prompt = `${builderPrompt(plan, n, undefined, v2?.rules, { limits, checked: hasCheck, briefing, ...(cartridge && { cartridge }), ...(slices && { slices }) })}\n\n${takeSection(v, takes, hint)}`
      built = await spawn(prompt, `Step ${n}: ${step.title} (take ${v} of ${takes})`, live)
    } finally {
      if (building.get(sessionId) === live) building.delete(sessionId)
    }
    builders.push({ stopReason: built.stopReason ?? "completed", summary: textOf(built.output).slice(-600), steps: live.steps, take: v })
    noteBuilder(root, sessionId, { step: label, stopReason: builders.at(-1).stopReason, steps: live.steps, ms: now() - live.startedAt, take: v, direction: hint.id, ...(live.tier && { tier: live.tier }), ...(cartridge && { cartridge: `${cartridge.id}@${cartridge.version}` }) })
    const tree = await explore.snapshot(`explore take ${v} of step ${n}: ${hint.id}`)
    // The dev server must serve this take before any gate looks at it
    const reload = served !== undefined && explore.reloaded ? await explore.reloaded(served) : { ok: true }
    if (!reload.ok) {
      done.push({ v, hint, tree, status: "not checked", reason: reload.reason })
      continue
    }
    const checked = await verify(label)
    done.push({ v, hint, tree, status: checked.status, checked })
    if (checked.status === "blocked") break
  }
  const survivors = done.filter((t) => t.status === "pass")
  const record = (kept, by) => {
    const progress = readProgress(root, sessionId)
    writeProgress(root, sessionId, { ...progress, explore: [...(progress.explore ?? []), { step: label, takes: done.map((t) => ({ take: t.v, direction: t.hint.id, status: t.status, tree: t.tree, ...(t.reason && { reason: t.reason }) })), ...(kept && { kept, by }) }] })
  }
  if (!survivors.length) {
    record(undefined)
    // A take the dev server never served wasn't checked, so it isn't an attempt: stop rather than spend builders past the bound
    const unserved = done.find((t) => t.status === "not checked")
    if (unserved) return { result: { status: "not checked", step: n, title: step.title, builders, note: `Take ${unserved.v} wasn't checked: ${unserved.reason}. Make sure the dev server reloads on file changes, then run the step again.`, explore: { takes: done.map((t) => ({ take: t.v, direction: t.hint.id, status: t.status })) } } }
    const failed = done.filter((t) => t.checked && t.status !== "pass")
    const ranked = [...failed].sort((a, b) => (RANK[a.checked.failure] ?? RANK.unknown) - (RANK[b.checked.failure] ?? RANK.unknown) || b.v - a.v)
    const best = ranked.at(-1)
    const attempts = done.reduce((most, t) => Math.max(most, t.checked?.attempts ?? 0), 0)
    if (!best) return { tree: base, attempts }
    if (done.some((t) => t.status === "blocked")) return { result: { status: "blocked", step: n, title: step.title, attempts, builders, command: best.checked.command, output: best.checked.output ?? "", verdict: best.checked.verdict, explore: { takes: done.map((t) => ({ take: t.v, direction: t.hint.id, status: t.status })) } } }
    await explore.restore(best.tree, `explore: no take of step ${n} passed; going on from take ${best.v}`)
    const c = best.checked
    return {
      tree: best.tree,
      attempts,
      previous: { attempt: c.attempts, command: c.command, exitCode: c.exitCode, timedOut: c.timedOut, output: c.output, ...(c.failure && { kind: c.failure }), ...(c.signature && { sig: c.signature }), note: `None of the ${takes} takes passed. The files are as take ${best.v} (${best.hint.id}) left them, the closest to passing; fix that take.` },
    }
  }
  let winner
  let by = "only"
  if (survivors.length > 1) {
    const picked = await explore.pick?.(survivors, step, n)
    winner = survivors.find((t) => t.v === picked)
    by = "person"
    if (!winner) {
      const ranked = (await explore.rank?.(survivors, step, n).catch(() => undefined)) ?? []
      winner = survivors.find((t) => t.v === ranked[0]) ?? survivors[0]
      by = ranked.length ? "critic" : "order"
    }
  } else winner = survivors[0]
  await explore.restore(winner.tree, `explore: keep take ${winner.v} of step ${n}`)
  record(winner.v, by)
  const final = await verify(label)
  return {
    result: {
      status: final.status,
      step: n,
      title: step.title,
      attempts: final.attempts,
      builders,
      command: final.command,
      output: final.output ?? "",
      verdict: final.verdict,
      explore: { kept: winner.v, by, direction: winner.hint.id, takes: done.map((t) => ({ take: t.v, direction: t.hint.id, status: t.status })) },
    },
  }
}
