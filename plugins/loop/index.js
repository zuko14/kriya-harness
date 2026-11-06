import { createUserMessage } from "@deepseek-ai/dsh-llm"
import { defineTool } from "@deepseek-ai/dsh-tools"

import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { extname, join, resolve } from "node:path"

import { checkpoint, restoreTree } from "../../src/checkpoints.js"
import { rankSkills } from "../../src/intent.js"
import { builderLimits, loopStateText, MAX_STEPS, nextStep, planStatus, readPlan, runStep, savePlan, seededPlan, writeSnapshot } from "../../src/loop.js"
import { blastRadius, importers, importGraph, insideFolder, MAX_READ_LINES, outline, ReconError, readPage } from "../../src/recon.js"
import { confirmedRules } from "../../src/rules.js"
import { projectRoot } from "../../src/skill-switches.js"
import { TASK_KINDS } from "../../src/strict.js"
import { confirmedCheck, currentVerdict, VerifyError, verifyStep } from "../../src/verify.js"

// The Kriya loop, node half (H14a; KRIYA_LOOP.md in the Kriya repository):
// `kriya_verify` runs the project's confirmed check and reports pass, fail
// or blocked from its exit code. It takes no command: the person confirmed
// the check with `kriya verify use`, so the model can neither change what
// "passing" means nor run anything it couldn't run with bash. The command
// runs the way DSH's own bash tool runs one: in the session's folder,
// under the session's standing sandbox policy, through ctx.shell.
// Before every tool call that can change files, the working tree is saved
// as a checkpoint on Kriya's own git ref (src/checkpoints.js, H14b), so
// `kriya undo` goes back one step; not in Read only, where nothing changes.
// Off unless kriya was started with --loop (the bundle row's switch).
// Loop v2 (KRIYA_LOOP_V2=on, `--loop-v2`; KRIYA_LOOP_V2.md): plan steps
// name the steps they need, failures carry a class, a pass that changed
// tests must hold on the originals, a worse attempt is set aside, and the
// person's confirmed rules reach the builders. Off, everything is as v1.
// The loop guard (KRIYA_LOOP_GUARD=on, `--loop-guard`): an agent stopping with
// plan steps still to do is sent back; a step stops spending builders when
// more can't help; a builder that died on an error isn't an attempt; and a
// resumed step keeps its last failure. Off, none of it happens.
// The strict loop (`--strict-loop`, includes the guard): the task contract,
// the fast rungs before the person's check, weakened tests and silenced
// compilers refused, bug fixes proved red then green, a step as one
// transaction. Recon (`--recon`): code_outline, code_impact and bounded
// reads. JIT tools (`--jit-tools`): a builder gets browser and reverse-
// engineering tools only when its step needs them, and a hint of the skills
// that fit. All off by default.

export const name = "kriya-loop"
export const inject = ["tools", "shell", "workingDirectory", "shellEnv", "systemPrompt"]

// Long enough for a real test suite; DSH's executor kills it after this
const TIMEOUT_MS = 10 * 60_000

// DSH's tools that can change files: fs write and edit, the shells, and
// code runs (PTC, workflows)
export const FILE_TOOLS = new Set(["write", "edit", "bash", "pwsh", "run_code", "workflow"])

/** What a checkpoint is called: the tool and what it was about to do */
export function checkpointLabel(exec) {
  const args = exec.arguments && typeof exec.arguments === "object" ? exec.arguments : {}
  const about = [args.description, args.path, args.file_path, args.command].find((v) => typeof v === "string" && v.trim())
  return `before ${exec.name}${about ? `: ${about}` : ""}`
}

/**
 * The pre-execute hook: a checkpoint before a file-changing call, one at a
 * time per folder (they share Kriya's index), then the call. A checkpoint
 * that fails is logged and the call goes ahead: it's a safety net, not a gate.
 * @param {{ cwd: (exec: any) => Promise<string>, readOnly: (exec: any) => boolean, save?: typeof checkpoint, warn: (text: string) => void }} host
 */
export function checkpointHook(host) {
  const save = host.save ?? checkpoint
  const queues = new Map()
  return async (exec, next) => {
    if (FILE_TOOLS.has(exec.name) && exec.agent && !host.readOnly(exec)) {
      try {
        const cwd = await host.cwd(exec)
        const previous = queues.get(cwd) ?? Promise.resolve()
        const mine = previous.then(() => save(cwd, String(exec.agent.id), checkpointLabel(exec)))
        queues.set(cwd, mine.catch(() => {}))
        await mine
      } catch (error) {
        host.warn(`no checkpoint before ${exec.name}: ${error?.message ?? error}`)
      }
    }
    return next()
  }
}

export const GUIDANCE =
  "This project has a verify step. After you change files for a step of the task, call kriya_verify " +
  "with a short step label. Only its result says whether the work passes: never say tests pass, " +
  "or that the task is done, without a passing kriya_verify. On a failure, fix the cause using the " +
  "output and call it again; after the last attempt the step is blocked: stop, and tell the person " +
  "what failed and why.\n\n" +
  `For a task with several parts, plan first: call kriya_plan with the goal and at most ${MAX_STEPS} ordered steps ` +
  "(each a title, done_when and the files it touches), then call kriya_step for step 1, 2, … in order. " +
  "kriya_step has a fresh agent build the step and the harness check it, retrying with the error; " +
  "don't redo a step's work yourself. If a step is blocked, stop and report it. End with each step's result."

export const GUIDANCE_V2 =
  " Give each step `after`: the numbers of the earlier steps it needs (none for a step that needs nothing); " +
  "a step whose needed step is blocked is skipped, so the others still run."

function present(value) {
  switch (value.status) {
    case "not configured":
      return [
        "No check is confirmed for this project, so nothing was run and the work is not checked.",
        value.suggestions.length
          ? `The person can confirm one with \`kriya verify use <number>\`:\n${value.suggestions.map((s, i) => `${i + 1}. ${s.command} (${s.source})`).join("\n")}`
          : "The project defines no check the harness recognises; the person can set one with `kriya verify use \"<command>\"`.",
        "Tell the person this; don't claim the work passes.",
      ].join("\n")
    case "blocked":
      return `Step "${value.step}" is blocked: \`${value.command}\` failed ${value.attempts === undefined ? "" : `on all ${value.attempts} runs `}and isn't run again. Stop and tell the person what failed.${value.output ? `\n\n${value.output}` : ""}`
    case "pass":
      return `Step "${value.step}" passes: \`${value.command}\` exited 0. Session verdict: ${value.verdict}.${
        value.touched?.length
          ? ` This work changes test or check files (${value.touched.join(", ")}): tell the person, since a changed test can pass for the wrong reason.`
          : ""
      }`
    default:
      return [
        `Step "${value.step}" fails: \`${value.command}\` ${value.timedOut ? "timed out" : `exited ${value.exitCode ?? "without a code"}`}. ${value.attemptsLeft} attempt${value.attemptsLeft === 1 ? "" : "s"} left.`,
        value.failure === "tests changed"
          ? `It passed only with changed tests or check files (${value.weakened.join(", ")}); with the originals it fails, as below. Fix the code, not the tests.`
          : value.failure && `Failure class: ${value.failure}.`,
        value.output,
        value.rules?.length && `Rules for this project, confirmed by the person:\n${value.rules.join("\n")}`,
      ]
        .filter(Boolean)
        .join("\n\n")
  }
}

/**
 * @param {{ cwd: (exec: any) => Promise<string>, run: (command: string, exec: any) => Promise<{ exitCode: number | null, timedOut: boolean, aborted?: boolean, output: string }> }} host
 */
export function verifyTool(host) {
  return defineTool({
    name: "kriya_verify",
    description:
      "Run this project's confirmed check (its tests, lint or build, as the person chose) for one step of the task, and get pass, fail or blocked from its exit code. Takes no command. Call it after changing files; a step is blocked after 4 failed runs.",
    parameters: {
      step: { type: "string", description: "A short label for the step being checked, e.g. \"2 parser handles empty input\" (default: all)." },
    },
    output: {
      schema: {
        type: "object",
        // The fields after status and step depend on it (pass, fail, blocked, not configured)
        additionalProperties: true,
        properties: {
          status: { type: "string", required: true },
          step: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: present(value) }],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new VerifyError("kriya_verify needs a session.")
      const cwd = await host.cwd(exec)
      const result = await verifyStep({ cwd, sessionId: String(exec.agent.id), step: args.step, run: (command) => host.run(command, exec, cwd), ...(host.v2 && { v2: host.v2(exec) }), ...(host.guard && { guard: true }), ...(host.strict && { strict: host.strict(exec) }) })
      const rules = host.v2 && result.status === "fail" ? confirmedRules(cwd) : []
      return rules.length ? { ...result, rules } : result
    },
    presentCall: (args) => ({ card: "generic", title: "Verify", kind: "execute", rawInput: typeof args.step === "string" ? args.step : "all" }),
  })
}

const PLAN_STEP = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", required: true, description: "What the step does, in a few words." },
    done_when: { type: "string", required: true, description: "What is true when the step is finished, checkable by the project's check." },
    files: { type: "array", items: { type: "string" }, description: "Files the step expects to touch." },
  },
}
const PLAN_STEP_V2 = {
  ...PLAN_STEP,
  properties: {
    ...PLAN_STEP.properties,
    after: { type: "array", items: { type: "number" }, description: "Numbers of the earlier steps this one needs; [] for none. Default: the step before it." },
  },
}

// The task contract: what kriya_plan adds under the strict loop. It can only add to what must hold
const CONTRACT = {
  kind: { type: "string", enum: TASK_KINDS, description: "What sort of task this is; it bounds the plan (a surgical_bugfix has at most 2 steps, and its fix must be proved red then green)." },
  invariants: { type: "array", items: { type: "string" }, description: "Paths that must not change, e.g. db/schema.ts or migrations/*." },
  acceptance: { type: "array", items: { type: "string" }, description: "Up to 3 commands that must also exit 0, beyond the project's check." },
}

// The pre-mortem: what kriya_plan adds under the defensive engine
const PREMORTEM = {
  premortem: {
    type: "object",
    additionalProperties: false,
    description: "Needed for a plan of 2 or more steps: think through how this breaks before building it.",
    properties: {
      failures: { type: "array", items: { type: "object", additionalProperties: false, properties: { what: { type: "string", description: "One way this could crash or misbehave at run time." }, covered_by: { type: "string", description: "The test file, existing or to be written, that proves it can't happen." } } }, description: "At least 2." },
      blast_radius: { type: "array", items: { type: "string" }, description: "Other features, tables or routes that share this surface." },
      negatives: { type: "array", items: { type: "string" }, description: "Bad inputs to handle: nulls, empty states, boundaries, timeouts." },
    },
  },
}

/** What the harness itself traced from the plan's files, so the agent can compare it with what it declared */
function traced(cwd, plan) {
  const root = projectRoot(cwd)
  const files = [...new Set(plan.steps.flatMap((s) => s.files))].filter((f) => existsSync(join(root, f)))
  if (!files.length) return undefined
  const graph = importGraph(root)
  const r = blastRadius(graph, files.map((rel) => ({ rel, before: graph.text(rel), after: graph.text(rel) })))
  const near = [...r.direct, ...r.transitive]
  if (!near.length && !r.tests.length) return undefined
  return `Traced from the plan's files: ${near.length} file${near.length === 1 ? "" : "s"} can be reached (${near.slice(0, 8).join(", ")}${near.length > 8 ? ", …" : ""}); ${r.tests.length} test file${r.tests.length === 1 ? "" : "s"} will run before any pass. If your blast_radius misses these, plan for them now.`
}

export const NO_CHECK_PLAN =
  "No check is confirmed for this project yet. When a step leaves a build or test script, Kriya asks the person to pick it, so have the first step add one. " +
  "Until then steps are built but not checked; the person can also confirm one with `kriya verify use \"<command>\"`."

// Long enough to answer, short enough that a person who walked away doesn't stall a long task
export const CHECK_QUESTION_MS = 120_000
const NOT_NOW = "Not now"

/**
 * The harness itself asks the person which found check to use: the question goes straight to their UI,
 * so the model can't answer it. Only an offered command they selected counts; a typed one stays
 * `kriya verify use`. Undefined with no UI (`kriya run`), on no answer, and when the turn stops.
 * @returns {Promise<string | undefined>}
 */
export async function askCheck(questions, exec, found) {
  const offered = found.slice(0, 3)
  const answer = await questions
    ?.ask({
      agent: exec.agent,
      signal: AbortSignal.any([exec.signal, AbortSignal.timeout(CHECK_QUESTION_MS)]),
      questions: [
        {
          id: "kriya-check",
          header: "Check",
          question: "Which command should decide whether each step works?",
          detail: "Kriya runs it after every step and sends failures back to be fixed. These came from the project's files, which the agent may have written, so pick one only if it really tests the work. For any other command, run kriya verify use in a terminal: a typed answer here isn't used.",
          options: [...offered.map((c) => ({ label: c.command, description: `From ${c.source}` })), { label: NOT_NOW, description: "Steps stay not checked. You can pick one later in the Progress tab." }],
        },
      ],
    })
    .catch(() => undefined)
  const picked = answer?.answers?.find((a) => a.id === "kriya-check")?.selected?.[0]
  return offered.find((c) => c.command === picked)?.command
}

// DSH refuses a tool's output holding an undefined value, after the tool already ran:
// a recorded plan came back as an error and spent a plan slot. An absent field is simply left out
const plain = (value) => JSON.parse(JSON.stringify(value))

const renderStatus = (rows) =>
  rows.map((r) => `${r.n}. ${r.title}${r.after?.length ? ` (after ${r.after.join(", ")})` : ""}: ${r.status}${r.attempts ? ` (${r.attempts} run${r.attempts === 1 ? "" : "s"})` : ""}`).join("\n")

/** @param {{ isBuilder: (exec: any) => boolean, cwd: (exec: any) => Promise<string>, v2?: unknown }} host */
export function planTool(host) {
  return defineTool({
    name: "kriya_plan",
    description: `Record the plan for a task with several parts: a goal and 1 to ${MAX_STEPS} ordered steps. Then run each with kriya_step, in order.`,
    parameters: {
      goal: { type: "string", required: true, description: "What the task is for, in one sentence." },
      steps: { type: "array", required: true, items: host.v2 ? PLAN_STEP_V2 : PLAN_STEP, description: `1 to ${MAX_STEPS} ordered steps.` },
      ...(host.strict && CONTRACT),
      ...(host.defensive && PREMORTEM),
    },
    output: {
      schema: { type: "object", additionalProperties: true, properties: { steps: { type: "array", required: true, items: { type: "object", additionalProperties: true, properties: {} } } } },
      render: (_args, value) => [
        {
          type: "text",
          text: `Plan recorded (${value.steps.length} step${value.steps.length === 1 ? "" : "s"}):\n${renderStatus(value.steps)}\nRun step 1 with kriya_step.${
            value.unchecked ? `\n${NO_CHECK_PLAN}` : ""
          }${value.radius ? `\n${value.radius}` : ""}`,
        },
      ],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new VerifyError("kriya_plan needs a session.")
      if (host.isBuilder(exec)) throw new VerifyError("A step's builder doesn't plan; build your step and stop.")
      const cwd = await host.cwd(exec)
      const id = String(exec.agent.id)
      const seed = seededPlan()
      // The person drew this plan in Kriya Flows: it isn't the model's to change
      if (seed && readPlan(cwd, id)) throw new VerifyError("The person set this plan in Kriya. Run its steps with kriya_step; it can't be replanned here.")
      savePlan(cwd, id, seed ?? args, undefined, { v2: Boolean(host.v2), strict: Boolean(host.strict), defensive: Boolean(host.defensive) })
      writeSnapshot(cwd, id)
      return plain({ steps: planStatus(cwd, id), ...(!(host.checked ?? confirmedCheck)(cwd) && { unchecked: true }), ...(host.defensive && { radius: traced(cwd, readPlan(cwd, id)) }) })
    },
    presentCall: (args) => ({ card: "generic", title: "Plan", kind: "think", rawInput: typeof args.goal === "string" ? args.goal : "" }),
  })
}

function presentStep(value) {
  const head = `Step ${value.step} (${value.title}): ${value.status}${value.attempts ? ` after ${value.attempts} run${value.attempts === 1 ? "" : "s"}` : ""}.`
  const lines = [head]
  if (value.status === "not checked")
    lines.push("No check is confirmed for this project, so the step was built but not checked. Tell the person; they can confirm one with `kriya verify use <number>`.")
  if (value.status === "blocked") lines.push(`\`${value.command}\` ${value.stalled ? `was stopped early: ${value.stalled}, so more builders wouldn't help` : "kept failing"}. Stop and tell the person what failed:`, value.output)
  if (value.status === "interrupted") lines.push("Call kriya_step for this step again; if it comes back interrupted again, stop and tell the person.")
  if (value.status === "pass" && value.verdict) lines.push(`Session verdict so far: ${value.verdict}.`)
  for (const [i, b] of (value.builders ?? []).entries())
    if (b.limit) lines.push(`Builder ${i + 1} was stopped at its limit (${b.limit}); the check ran on the files it left.`)
  const aside = value.builders?.filter((b) => b.setAside).length
  if (aside) lines.push(`${aside} attempt${aside === 1 ? " was" : "s were"} set aside for failing further from passing than an earlier one (kept in kriya undo --list).`)
  if (value.note) lines.push(value.note)
  if (value.rolledBack) lines.push("The step's files went back to how they were before it; the attempts are kept in kriya undo --list.")
  const rolled = value.builders?.filter((b) => b.rolledBack).length
  if (rolled) lines.push("Attempts that broke the build were undone along the way.")
  const last = value.builders?.at(-1)?.summary
  if (last) lines.push(`The builder's own summary (not evidence): ${last}`)
  return lines.filter(Boolean).join("\n")
}

/**
 * @param {{ isBuilder: (exec: any) => boolean, cwd: (exec: any) => Promise<string>, spawn: (exec: any, prompt: string, label: string) => Promise<any>, verify: (exec: any, cwd: string, label: string) => Promise<any>, steps?: (exec: any, cwd: string) => object }} host
 *   steps: loop v2's snapshot, restore and rules for runStep
 */
export function stepTool(host) {
  return defineTool({
    name: "kriya_step",
    description:
      "Run one step of the recorded plan: a fresh agent builds it, the harness runs the project's confirmed check, and a failure goes back to a new builder with its output, up to 4 runs; then the step is blocked. Steps run in order.",
    parameters: {
      step: { type: "number", required: true, description: "The step's number in the plan, from 1." },
    },
    output: {
      schema: { type: "object", additionalProperties: true, properties: { status: { type: "string", required: true } } },
      render: (_args, value) => [{ type: "text", text: presentStep(value) }],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new VerifyError("kriya_step needs a session.")
      if (host.isBuilder(exec)) throw new VerifyError("A step's builder doesn't run steps; build your step and stop.")
      const cwd = await host.cwd(exec)
      const id = String(exec.agent.id)
      const n = Math.trunc(Number(args.step))
      writeSnapshot(cwd, id, { current: n })
      const result = await runStep({
        cwd,
        sessionId: id,
        n,
        hasCheck: Boolean((host.checked ?? confirmedCheck)(cwd)),
        ...(host.limits && { limits: host.limits }),
        spawn: (prompt, label, live) => host.spawn(exec, prompt, label, live),
        verify: (label) => host.verify(exec, cwd, label),
        ...(host.steps && { v2: host.steps(exec, cwd) }),
        ...(host.guardSteps && { guard: host.guardSteps(exec, cwd) }),
        ...(host.questions && { pickCheck: (found) => askCheck(host.questions(), exec, found) }),
      }).catch((error) => {
        // An abort rejects with DSH's plain reason ({ kind: "user" }), which reads as "[object Object]"
        throw error instanceof Error ? error : new VerifyError("The step was stopped before it finished.")
      })
      writeSnapshot(cwd, id)
      return plain(result)
    },
    presentCall: (args) => ({ card: "generic", title: "Build and check a step", kind: "execute", rawInput: `step ${args.step}` }),
  })
}

// The steps left when a builder is told to wrap up
export const BUILDER_WARN_STEPS = 8

export const builderWarning = (left) =>
  `Kriya: about ${left} step${left === 1 ? "" : "s"} or a few minutes left for this step's builder. Finish the core change now, ` +
  "stop anything you started in the background, and end with what you changed. You are stopped at the limit and the check runs on what you left."

/**
 * Bounds each step's builder by code (src/loop.js builderLimits): counts its
 * steps and time, warns once near the limit, refuses its next step at the
 * limit, and keeps its live record (steps, last tool) for the Progress tab.
 * Only agents registered with `start` are bounded; the parent and every
 * other agent pass through. Free of DSH so it can be tested alone.
 * @param {{ maxSteps: number, maxMinutes: number }} limits
 * @param {{ now?: () => number, message?: (text: string) => any }} [host]
 */
export function builderGuard(limits, host = {}) {
  const now = host.now ?? Date.now
  const message =
    host.message ??
    ((text) => createUserMessage({ content: [{ type: "text", text }], source: { kind: "kriya-loop", form: "notice", summary: "step builder limit" } }))
  /** @type {Map<string, { live: any, started: number, steps: number, warned: boolean }>} */
  const bounded = new Map()
  return {
    start: (id, live) => bounded.set(String(id), { live, started: now(), steps: 0, warned: false }),
    end: (id) => bounded.delete(String(id)),
    /** agent/pre-step (waterfall) */
    async preStep({ agent }, next) {
      const s = bounded.get(String(agent?.id))
      if (!s) return next()
      s.steps += 1
      s.live.steps = s.steps
      const tokens = host.tokens?.(agent)
      if (tokens > (s.live.tokens ?? 0)) s.live.tokens = tokens
      const elapsed = now() - s.started
      const reason = s.steps > limits.maxSteps ? `${limits.maxSteps} steps` : elapsed > limits.maxMinutes * 60_000 ? `${limits.maxMinutes} minutes` : null
      if (reason) {
        s.live.stopped ??= reason
        return { kind: "reject" }
      }
      const decision = await next()
      const left = limits.maxSteps - s.steps + 1
      const late = left <= BUILDER_WARN_STEPS || elapsed > limits.maxMinutes * 48_000
      if (s.warned || !late || decision.kind !== "enter") return decision
      s.warned = true
      return { ...decision, messages: [...decision.messages, message(builderWarning(Math.max(1, left)))] }
    },
    /** tools/pre-execute (waterfall): the builder's latest tool, for the Progress tab */
    async preExecute(exec, next) {
      const s = exec.agent && bounded.get(String(exec.agent.id))
      if (s) s.live.last = exec.name
      return next()
    },
  }
}

// U8: said once in a turn when the files changed after the last passing check
export const RECHECK =
  "Files changed after the last passing kriya_verify, so that pass no longer covers the work. " +
  "Call kriya_verify again before you finish; don't say the work passes until it does."

/**
 * The agent/turn-stopping hook (U8): a "verified" session whose files changed
 * since is stale; the agent is asked once per turn to check again. Data
 * decides (the files' fingerprint), never what the model says.
 * @param {{ cwd: (exec: any) => Promise<string>, verdict?: typeof currentVerdict, message?: (text: string) => any }} host
 */
export function recheckHook(host) {
  const verdictOf = host.verdict ?? currentVerdict
  const message = host.message ?? ((text) => createUserMessage({ content: [{ type: "text", text }], source: { kind: "kriya-loop", form: "notice", summary: "check again" } }))
  const asked = new WeakMap()
  return async ({ agent, turn, signal }) => {
    if (asked.get(agent) === turn) return
    const cwd = await host.cwd({ agent, signal })
    const now = await verdictOf(cwd, String(agent.id))
    if (!now.stale) return
    asked.set(agent, turn)
    agent.steer(message(RECHECK))
  }
}

// The loop guard: said when an agent stops with plan steps it could still run
export const finishNotice = (step) =>
  `The plan isn't finished: step ${step.n} (${step.title}) is ${step.status === "fail" ? "failing" : "not started"}. ` +
  `Run it with kriya_step. If it can't go on, say exactly why; don't report the task as done.`

/**
 * The agent/turn-stopping hook (loop guard): the records decide, never what
 * the model says. Once per turn and step reached, so an agent that keeps
 * stopping is asked again only after a step has moved, at most once per step.
 * @param {{ cwd: (exec: any) => Promise<string>, readOnly?: (exec: any) => boolean, rows?: typeof planStatus, message?: (text: string) => any }} host
 */
export function finishHook(host) {
  const rowsOf = host.rows ?? planStatus
  const message = host.message ?? ((text) => createUserMessage({ content: [{ type: "text", text }], source: { kind: "kriya-loop", form: "notice", summary: "finish the plan" } }))
  const asked = new WeakMap()
  return async ({ agent, turn, signal }) => {
    if (host.readOnly?.({ agent })) return
    const cwd = await host.cwd({ agent, signal })
    const rows = rowsOf(cwd, String(agent.id))
    const next = nextStep(rows)
    if (!next) return
    const mark = `${turn}:${next.n}`
    if (asked.get(agent) === mark) return
    asked.set(agent, mark)
    agent.steer(message(finishNotice(next)))
  }
}

export const GUIDANCE_STRICT =
  " Give kriya_plan the task contract: kind, invariants (paths that must not change) and acceptance (commands that must also exit 0). " +
  "Each check runs cheapest first, so a syntax or type error comes back before the tests run. Tests may be added, never weakened; " +
  "don't add any, @ts-ignore or empty catches to get past a check. A bug fix must fail on the old code: add the failing test."

export const GUIDANCE_DEFENSIVE =
  " Think before you build: ask what else this change could break and how it could fail at run time. A plan of 2 or more steps needs a premortem: " +
  "failures (each with the test that proves it can't happen), blast_radius and negatives. Tests of neighbouring code run before any pass; the diff is " +
  "checked for broken callers and missing awaits; anything new needs a test with a bad input."

export const GUIDANCE_RECON =
  ` Before reading a file, call code_outline for its symbols and read only the lines you need (at most ${MAX_READ_LINES} per read). Before changing something shared, call code_impact to see what imports it.`

function reconTools(host) {
  const OBJECT = { schema: { type: "object", additionalProperties: true, properties: {} } }
  const guarded = (work) => async (args, exec) => {
    try {
      return await work(await host.cwd(exec), args)
    } catch (error) {
      if (error instanceof ReconError) throw new VerifyError(error.message)
      throw error
    }
  }
  return [
    defineTool({
      name: "code_outline",
      description: "A source file's functions, classes, types and constants with their line numbers, and its length. Use it before reading a file, then read only the lines you need.",
      parameters: { path: { type: "string", required: true, description: "The file, relative to the session's folder." } },
      output: { ...OBJECT, render: (_a, v) => [{ type: "text", text: `${v.path} (${v.lines} lines)\n${v.symbols.map((s) => `${s.line}: ${s.kind} ${s.name}`).join("\n") || "No symbols recognised."}${v.cut ? `\n… ${v.cut} more` : ""}` }] },
      execute: guarded((cwd, args) => outline(cwd, args.path)),
      presentCall: (args) => ({ card: "generic", title: "Outline", kind: "read", rawInput: String(args.path ?? "") }),
    }),
    defineTool({
      name: "code_impact",
      description: "The project's files that import a file, so you know what a change can break before you make it.",
      parameters: { path: { type: "string", required: true, description: "The file, relative to the session's folder." } },
      output: { ...OBJECT, render: (_a, v) => [{ type: "text", text: v.importers.length ? `Imported by:\n${v.importers.join("\n")}` : "Nothing in this project imports it, as far as its import lines show." }] },
      execute: guarded((cwd, args) => {
        insideFolder(cwd, args.path)
        return { importers: importers(cwd, args.path).slice(0, 100) }
      }),
      presentCall: (args) => ({ card: "generic", title: "Impact", kind: "read", rawInput: String(args.path ?? "") }),
    }),
  ]
}

/** tools/post-execute (recon): a long read reaches the model as one page, never as a refusal */
export function readHook() {
  return async (exec, result, next) => {
    const decision = await next()
    if (exec.name !== "read" || !exec.agent || decision.kind !== "accept" || result.isError || Object.hasOwn(decision, "content")) return decision
    const text = readPage(result.value ?? {})
    return text ? { ...decision, content: [{ type: "text", text }] } : decision
  }
}

const PARSERS = { ".js": ["node", ["--check"]], ".mjs": ["node", ["--check"]], ".cjs": ["node", ["--check"]], ".py": ["python3", ["-c", "import ast,sys; ast.parse(open(sys.argv[1]).read(), sys.argv[1])"]] }

/** The parse error of one file, or undefined: reads it, never runs it */
export function parseError(file) {
  const parser = PARSERS[extname(file)]
  if (!parser) return Promise.resolve(undefined)
  return new Promise((done) => execFile(parser[0], [...parser[1], file], { timeout: 10_000 }, (error, _out, stderr) => done(error && !error.killed && error.code !== "ENOENT" ? String(stderr).trim().slice(0, 1200) : undefined)))
}

/** tools/post-execute (strict): level 1 of the ladder, on the edit itself, so a broken file costs no check run */
export function syntaxHook(host) {
  const check = host.parse ?? parseError
  return async (exec, result, next) => {
    const decision = await next()
    const path = exec.arguments?.file_path
    if (decision.kind !== "accept" || result.isError || !["write", "edit"].includes(exec.name) || typeof path !== "string" || !exec.agent || Object.hasOwn(decision, "content") || Object.hasOwn(decision, "value")) return decision
    const error = await check(resolve(await host.cwd(exec), path))
    if (!error) return decision
    return { ...decision, content: [...(result.content ?? []), { type: "text", text: `This file no longer parses; fix it before going on:\n${error}` }] }
  }
}

// Heavy tools by name, and the words in a step that need them
const HEAVY = [
  [/^browser_/, /\b(browser|page|ui|css|layout|frontend|screen|visual|html|render\w*|click|form|button)\b/i],
  [/^rea_/, /\b(reverse|binary|decompil\w*|disassembl\w*|apk|firmware)\b/i],
]

/** The tools a builder doesn't need for this step */
export function toolsToHide(names, step) {
  const text = `${step.title} ${step.doneWhen} ${step.files.join(" ")}`
  return names.filter((name) => HEAVY.some(([tool, words]) => tool.test(name) && !words.test(text)))
}

export function apply(ctx) {
  const sandboxPolicy = ctx.shell.sandboxMode === undefined ? undefined : ctx.get("sandboxPolicy")
  const readOnly = (exec) => sandboxPolicy?.resolve({ session: exec.agent.session })?.mode === "read-only"
  const v2 = process.env.KRIYA_LOOP_V2 === "on" ? (exec) => ({ readOnly: readOnly(exec) }) : undefined
  const defensiveOn = process.env.KRIYA_DEFENSIVE === "on"
  // The defensive engine's checks are rungs of the strict loop, so it brings it
  const strictOn = defensiveOn || process.env.KRIYA_STRICT_LOOP === "on"
  const reconOn = process.env.KRIYA_RECON === "on"
  const jitOn = process.env.KRIYA_JIT_TOOLS === "on"
  // The strict loop stands on the guard: it needs signatures and snapshots
  const guarded = strictOn || process.env.KRIYA_LOOP_GUARD === "on"
  const strict = strictOn ? (exec) => ({ readOnly: readOnly(exec), defensive: defensiveOn }) : undefined
  // Each agent's folder, as its loop tools last resolved it (loop v2's state section)
  const folders = new WeakMap()
  const host = {
    v2,
    guard: guarded,
    strict,
    async cwd(exec) {
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      if (exec.agent) folders.set(exec.agent, cwd)
      return cwd
    },
    async run(command, exec, workdir) {
      const policy = sandboxPolicy?.resolve({ session: exec.agent.session })
      const spec = ctx.shell.resolve({
        command,
        workdir,
        timeoutMs: TIMEOUT_MS,
        dshEnv: ctx.shellEnv.collect(exec),
        ...(policy !== undefined && { sandboxPolicy: policy }),
        signal: exec.signal,
      })
      const result = await (await ctx.shell.execute(spec)).result()
      return {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        aborted: result.aborted,
        output: [result.stdout.text, result.stderr.text].filter(Boolean).join("\n"),
      }
    },
  }
  ctx.tools.register(verifyTool(host))

  // Fresh builders: DSH's in-process spawn provider, awaited by the caller
  // (no parent notice), one level deep only. Their ids are remembered so a
  // builder can't plan or run steps itself
  const builders = new Set()
  const limits = builderLimits()
  const guard = builderGuard(limits, { tokens: (agent) => { try { return ctx.get("tokenMeter")?.measure(agent.session).totalTokens } catch { return undefined } } })
  // A builder's mask, waiting for that builder (agent/created runs before its first step)
  const masks = new Map()
  const loopHost = {
    questions: () => ctx.get("userQuestions"),
    v2,
    strict,
    defensive: defensiveOn,
    limits,
    cwd: host.cwd,
    isBuilder: (exec) => builders.has(String(exec.agent?.id)),
    async spawn(exec, prompt, label, live) {
      const subagents = ctx.get("subagents")
      if (!subagents) throw new VerifyError("kriya_step needs DSH's subagents, which this profile doesn't load.")
      if (jitOn && live) {
        const step = readPlan(await host.cwd(exec), String(exec.agent.id))?.steps[live.n - 1]
        const deny = step ? toolsToHide(ctx.tools.schemas(exec.agent).map((s) => s.name), step) : []
        if (deny.length) masks.set(exec.agent, deny)
      }
      const activation = await subagents.startActivation({
        provider: "spawn",
        label,
        request: { prompt: [{ type: "text", text: prompt }], parent: exec.agent, signal: exec.signal, maxDepth: 1 },
        signal: exec.signal,
        delivery: "caller",
      })
      const id = String(activation.childId)
      builders.add(id)
      if (live) guard.start(id, live)
      masks.delete(exec.agent)
      const stop = () => activation.dispose().catch(() => {})
      exec.signal.addEventListener("abort", stop, { once: true })
      // The step limit is checked between steps; a tool call that never
      // returns is cut off a minute after the time limit
      const hard = setTimeout(() => {
        if (live) live.stopped ??= `${limits.maxMinutes} minutes`
        stop()
      }, (limits.maxMinutes + 1) * 60_000)
      hard.unref?.()
      try {
        return await activation.result
      } catch (error) {
        // Disposed by the hard limit (not by the person): still checked
        if (live?.stopped && !exec.signal.aborted) return { output: [], stopReason: "limit" }
        throw error
      } finally {
        clearTimeout(hard)
        guard.end(id)
        exec.signal.removeEventListener("abort", stop)
      }
    },
    verify: (exec, cwd, label) => verifyStep({ cwd, sessionId: String(exec.agent.id), step: label, run: (command) => host.run(command, exec, cwd), ...(v2 && { v2: v2(exec) }), ...(guarded && { guard: true }), ...(strict && { strict: strict(exec) }) }),
    // Loop guard: what a builder left, to tell an attempt that changed nothing; never in Read only
    ...((guarded || reconOn || jitOn) && {
      guardSteps: (exec, cwd) => ({
        ...(guarded && !readOnly(exec) && { snapshot: (label) => checkpoint(cwd, String(exec.agent.id), label).then((c) => c?.tree, () => undefined) }),
        ...(strictOn && !readOnly(exec) && { restore: (tree, label) => restoreTree(cwd, tree, label) }),
        briefing: async (step) => {
          const lines = []
          if (reconOn) {
            const using = [...new Set(step.files.flatMap((file) => { try { return importers(cwd, file) } catch { return [] } }))].slice(0, 20)
            if (using.length) lines.push(`Files that import what this step touches, which a change can break: ${using.join(", ")}`)
          }
          if (jitOn) {
            const skills = await ctx.get("skills")?.list({ cwd, scope: exec.agent }).catch(() => [])
            const names = rankSkills(`${step.title} ${step.doneWhen}`, (skills ?? []).filter((s) => s.invocation?.modelInvocable !== false)).slice(0, 2).map((r) => r.name)
            if (names.length) lines.push(`Skills likely to help this step: ${names.join(", ")}. Load the ones that fit with the skill tool.`)
          }
          return lines
        },
      }),
    }),
    // Loop v2: each attempt's files saved on the session's checkpoint ref, and restored from it; never in Read only
    ...(v2 && {
      steps: (exec, cwd) =>
        readOnly(exec)
          ? { rules: confirmedRules(cwd) }
          : {
              rules: confirmedRules(cwd),
              snapshot: async (label) => (await checkpoint(cwd, String(exec.agent.id), label))?.tree,
              restore: (tree, label) => restoreTree(cwd, tree, label),
            },
    }),
  }
  if (reconOn) {
    for (const tool of reconTools(host)) ctx.tools.register(tool)
    ctx.on("tools/post-execute", readHook())
  }
  if (strictOn) ctx.on("tools/post-execute", syntaxHook({ cwd: host.cwd }))
  if (jitOn)
    ctx.on("agent/created", ({ agent }) => {
      for (const [parent, deny] of masks) if (ctx.get("agents")?.isOwnedBy(agent.id, parent)) agent.ctx.tools.restrict({ deny })
    })
  ctx.tools.register(planTool(loopHost))
  ctx.tools.register(stepTool(loopHost))
  ctx.on(
    "tools/pre-execute",
    checkpointHook({
      cwd: host.cwd,
      readOnly,
      warn: (text) => ctx.logger("kriya-loop").warn(text),
    })
  )
  ctx.on("agent/pre-step", guard.preStep)
  ctx.on("tools/pre-execute", guard.preExecute)
  ctx.on("agent/turn-stopping", recheckHook({ cwd: host.cwd }))
  if (guarded) ctx.on("agent/turn-stopping", finishHook({ cwd: host.cwd, readOnly }))
  ctx.systemPrompt.section({ name: "tool:kriya_verify", order: ctx.systemPrompt.getSectionOrder("TOOL_BASH"), text: `${GUIDANCE}${v2 ? GUIDANCE_V2 : ""}${strictOn ? GUIDANCE_STRICT : ""}${defensiveOn ? GUIDANCE_DEFENSIVE : ""}${reconOn ? GUIDANCE_RECON : ""}` })
  // Long tasks: the plan's state per agent, in a late section that
  // compaction never condenses (after DSH's suffix, before the anchor's), so
  // the cached prefix stays the same. The folder is the one the agent's last
  // loop tool ran in; before a plan there is nothing to show, so a session
  // without a plan gets the same prompt as before. Loop v2 only until
  // 2026-11-04; on with the loop since (owner: a real run lost its plan after
  // compaction and goal rounds, and the Progress tab never moved)
  {
    ctx.systemPrompt.section({
      name: "kriya:loop-state",
      order: 10250,
      interpolate: false,
      text: ({ scope }) => {
        // The folder a loop tool last resolved, else the session's own (a resumed session before any loop tool)
        const cwd = scope && (folders.get(scope) ?? scope.session?.header?.cwd)
        if (!cwd) return ""
        try {
          return loopStateText(cwd, String(scope.id))
        } catch {
          return ""
        }
      },
    })
  }
}
