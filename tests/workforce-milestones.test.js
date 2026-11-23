import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { milestonesTool, planTool, REPLACE, stepTool } from "../plugins/loop/index.js"
import { MAX_STEPS } from "../src/loop.js"
import { LOCK_STALE_MS, MAX_MILESTONES, milestonesFile, milestonesText, readMilestones, saveMilestones, updateMilestones } from "../src/milestones.js"
import { SWITCHES } from "../src/modes.js"
import { escalateAfterFromEnv, tierFor } from "../src/orchestra.js"
import { confirmCheck, MAX_ATTEMPTS, verifyStep } from "../src/verify.js"
import { freshHome } from "./helpers.js"

// Harness 2.0 W10 (Kriya-Tavi docs/kriya-harness/upgrade_2.0/ORCHESTRA.md §4,
// WD-12): the milestone ledger, kriya_milestones, the plan/step bindings and
// the resume section. Scripted builders and checks only: no model call.

function project() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-ms-")))
  mkdirSync(join(dir, ".git"))
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }))
  return dir
}
const MS = [
  { title: "Data model", done_when: "The schema migrates on a fresh database" },
  { title: "API", done_when: "Every endpoint answers its contract" },
  { title: "Screens", done_when: "Every screen renders its five states" },
]
const plan = (n = 2, tag = "") => ({ goal: `Build the part ${tag}`, steps: Array.from({ length: n }, (_, i) => ({ title: `Step ${tag}${i + 1}`, done_when: `Condition ${i + 1} holds` })) })
const signal = new AbortController().signal
const head = { agent: { id: "head-1" }, signal }

const PASS = { exitCode: 0, timedOut: false, output: "ok" }
const FAIL = { exitCode: 1, timedOut: false, output: "AssertionError: nope" }

/** A host for the loop's tools with milestones on; the confirmed check's exit codes come from `runs` in order */
function host(dir, runs = [PASS], extra = {}) {
  confirmCheck(dir, "npm test")
  let i = 0
  return {
    milestones: true,
    cwd: async () => dir,
    isBuilder: (exec) => exec.agent.id === "builder",
    spawn: async () => ({ output: [{ type: "text", text: "built" }], stopReason: "completed" }),
    verify: (exec, cwd, label) => verifyStep({ cwd, sessionId: String(exec.agent.id), step: label, tree: async () => undefined, run: async () => runs[Math.min(i++, runs.length - 1)] }),
    ...extra,
  }
}

test("WT-MS-01: the ledger holds 1 to 12 milestones, outside the project, written atomically", async () => {
  const home = freshHome()
  const dir = project()
  assert.equal(MAX_MILESTONES, 12)
  // WD-12: plans stay bounded
  assert.equal(MAX_STEPS, 7)
  assert.equal(MAX_ATTEMPTS, 4)
  const ledger = await saveMilestones(dir, MS)
  assert.deepEqual(ledger.milestones.map((m) => [m.title, m.status]), [["Data model", "todo"], ["API", "todo"], ["Screens", "todo"]])
  const file = milestonesFile(dir)
  assert.ok(file.startsWith(join(home, "progress")), file)
  assert.ok(!file.startsWith(dir))
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), readMilestones(dir))
  // No temp file or lock left behind
  assert.equal(existsSync(`${file}.lock`), false)
  const fresh = project()
  await assert.rejects(saveMilestones(fresh, []), /at least one/)
  await assert.rejects(saveMilestones(fresh, Array.from({ length: 13 }, (_, i) => ({ title: `M${i}`, done_when: "x" }))), /At most 12/)
  await assert.rejects(saveMilestones(fresh, [{ title: "A", done_when: "" }]), /needs a title and done_when/)
  await assert.rejects(saveMilestones(fresh, [MS[0], { ...MS[0] }]), /same title/)
  await assert.rejects(saveMilestones(fresh, [{ ...MS[0], roles: ["wizard"] }], { roles: ["backend", "database"] }), /role Kriya doesn't have/)
  assert.equal(readMilestones(fresh), undefined)
})

test("WT-MS-02: a second writer waits, then is told; a stale lock is taken over", async () => {
  freshHome()
  const dir = project()
  await saveMilestones(dir, MS.slice(0, 1))
  const lock = `${milestonesFile(dir)}.lock`
  writeFileSync(lock, "")
  await assert.rejects(updateMilestones(dir, (l) => l, { waitMs: 100 }), /Another session is updating milestones/)
  // A crashed session's lock, older than the stale timeout
  const old = (Date.now() - LOCK_STALE_MS - 1000) / 1000
  utimesSync(lock, old, old)
  const after = await updateMilestones(dir, (l) => ({ ...l, touched: true }), { waitMs: 100 })
  assert.equal(after.touched, true)
  assert.equal(existsSync(lock), false)
})

test("WT-MS-03: kriya_milestones is the head's, once per project; only the person can replace open milestones", async () => {
  freshHome()
  const dir = project()
  let asked = 0
  let choice
  const h = host(dir, undefined, { questions: () => ({ ask: async () => (asked++, choice && { answers: [{ id: "kriya-replan", selected: [choice] }] }) }) })
  const tool = milestonesTool(h)
  await assert.rejects(tool.execute({ milestones: MS }, { agent: { id: "builder" }, signal }), /builder doesn't set milestones/)
  assert.equal((await tool.execute({ milestones: MS }, head)).milestones.length, 3)
  await assert.rejects(tool.execute({ milestones: MS.slice(0, 1) }, head), /already has milestones in progress/)
  // The model asking to replan isn't enough: the harness asks the person
  choice = "Not now"
  await assert.rejects(tool.execute({ milestones: MS.slice(0, 1), replan: true }, head), /kept the current milestones/)
  // No UI (kriya run): never replaced
  await assert.rejects(milestonesTool(host(dir)).execute({ milestones: MS.slice(0, 1), replan: true }, head), /kept the current milestones/)
  choice = REPLACE
  const replaced = await tool.execute({ milestones: MS.slice(0, 1), replan: true }, head)
  assert.deepEqual(replaced.milestones.map((m) => m.title), ["Data model"])
  assert.equal(asked, 2)
  assert.equal(readMilestones(dir).replaced, 1)
})

test("WT-MS-04: a plan is for the current milestone; the next starts only when every step passed; blocked stops", async () => {
  freshHome()
  const dir = project()
  await saveMilestones(dir, MS.slice(0, 2))
  const h = host(dir, [PASS, PASS])
  await planTool(h).execute(plan(2, "a"), head)
  assert.equal(readMilestones(dir).milestones[0].status, "active")
  assert.equal(readMilestones(dir).milestones[0].plan.sessionId, "head-1")
  await stepTool(h).execute({ step: 1 }, head)
  // One step passed is not the milestone done
  assert.deepEqual(readMilestones(dir).milestones.map((m) => m.status), ["active", "todo"])
  assert.match(milestonesText(dir), /Last verdicts: 1\. Step a1: pass; 2\. Step a2: not started/)
  await stepTool(h).execute({ step: 2 }, head)
  const done = readMilestones(dir).milestones[0]
  assert.equal(done.status, "done")
  assert.ok(done.doneAt)
  // The next plan belongs to milestone 2; this time every attempt fails
  const blocking = host(dir, [FAIL])
  await planTool(blocking).execute(plan(1, "b"), head)
  assert.deepEqual(readMilestones(dir).milestones.map((m) => m.status), ["done", "active"])
  await stepTool(blocking).execute({ step: 1 }, head)
  assert.equal(readMilestones(dir).milestones[1].status, "blocked")
  await assert.rejects(planTool(blocking).execute(plan(1, "c"), head), /Milestone 2 \(API\) is blocked\. Stop and tell the person/)
  // A plan in another session can't mark this milestone done
  assert.equal(readMilestones(dir).milestones[1].plan.sessionId, "head-1")
})

test("WT-MS-05: a new session is told where the long work stands; without milestones, nothing", async () => {
  freshHome()
  const dir = project()
  assert.equal(milestonesText(dir), "")
  await saveMilestones(dir, MS)
  assert.match(milestonesText(dir), /Current: milestone 1, Data model\. Done when: The schema migrates on a fresh database\.\nPlan it with kriya_plan/)
  const h = host(dir)
  await planTool(h).execute(plan(1), head)
  await stepTool(h).execute({ step: 1 }, head)
  // A resumed session (another id) reads the same ledger: nothing is replayed
  const text = milestonesText(dir)
  assert.match(text, /1\. Data model: done\n2\. API: todo\n3\. Screens: todo/)
  assert.match(text, /Current: milestone 2, API/)
})

test("WT-MS-06: off by default; without the switch the plan and step tools never touch a ledger", async () => {
  assert.deepEqual(SWITCHES.find(([name]) => name === "milestones"), ["milestones", "KRIYA_MILESTONES", false])
  freshHome()
  const dir = project()
  await saveMilestones(dir, MS.slice(0, 1))
  const before = readFileSync(milestonesFile(dir), "utf8")
  const off = { ...host(dir), milestones: undefined }
  await planTool(off).execute(plan(1), head)
  await stepTool(off).execute({ step: 1 }, head)
  assert.equal(readFileSync(milestonesFile(dir), "utf8"), before)
  // A blocked or finished ledger doesn't refuse a plan when the switch is off
  await updateMilestones(dir, (l) => ({ ...l, milestones: l.milestones.map((m) => ({ ...m, status: "blocked" })) }))
  await planTool(off).execute(plan(1, "x"), { agent: { id: "head-2" }, signal })
})

test("WT-EV-02 (client): a profile's escalateAfter reaches the orchestra through KRIYA_ESCALATE_AFTER, bounded 0–4", () => {
  assert.equal(escalateAfterFromEnv({}), undefined)
  assert.equal(escalateAfterFromEnv({ KRIYA_ESCALATE_AFTER: "0" }), 0)
  assert.equal(escalateAfterFromEnv({ KRIYA_ESCALATE_AFTER: "4" }), 4)
  for (const bad of ["5", "-1", "2.5", "two", ""]) assert.equal(escalateAfterFromEnv({ KRIYA_ESCALATE_AFTER: bad }), undefined, bad)
  const orchestra = { head: "escalation", worker: "budget" }
  // With 1, the second attempt is the head's; with the default 2, the third
  assert.equal(tierFor({ orchestra, attempt: 2, escalateAfter: 1 }), "escalation")
  assert.equal(tierFor({ orchestra, attempt: 2 }), "budget")
})
