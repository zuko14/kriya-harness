import assert from "node:assert/strict"
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { finishHook, finishNotice } from "../plugins/loop/index.js"
import { builderPrompt, MAX_INTERRUPTIONS, nextStep, planStatus, runStep, savePlan } from "../src/loop.js"
import { SWITCHES, switchEnv } from "../src/modes.js"
import { confirmCheck, latestSession, readProgress, sessionReport, trajectory, verdict, verifyStep } from "../src/verify.js"
import { freshHome } from "./helpers.js"

// The loop guard (KRIYA_LOOP.md, Kriya repository's harness upgrade report):
// each case is a defect measured on the loop before it existed. Scripted
// builders and checks; the real-DSH drills are in loop-guard-run.test.js.

function project() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-guard-")))
  writeFileSync(join(dir, "package.json"), "{}")
  confirmCheck(dir, "npm test")
  return dir
}
const PLAN = { goal: "g", steps: ["one", "two", "three"].map((title) => ({ title, done_when: "it works" })) }
const noTree = async () => undefined
const checker = (dir, id, result, extra = { guard: true }) => (label) => verifyStep({ cwd: dir, sessionId: id, step: label, tree: noTree, run: async () => result, ...extra })
const FAIL = { exitCode: 1, timedOut: false, output: "AssertionError: UNIQUE-TEXT\n  at a.js:3" }
const counting = (reply = {}) => {
  const prompts = []
  return { prompts, spawn: async (prompt) => (prompts.push(prompt), { output: [], ...reply }) }
}

test("LG-VD-01: a pass doesn't verify a plan with steps still open, on or off the guard", async () => {
  freshHome()
  const dir = project()
  savePlan(dir, "s", PLAN)
  const pass = { exitCode: 0, timedOut: false, output: "" }
  const first = await runStep({ cwd: dir, sessionId: "s", n: 1, spawn: async () => ({ output: [] }), verify: checker(dir, "s", pass, {}) })
  assert.equal(first.verdict, "partial")
  await verifyStep({ cwd: dir, sessionId: "s", step: "2 two", tree: noTree, run: async () => pass })
  assert.equal(verdict(readProgress(dir, "s")).status, "partial")
  await verifyStep({ cwd: dir, sessionId: "s", step: "3 three", tree: noTree, run: async () => pass })
  assert.equal(verdict(readProgress(dir, "s")).status, "verified")
  // Without a plan nothing changes
  await verifyStep({ cwd: dir, sessionId: "t", step: "all", tree: noTree, run: async () => pass })
  assert.equal(verdict(readProgress(dir, "t")).status, "verified")
})

test("LG-ST-01: the same failure with no file changed stops after two builders, and is blocked for good", async () => {
  freshHome()
  const dir = project()
  savePlan(dir, "s", PLAN)
  const { prompts, spawn } = counting()
  const result = await runStep({ cwd: dir, sessionId: "s", n: 1, spawn, verify: checker(dir, "s", FAIL), guard: { snapshot: async () => "same" } })
  assert.equal(result.status, "blocked")
  assert.match(result.stalled, /no file changed/)
  assert.equal(prompts.length, 2)
  assert.equal(planStatus(dir, "s")[0].status, "blocked")
  assert.equal(verdict(readProgress(dir, "s")).status, "blocked")
  assert.equal(trajectory(readProgress(dir, "s")).stalled, 1)
})

test("LG-ST-02: files changed but the same failure: more builders, told the approach didn't work; a different failure goes on quietly", async () => {
  freshHome()
  const dir = project()
  savePlan(dir, "s", PLAN)
  let tree = 0
  const { prompts, spawn } = counting()
  const result = await runStep({ cwd: dir, sessionId: "s", n: 1, spawn, verify: checker(dir, "s", FAIL), guard: { snapshot: async () => `t${tree++}` } })
  assert.equal(result.status, "blocked")
  assert.equal(result.stalled, undefined)
  assert.equal(prompts.length, 4)
  assert.doesNotMatch(prompts[1], /same failure as the attempt before/)
  assert.match(prompts[2], /same failure as the attempt before/)
})

test("LG-ST-03: a check that can't run stops after two builders, even with files changed", async () => {
  freshHome()
  const dir = project()
  savePlan(dir, "s", PLAN)
  let tree = 0
  const { prompts, spawn } = counting()
  const missing = { exitCode: 127, timedOut: false, output: "sh: pytest: command not found" }
  const result = await runStep({ cwd: dir, sessionId: "s", n: 1, spawn, verify: checker(dir, "s", missing), guard: { snapshot: async () => `t${tree++}` } })
  assert.equal(result.status, "blocked")
  assert.match(result.stalled, /can't run/)
  assert.equal(prompts.length, 2)
})

test("LG-ST-05: a missing file or module may be the code's own bug: with files changed, every attempt is still spent", async () => {
  freshHome()
  const dir = project()
  savePlan(dir, "s", PLAN)
  let tree = 0
  const { prompts, spawn } = counting()
  const missing = { exitCode: 1, timedOut: false, output: "Error: ENOENT: no such file or directory, open 'data.json'" }
  const result = await runStep({ cwd: dir, sessionId: "s", n: 1, spawn, verify: checker(dir, "s", missing), guard: { snapshot: async () => `t${tree++}` } })
  assert.equal(result.stalled, undefined)
  assert.equal(prompts.length, 4)
})

test("LG-ST-04: off, four builders as before; outside a tracked folder (no tree) a no-change attempt isn't assumed", async () => {
  freshHome()
  const dir = project()
  savePlan(dir, "off", PLAN)
  const off = counting()
  assert.equal((await runStep({ cwd: dir, sessionId: "off", n: 1, spawn: off.spawn, verify: checker(dir, "off", FAIL, {}) })).status, "blocked")
  assert.equal(off.prompts.length, 4)
  savePlan(dir, "none", PLAN)
  const none = counting()
  await runStep({ cwd: dir, sessionId: "none", n: 1, spawn: none.spawn, verify: checker(dir, "none", FAIL), guard: {} })
  assert.equal(none.prompts.length, 4)
})

test("LG-IN-01: a builder that died on an error before changing a file isn't an attempt, up to the limit", async () => {
  freshHome()
  const dir = project()
  savePlan(dir, "s", PLAN)
  const { spawn } = counting({ stopReason: "error" })
  const guard = { snapshot: async () => "same" }
  let checks = 0
  const verify = (label) => (checks++, checker(dir, "s", FAIL)(label))
  for (let i = 0; i < MAX_INTERRUPTIONS; i++) assert.equal((await runStep({ cwd: dir, sessionId: "s", n: 1, spawn, verify, guard })).status, "interrupted")
  assert.equal(checks, 0)
  assert.equal(planStatus(dir, "s")[0].status, "not started")
  assert.equal(trajectory(readProgress(dir, "s")).interrupted, MAX_INTERRUPTIONS)
  // Past the limit the check runs, so an outage can't loop for ever
  assert.equal((await runStep({ cwd: dir, sessionId: "s", n: 1, spawn, verify, guard })).status, "blocked")
  assert.ok(checks > 0)
})

test("LG-IN-02: a builder that errored after changing files is still checked", async () => {
  freshHome()
  const dir = project()
  savePlan(dir, "s", PLAN)
  let tree = 0
  const pass = { exitCode: 0, timedOut: false, output: "" }
  const result = await runStep({ cwd: dir, sessionId: "s", n: 1, spawn: async () => ({ output: [], stopReason: "error" }), verify: checker(dir, "s", pass), guard: { snapshot: async () => `t${tree++}` } })
  assert.equal(result.status, "pass")
})

test("LG-RS-01: a step resumed after an interruption gives its builder the last recorded failure", async () => {
  freshHome()
  const dir = project()
  savePlan(dir, "s", PLAN)
  let tree = 0
  const guard = { snapshot: async () => `t${tree++}` }
  let calls = 0
  await runStep({ cwd: dir, sessionId: "s", n: 1, guard, verify: checker(dir, "s", FAIL), spawn: async () => { if (++calls === 2) throw new Error("killed"); return { output: [] } } }).catch(() => {})
  const seen = []
  await runStep({ cwd: dir, sessionId: "s", n: 1, guard, verify: checker(dir, "s", { exitCode: 0, timedOut: false, output: "" }), spawn: async (prompt) => (seen.push(prompt), { output: [] }) })
  assert.match(seen[0], /UNIQUE-TEXT/)
  assert.match(seen[0], /attempt 2 of 4/)
})

test("LG-RS-02: off, nothing of the output is stored in the records", async () => {
  freshHome()
  const dir = project()
  await verifyStep({ cwd: dir, sessionId: "s", step: "all", tree: noTree, run: async () => FAIL })
  const [run] = readProgress(dir, "s").runs
  assert.equal(run.excerpt, undefined)
  assert.equal(run.sig, undefined)
  assert.equal(run.kind, undefined)
})

test("LG-FN-01: nextStep finds what a stopping agent should go on to", () => {
  const row = (n, status, more = {}) => ({ n, title: `s${n}`, status, attempts: 0, ...more })
  assert.equal(nextStep(undefined), undefined)
  assert.equal(nextStep([row(1, "pass"), row(2, "not started")]).n, 2)
  assert.equal(nextStep([row(1, "fail"), row(2, "not started")]).n, 1)
  assert.equal(nextStep([row(1, "pass"), row(2, "pass")]), undefined)
  assert.equal(nextStep([row(1, "pass"), row(2, "not started", { building: {} })]), undefined)
  // v1: a block ends the plan; v2: only what needs it
  assert.equal(nextStep([row(1, "blocked"), row(2, "not started")]), undefined)
  assert.equal(nextStep([row(1, "blocked", { after: [] }), row(2, "skipped", { after: [1] }), row(3, "not started", { after: [] })]).n, 3)
})

test("LG-FN-02: the finish hook asks once per step reached, from the records", async () => {
  let rows = [{ n: 1, title: "a", status: "pass" }, { n: 2, title: "b", status: "not started" }, { n: 3, title: "c", status: "not started" }]
  const said = []
  const hook = finishHook({ cwd: async () => "/x", rows: () => rows, message: (text) => text })
  const agent = { id: "a", steer: (m) => said.push(m) }
  await hook({ agent, turn: 1 })
  await hook({ agent, turn: 1 })
  assert.deepEqual(said, [finishNotice(rows[1])])
  rows = rows.map((r) => (r.n === 2 ? { ...r, status: "pass" } : r))
  await hook({ agent, turn: 1 })
  assert.equal(said.length, 2)
  rows = rows.map((r) => ({ ...r, status: "pass" }))
  await hook({ agent, turn: 1 })
  assert.equal(said.length, 2)
  const quiet = finishHook({ cwd: async () => "/x", rows: () => [{ n: 1, title: "a", status: "not started" }], readOnly: () => true })
  await quiet({ agent, turn: 2 })
  assert.equal(said.length, 2)
})

test("LG-TR-01: the record's numbers and the report, for one session", async () => {
  freshHome()
  const dir = project()
  savePlan(dir, "s", PLAN)
  let exit = 1
  const verify = (label) => verifyStep({ cwd: dir, sessionId: "s", step: label, tree: noTree, guard: true, run: async () => ({ exitCode: exit, timedOut: false, output: "AssertionError: x" }) })
  await runStep({ cwd: dir, sessionId: "s", n: 1, verify, spawn: async (_p, _l, live) => { live.steps = 7; const was = exit; exit = 0; return { output: [], was } } })
  const t = trajectory(readProgress(dir, "s"))
  assert.deepEqual(
    { plans: t.plans, planned: t.planned, open: t.open, passed: t.passed, checkRuns: t.checkRuns, builders: t.builders, builderSteps: t.builderSteps },
    { plans: 1, planned: 3, open: 2, passed: 1, checkRuns: 1, builders: 1, builderSteps: 7 }
  )
  assert.equal(latestSession(dir), "s")
  const report = await sessionReport(dir)
  assert.equal(report.status, "partial")
  assert.equal(report.goal, "g")
  assert.equal(report.runs[0].exitCode, 0)
  assert.equal(report.trajectory.open, 2)
  assert.equal((await sessionReport(realpathSync(mkdtempSync(join(tmpdir(), "kriya-none-"))))).status, "not checked")
})

test("LG-TR-02: a recovered step counts; classes are counted", () => {
  const plan = { goal: "g", steps: [{ title: "one", doneWhen: "x", files: [] }] }
  const t = trajectory({ plan, runs: [{ step: "1 one", status: "fail", kind: "syntax" }, { step: "1 one", status: "pass" }] })
  assert.equal(t.recovered, 1)
  assert.deepEqual(t.classes, { syntax: 1 })
})

test("LG-SW-01: the switch defaults off and the flags set it", () => {
  assert.deepEqual(SWITCHES.find(([flag]) => flag === "loop-guard"), ["loop-guard", "KRIYA_LOOP_GUARD", false])
  const env = {}
  switchEnv([], env)
  assert.equal(env.KRIYA_LOOP_GUARD, "off")
  const args = ["--loop-guard"]
  switchEnv(args, env)
  assert.equal(env.KRIYA_LOOP_GUARD, "on")
  assert.deepEqual(args, [])
})

test("LG-PR-01: an unchanged builder prompt with the guard off", () => {
  const plan = { goal: "g", steps: [{ title: "one", doneWhen: "x", files: [] }] }
  assert.doesNotMatch(builderPrompt(plan, 1, { attempt: 1, command: "c", exitCode: 1, output: "o" }), /same failure/)
})
