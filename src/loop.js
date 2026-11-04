import { RANK } from "./failure.js"
import { MAX_ATTEMPTS, normalStep, readProgress, trimOutput, verdict, VerifyError, writeProgress } from "./verify.js"
import { projectRoot } from "./skill-switches.js"

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
 * @returns {{ goal: string, steps: Array<{ title: string, doneWhen: string, files: string[], after?: number[] }> }}
 */
export function validatePlan(input, { v2 = false } = {}) {
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
    return { title, doneWhen, files, ...(v2 && { after: dependencies(step?.after, i + 1) }) }
  })
  const titles = new Set(out.map((s) => s.title.toLowerCase()))
  if (titles.size !== out.length) throw new VerifyError("Two steps have the same title; each step is one distinct piece of work.")
  return { goal, steps: out }
}

/** The step label kriya_verify records runs under: "<n> <title>", within its limits */
export const stepLabel = (plan, n) => normalStep(`${n} ${plan.steps[n - 1].title}`.replace(/[^\p{L}\p{N} ._:/#()-]/gu, " ").replace(/\s+/g, " ").slice(0, 80).trim())

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

export function readPlan(cwd, sessionId) {
  return readProgress(projectRoot(cwd), sessionId).plan
}

/** Where each step stands, from the recorded runs */
export function planStatus(cwd, sessionId) {
  const progress = readProgress(projectRoot(cwd), sessionId)
  if (!progress.plan) return undefined
  const { steps } = verdict(progress)
  const rows = []
  progress.plan.steps.forEach((step, i) => {
    const label = stepLabel(progress.plan, i + 1)
    const found = steps.find((s) => s.step === label)
    // v2: a step that needs a blocked or skipped step is skipped; one pass in plan order suffices, since deps point back
    const stuck = !found && step.after?.some((d) => ["blocked", "skipped"].includes(rows[d - 1].status))
    rows.push({ n: i + 1, title: step.title, status: stuck ? "skipped" : (found?.status ?? "not started"), attempts: found?.attempts ?? 0, ...(step.after && { after: step.after }) })
  })
  return rows
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
  const STATE = { pass: "passed", fail: "failing", blocked: "blocked", skipped: "skipped", "not started": "not started" }
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
export function builderPrompt(plan, n, previous, rules = []) {
  const step = plan.steps[n - 1]
  const lines = [
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
  if (rules.length) lines.push("", "Rules for this project, confirmed by the person:", ...rules)
  lines.push(
    "",
    "Read the code you need, make the change, and keep it small. Don't change other steps' work unless your step needs it.",
    "Don't call kriya_plan or kriya_step: you are the step. You may call kriya_verify to test your change before you finish.",
    "When you finish, the harness runs the project's check; that result, not your summary, decides whether the step passes. End with two or three sentences on what you changed."
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
  return lines.join("\n")
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
 * @param {{ cwd: string, sessionId: string, n: number, spawn: (prompt: string, label: string) => Promise<{ output: any[], stopReason?: string }>, verify: (label: string) => Promise<any>, v2?: { snapshot?: (label: string) => Promise<string | undefined>, restore?: (tree: string, label: string) => Promise<unknown>, rules?: string[] } }} input
 */
export async function runStep({ cwd, sessionId, n, spawn, verify, v2 }) {
  const plan = readPlan(cwd, sessionId)
  if (!plan) throw new VerifyError("There's no plan yet: call kriya_plan first.")
  if (!Number.isInteger(n) || n < 1 || n > plan.steps.length) throw new VerifyError(`The plan has steps 1 to ${plan.steps.length}.`)
  const status = planStatus(cwd, sessionId)
  const deps = plan.steps[n - 1].after
  if (deps) {
    const stuck = deps.map((d) => status[d - 1]).find((s) => s.status === "blocked" || s.status === "skipped")
    if (stuck) return { status: "skipped", step: n, title: plan.steps[n - 1].title, builders: [], note: `It needs step ${stuck.n} (${stuck.title}), which is ${stuck.status}, so nothing was built.` }
    const open = deps.map((d) => status[d - 1]).find((s) => s.status !== "pass")
    if (open) throw new VerifyError(`Step ${n} needs step ${open.n} (${open.title}) first, and it hasn't passed yet.`)
  } else {
    const open = status.find((s) => s.n < n && s.status !== "pass" && s.status !== "blocked")
    if (open) throw new VerifyError(`Steps run in order: step ${open.n} (${open.title}) isn't finished yet.`)
  }
  const label = stepLabel(plan, n)
  const builders = []
  let previous
  let best
  for (;;) {
    const before = status[n - 1]
    if (before.status === "pass") return { status: "pass", step: n, title: plan.steps[n - 1].title, attempts: before.attempts, builders, note: "This step already passed." }
    const built = await spawn(builderPrompt(plan, n, previous, v2?.rules), `Step ${n}: ${plan.steps[n - 1].title}`)
    builders.push({ stopReason: built.stopReason ?? "completed", summary: textOf(built.output).slice(-600) })
    const tree = await v2?.snapshot?.(`attempt ${builders.length} of step ${n}`)
    const checked = await verify(label)
    if (checked.status === "not configured")
      return { status: "not checked", step: n, title: plan.steps[n - 1].title, builders, suggestions: checked.suggestions }
    if (checked.status === "pass" || checked.status === "blocked")
      return { status: checked.status, step: n, title: plan.steps[n - 1].title, attempts: checked.attempts, builders, command: checked.command, output: checked.output ?? "", verdict: checked.verdict }
    previous = { attempt: checked.attempts, command: checked.command, exitCode: checked.exitCode, timedOut: checked.timedOut, output: checked.output, ...(checked.failure && { kind: checked.failure }) }
    if (v2) {
      const rank = RANK[checked.failure] ?? RANK.unknown
      if (best?.tree && v2.restore && rank < best.rank) {
        await v2.restore(best.tree, `back to attempt ${best.attempt} of step ${n}`)
        builders.at(-1).setAside = true
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
