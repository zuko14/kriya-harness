import { createUserMessage } from "@deepseek-ai/dsh-llm"
import { defineTool } from "@deepseek-ai/dsh-tools"

import { checkpoint, restoreTree } from "../../src/checkpoints.js"
import { MAX_STEPS, planStatus, runStep, savePlan } from "../../src/loop.js"
import { confirmedRules } from "../../src/rules.js"
import { currentVerdict, VerifyError, verifyStep } from "../../src/verify.js"

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
      const result = await verifyStep({ cwd, sessionId: String(exec.agent.id), step: args.step, run: (command) => host.run(command, exec, cwd), ...(host.v2 && { v2: host.v2(exec) }) })
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
    },
    output: {
      schema: { type: "object", additionalProperties: true, properties: { steps: { type: "array", required: true, items: { type: "object", additionalProperties: true, properties: {} } } } },
      render: (_args, value) => [{ type: "text", text: `Plan recorded (${value.steps.length} step${value.steps.length === 1 ? "" : "s"}):\n${renderStatus(value.steps)}\nRun step 1 with kriya_step.` }],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new VerifyError("kriya_plan needs a session.")
      if (host.isBuilder(exec)) throw new VerifyError("A step's builder doesn't plan; build your step and stop.")
      const cwd = await host.cwd(exec)
      savePlan(cwd, String(exec.agent.id), args, undefined, { v2: Boolean(host.v2) })
      return { steps: planStatus(cwd, String(exec.agent.id)) }
    },
    presentCall: (args) => ({ card: "generic", title: "Plan", kind: "think", rawInput: typeof args.goal === "string" ? args.goal : "" }),
  })
}

function presentStep(value) {
  const head = `Step ${value.step} (${value.title}): ${value.status}${value.attempts ? ` after ${value.attempts} run${value.attempts === 1 ? "" : "s"}` : ""}.`
  const lines = [head]
  if (value.status === "not checked")
    lines.push("No check is confirmed for this project, so the step was built but not checked. Tell the person; they can confirm one with `kriya verify use <number>`.")
  if (value.status === "blocked") lines.push(`\`${value.command}\` kept failing. Stop and tell the person what failed:`, value.output)
  if (value.status === "pass" && value.verdict) lines.push(`Session verdict so far: ${value.verdict}.`)
  const aside = value.builders?.filter((b) => b.setAside).length
  if (aside) lines.push(`${aside} attempt${aside === 1 ? " was" : "s were"} set aside for failing further from passing than an earlier one (kept in kriya undo --list).`)
  if (value.note) lines.push(value.note)
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
      return runStep({
        cwd,
        sessionId: String(exec.agent.id),
        n: Math.trunc(Number(args.step)),
        spawn: (prompt, label) => host.spawn(exec, prompt, label),
        verify: (label) => host.verify(exec, cwd, label),
        ...(host.steps && { v2: host.steps(exec, cwd) }),
      })
    },
    presentCall: (args) => ({ card: "generic", title: "Build and check a step", kind: "execute", rawInput: `step ${args.step}` }),
  })
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

export function apply(ctx) {
  const sandboxPolicy = ctx.shell.sandboxMode === undefined ? undefined : ctx.get("sandboxPolicy")
  const readOnly = (exec) => sandboxPolicy?.resolve({ session: exec.agent.session })?.mode === "read-only"
  const v2 = process.env.KRIYA_LOOP_V2 === "on" ? (exec) => ({ readOnly: readOnly(exec) }) : undefined
  const host = {
    v2,
    cwd: (exec) => ctx.workingDirectory.ensure(exec.agent, exec.signal),
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
  const loopHost = {
    v2,
    cwd: host.cwd,
    isBuilder: (exec) => builders.has(String(exec.agent?.id)),
    async spawn(exec, prompt, label) {
      const subagents = ctx.get("subagents")
      if (!subagents) throw new VerifyError("kriya_step needs DSH's subagents, which this profile doesn't load.")
      const activation = await subagents.startActivation({
        provider: "spawn",
        label,
        request: { prompt: [{ type: "text", text: prompt }], parent: exec.agent, signal: exec.signal, maxDepth: 1 },
        signal: exec.signal,
        delivery: "caller",
      })
      builders.add(String(activation.childId))
      const stop = () => activation.dispose().catch(() => {})
      exec.signal.addEventListener("abort", stop, { once: true })
      try {
        return await activation.result
      } finally {
        exec.signal.removeEventListener("abort", stop)
      }
    },
    verify: (exec, cwd, label) => verifyStep({ cwd, sessionId: String(exec.agent.id), step: label, run: (command) => host.run(command, exec, cwd), ...(v2 && { v2: v2(exec) }) }),
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
  ctx.on("agent/turn-stopping", recheckHook({ cwd: host.cwd }))
  ctx.systemPrompt.section({ name: "tool:kriya_verify", order: ctx.systemPrompt.getSectionOrder("TOOL_BASH"), text: v2 ? GUIDANCE + GUIDANCE_V2 : GUIDANCE })
}
