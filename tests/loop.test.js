import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { planTool, stepTool } from "../plugins/loop/index.js"
import { builderPrompt, MAX_PLANS, MAX_STEPS, planStatus, readPlan, runStep, savePlan, stepLabel, validatePlan } from "../src/loop.js"
import { confirmCheck, MAX_ATTEMPTS, progressFiles, VerifyError } from "../src/verify.js"
import { freshHome } from "./helpers.js"

// H14c (src/loop.js, plugins/loop): plans of at most 7 steps, a fresh
// builder per step, the harness's check after each build, a new builder
// with the failure until the step passes or is blocked. Code decides.

function project() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-loop-unit-")))
  mkdirSync(join(dir, ".git"))
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }))
  return dir
}
const plan = (n = 2) => ({
  goal: "Parse empty input without crashing",
  steps: Array.from({ length: n }, (_, i) => ({ title: `Step title ${i + 1}`, done_when: `Condition ${i + 1} holds`, files: [`src/f${i}.js`] })),
})

/** Scripted builders and checks: verify answers from `checks` in order */
function harness(dir, checks) {
  const prompts = []
  const labels = []
  let i = 0
  return {
    prompts,
    labels,
    spawn: async (prompt) => {
      prompts.push(prompt)
      return { output: [{ type: "text", text: `built attempt ${prompts.length}` }], stopReason: "completed" }
    },
    verify: async (label) => {
      labels.push(label)
      const next = checks[Math.min(i++, checks.length - 1)]
      return next
    },
  }
}
const fail = (attempts, output = "AssertionError: expected [] got undefined") => ({ status: "fail", attempts, command: "npm test", exitCode: 1, timedOut: false, output })
const pass = (attempts) => ({ status: "pass", attempts, command: "npm test", exitCode: 0, output: "", verdict: "failed" })

test(`a plan has a goal and 1 to ${MAX_STEPS} distinct steps, each with a title and done_when`, () => {
  assert.equal(validatePlan(plan(MAX_STEPS)).steps.length, MAX_STEPS)
  assert.throws(() => validatePlan(plan(MAX_STEPS + 1)), /at most 7 steps/)
  assert.throws(() => validatePlan({ goal: "", steps: plan().steps }), /needs a goal/)
  assert.throws(() => validatePlan({ goal: "x", steps: [] }), /at least one step/)
  assert.throws(() => validatePlan({ goal: "x", steps: [{ title: "a" }] }), /done_when/)
  assert.throws(() => validatePlan({ goal: "x", steps: [{ title: "A", done_when: "y" }, { title: "a", done_when: "z" }] }), /same title/)
  const p = validatePlan({ goal: "  g  ", steps: [{ title: "t\n x", done_when: "d", files: ["a", "", 3] }] })
  assert.deepEqual(p, { goal: "g", steps: [{ title: "t x", doneWhen: "d", files: ["a"] }] })
})

test("a builder sees the goal, the plan, its one step and, on a retry, the failing output", () => {
  const p = validatePlan(plan(3))
  const first = builderPrompt(p, 2)
  assert.match(first, /Goal of the task: Parse empty input/)
  assert.match(first, /2\. Step title 2 {3}<- your step/)
  assert.match(first, /It is done when: Condition 2 holds/)
  assert.match(first, /Files it is expected to touch: src\/f1\.js/)
  assert.match(first, /Don't call kriya_plan or kriya_step/)
  assert.doesNotMatch(first, /previous attempt/)
  const retry = builderPrompt(p, 2, { attempt: 1, command: "npm test", exitCode: 1, output: "TypeError at parse.js:12" })
  assert.match(retry, new RegExp(`attempt 2 of ${MAX_ATTEMPTS}`))
  assert.match(retry, /TypeError at parse\.js:12/)
})

test("a step that fails is rebuilt by a fresh builder with the error, then passes", async () => {
  freshHome()
  const dir = project()
  savePlan(dir, "s1", plan())
  const h = harness(dir, [fail(1), pass(2)])
  const result = await runStep({ cwd: dir, sessionId: "s1", n: 1, spawn: h.spawn, verify: h.verify })
  assert.equal(result.status, "pass")
  assert.equal(result.attempts, 2)
  assert.equal(h.prompts.length, 2)
  assert.doesNotMatch(h.prompts[0], /previous attempt/)
  assert.match(h.prompts[1], /AssertionError: expected \[\] got undefined/)
  assert.deepEqual(h.labels, [stepLabel(readPlan(dir, "s1"), 1), stepLabel(readPlan(dir, "s1"), 1)])
  assert.equal(result.builders.length, 2)
})

test(`a step is blocked after ${MAX_ATTEMPTS} failed checks, with no fifth builder`, async () => {
  freshHome()
  const dir = project()
  savePlan(dir, "s1", plan())
  const h = harness(dir, [fail(1), fail(2), fail(3), { ...fail(4), status: "blocked" }])
  const result = await runStep({ cwd: dir, sessionId: "s1", n: 1, spawn: h.spawn, verify: h.verify })
  assert.equal(result.status, "blocked")
  assert.equal(h.prompts.length, MAX_ATTEMPTS)
  assert.match(result.output, /AssertionError/)
})

test("steps run in order, need a plan, and a missing check ends the step 'not checked'", async () => {
  freshHome()
  const dir = project()
  const h = harness(dir, [pass(1)])
  await assert.rejects(runStep({ cwd: dir, sessionId: "s1", n: 1, spawn: h.spawn, verify: h.verify }), /no plan yet/)
  savePlan(dir, "s1", plan())
  await assert.rejects(runStep({ cwd: dir, sessionId: "s1", n: 2, spawn: h.spawn, verify: h.verify }), /Steps run in order: step 1/)
  await assert.rejects(runStep({ cwd: dir, sessionId: "s1", n: 9, spawn: h.spawn, verify: h.verify }), /steps 1 to 2/)
  const none = harness(dir, [{ status: "not configured", suggestions: [{ command: "npm test" }] }])
  const result = await runStep({ cwd: dir, sessionId: "s1", n: 1, spawn: none.spawn, verify: none.verify })
  assert.equal(result.status, "not checked")
  assert.equal(none.prompts.length, 1)
})

test("with the real verify step: progress shows the plan and each step's runs", async () => {
  freshHome()
  const dir = project()
  confirmCheck(dir, "npm test")
  savePlan(dir, "s1", plan(2))
  const { verifyStep } = await import("../src/verify.js")
  const results = [{ exitCode: 1, timedOut: false, output: "boom" }, { exitCode: 0, timedOut: false, output: "" }]
  const verify = (label) => verifyStep({ cwd: dir, sessionId: "s1", step: label, run: async () => results.shift() ?? { exitCode: 0, timedOut: false, output: "" } })
  const spawn = async () => ({ output: [] })
  assert.equal((await runStep({ cwd: dir, sessionId: "s1", n: 1, spawn, verify })).status, "pass")
  assert.equal((await runStep({ cwd: dir, sessionId: "s1", n: 2, spawn, verify })).status, "pass")
  assert.deepEqual(planStatus(dir, "s1").map((s) => [s.n, s.status, s.attempts]), [[1, "pass", 2], [2, "pass", 1]])
  const md = readFileSync(progressFiles(dir, "s1").md, "utf8")
  assert.match(md, /Goal: Parse empty input/)
  assert.match(md, /Verdict: verified/)
  // A passed step isn't rebuilt
  const again = await runStep({ cwd: dir, sessionId: "s1", n: 1, spawn: async () => assert.fail("rebuilt"), verify })
  assert.equal(again.status, "pass")
})

test(`a session makes at most ${MAX_PLANS} plans, so re-planning can't undo 'blocked' forever`, () => {
  freshHome()
  const dir = project()
  for (let i = 0; i < MAX_PLANS; i++) savePlan(dir, "s1", plan())
  assert.throws(() => savePlan(dir, "s1", plan()), VerifyError)
})

test("the tools: builders can't plan or run steps; kriya_step takes only a step number", async () => {
  freshHome()
  const dir = project()
  const host = {
    cwd: async () => dir,
    isBuilder: (exec) => exec.agent.id === "child",
    spawn: async () => ({ output: [] }),
    verify: async () => pass(1),
  }
  const p = planTool(host)
  const s = stepTool(host)
  const signal = new AbortController().signal
  await assert.rejects(p.execute(plan(), { agent: { id: "child" }, signal }), /builder doesn't plan/)
  await assert.rejects(s.execute({ step: 1 }, { agent: { id: "child" }, signal }), /builder doesn't run steps/)
  const recorded = await p.execute(plan(), { agent: { id: "parent" }, signal })
  assert.equal(recorded.steps.length, 2)
  assert.equal((await s.execute({ step: 1 }, { agent: { id: "parent" }, signal })).status, "pass")
  assert.doesNotMatch(JSON.stringify(s), /"command"/)
})
