import assert from "node:assert/strict"
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { ADVICE_LIMIT, ADVISOR_TOOLS, advisePrompt } from "../plugins/loop/index.js"
import { launchEnv, planTiers } from "../src/launch.js"
import { runStep, savePlan } from "../src/loop.js"
import { SWITCHES, switchEnv } from "../src/modes.js"
import { orchestraFromEnv, tierFor } from "../src/orchestra.js"
import { confirmCheck, readProgress, verifyStep } from "../src/verify.js"
import { freshHome } from "./helpers.js"

// Harness 2.0 W2, client part (Kriya-Tavi docs/kriya-harness/upgrade_2.0/
// ORCHESTRA.md, ARCHITECTURE.md §5): head and worker levels, escalation
// inside the 4 attempts, the loop guard's stall yielding once to the head,
// and the advisor's bounds. Scripted builders and checks; the real-DSH runs
// are in workforce-orchestra-run.test.js. WT-ORC-04…09.

const O = { head: "escalation", worker: "budget" }

test("WT-ORC-04: the switch defaults off; levels come only from Kriya's offer, never the shell", async () => {
  assert.deepEqual(SWITCHES.find(([name]) => name === "orchestra"), ["orchestra", "KRIYA_ORCHESTRA", false])
  const env = {}
  switchEnv([], env)
  assert.equal(env.KRIYA_ORCHESTRA, "off")
  const shell = { KRIYA_ORCHESTRA_HEAD: "escalation", KRIYA_ORCHESTRA_WORKER: "budget" }
  const plain = launchEnv(null, shell)
  assert.equal(plain.KRIYA_ORCHESTRA_HEAD, undefined)
  assert.equal(plain.KRIYA_ORCHESTRA_WORKER, undefined)
  const offered = launchEnv(null, {}, "ask", "escalation", ["balanced", "budget", "escalation"], {}, {}, [], O)
  assert.equal(offered.KRIYA_ORCHESTRA_HEAD, "escalation")
  assert.equal(offered.KRIYA_ORCHESTRA_WORKER, "budget")
  assert.equal(offered.KRIYA_START_TIER, "escalation")
  // Without the ninth argument, launchEnv is as before
  assert.deepEqual(launchEnv(null, {}), launchEnv(null, {}, "ask", "balanced", ["balanced", "budget", "escalation"], {}, {}, []))

  const answer = (orchestra, ids = ["budget", "balanced", "escalation"]) => async () => ({ data: ids.map((id) => ({ id })), ...(orchestra && { orchestra }) })
  const device = { url: "http://x", token: "t" }
  assert.deepEqual((await planTiers(device, answer(O))).orchestra, O)
  assert.equal((await planTiers(device, answer(undefined))).orchestra, undefined)
  assert.equal((await planTiers(device, answer({ head: "budget", worker: "budget" }))).orchestra, undefined)
  assert.equal((await planTiers(device, answer(O, ["budget", "balanced"]))).orchestra, undefined)
  assert.equal((await planTiers(device, answer({ head: "openai/gpt-5", worker: "budget" }))).orchestra, undefined)
})

test("WT-ORC-05: orchestraFromEnv needs the switch, the loop, both levels allowed and different", () => {
  const base = { KRIYA_ORCHESTRA: "on", KRIYA_LOOP: "on", KRIYA_ALLOWED_TIERS: "balanced,budget,escalation", KRIYA_ORCHESTRA_HEAD: "escalation", KRIYA_ORCHESTRA_WORKER: "budget" }
  assert.deepEqual(orchestraFromEnv(base), O)
  assert.equal(orchestraFromEnv({ ...base, KRIYA_ORCHESTRA: "off" }), undefined)
  assert.equal(orchestraFromEnv({ ...base, KRIYA_LOOP: "off" }), undefined)
  assert.equal(orchestraFromEnv({ ...base, KRIYA_ALLOWED_TIERS: "balanced,budget" }), undefined)
  assert.equal(orchestraFromEnv({ ...base, KRIYA_ORCHESTRA_WORKER: "escalation" }), undefined)
  assert.equal(orchestraFromEnv({ ...base, KRIYA_ORCHESTRA_HEAD: undefined }), undefined)
})

test("WT-ORC-06: tierFor: worker first, head after escalateAfter, when forced or stuck; never after an environment failure", () => {
  const at = (attempt, extra = {}) => tierFor({ orchestra: O, attempt, ...extra })
  assert.deepEqual([1, 2, 3, 4].map((a) => at(a)), ["budget", "budget", "escalation", "escalation"])
  assert.equal(at(4, { previous: { kind: "environment" } }), "budget")
  assert.equal(at(2, { force: true }), "escalation")
  assert.equal(at(3, { escalateAfter: 3, previous: { sig: "s" }, earlier: { sig: "s" } }), "escalation")
  assert.equal(at(3, { escalateAfter: 3, previous: { sig: "s" }, earlier: { sig: "t" } }), "budget")
  assert.equal(at(1, { role: "architect" }), "escalation")
  assert.equal(at(1, { escalateAfter: 0 }), "escalation")
  assert.deepEqual([1, 2, 3, 4].map((a) => at(a, { escalateAfter: 4 })), ["budget", "budget", "budget", "budget"])
  assert.equal(at(3, { escalateAfter: 99 }), "escalation")
  assert.equal(tierFor({ attempt: 3 }), undefined)
})

function project() {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-orc-")))
  writeFileSync(join(dir, "package.json"), "{}")
  confirmCheck(dir, "npm test")
  savePlan(dir, "s", { goal: "g", steps: [{ title: "one", done_when: "it works" }] })
  return dir
}
const FAIL = { exitCode: 1, timedOut: false, output: "AssertionError: SAME\n  at a.js:3" }
const verifier = (dir, results, extra = {}) => {
  let i = 0
  return (label) => verifyStep({ cwd: dir, sessionId: "s", step: label, tree: async () => undefined, run: async () => results[Math.min(i++, results.length - 1)], ...extra })
}
const orchestra = { head: O.head, tier: (input) => tierFor({ orchestra: O, ...input }) }

test("WT-ORC-07: every attempt's builder gets its level; the ledger records it; the bound stays 4", async () => {
  const dir = project()
  const tiers = []
  const result = await runStep({ cwd: dir, sessionId: "s", n: 1, spawn: async (_p, _l, live) => (tiers.push(live.tier), { output: [] }), verify: verifier(dir, [FAIL]), orchestra })
  assert.equal(result.status, "blocked")
  assert.deepEqual(tiers, ["budget", "budget", "escalation", "escalation"])
  assert.deepEqual((readProgress(dir, "s").builders ?? []).map((b) => b.tier), tiers)
})

test("WT-ORC-08: without the orchestra, builders get no level and the record has none (as before)", async () => {
  const dir = project()
  const lives = []
  await runStep({ cwd: dir, sessionId: "s", n: 1, spawn: async (_p, _l, live) => (lives.push({ ...live }), { output: [] }), verify: verifier(dir, [FAIL]) })
  assert.ok(lives.every((l) => !("tier" in l)))
  assert.ok((readProgress(dir, "s").builders ?? []).every((b) => !("tier" in b)))
})

test("WT-ORC-09: a worker repeating itself untouched gets one head attempt; a head doing the same stalls as today; off, the guard is unchanged", async () => {
  const guard = { snapshot: async () => "same-tree" }
  // On: the worker stalls at attempt 2, the head takes attempt 3, repeats untouched, and the step stalls
  let dir = project()
  const tiers = []
  const on = await runStep({ cwd: dir, sessionId: "s", n: 1, spawn: async (_p, _l, live) => (tiers.push(live.tier), { output: [] }), verify: verifier(dir, [FAIL], { guard: true }), guard, orchestra })
  assert.equal(on.status, "blocked")
  assert.equal(on.stalled, "the same failure again with no file changed")
  assert.deepEqual(tiers, ["budget", "budget", "escalation"])
  // Off: stalls at attempt 2, as before
  dir = project()
  let builds = 0
  const off = await runStep({ cwd: dir, sessionId: "s", n: 1, spawn: async () => (builds++, { output: [] }), verify: verifier(dir, [FAIL], { guard: true }), guard })
  assert.equal(off.status, "blocked")
  assert.equal(off.stalled, "the same failure again with no file changed")
  assert.equal(builds, 2)
  // A check that can't run (exit 127) never escalates
  dir = project()
  const can = []
  const cantRun = { exitCode: 127, timedOut: false, output: "sh: jest: command not found" }
  const r = await runStep({ cwd: dir, sessionId: "s", n: 1, spawn: async (_p, _l, live) => (can.push(live.tier), { output: [] }), verify: verifier(dir, [cantRun], { guard: true }), guard: { snapshot: async () => `t${can.length}` }, orchestra })
  assert.equal(r.stalled, "the check can't run on this machine")
  assert.ok(!can.slice(0, 2).includes("escalation"), can.join(","))
})

test("WT-ORC-10: the advisor reads only, is bounded, and is told it changes nothing", () => {
  assert.equal(ADVICE_LIMIT, 2)
  assert.deepEqual([...ADVISOR_TOOLS].sort(), ["glob", "grep", "read", "read_image"])
  for (const writer of ["write", "edit", "bash", "pwsh", "run_code", "workflow", "kriya_step", "kriya_plan", "kriya_advise", "subagent"]) assert.ok(!ADVISOR_TOOLS.has(writer), writer)
  const prompt = advisePrompt({ goal: "G", steps: [{ title: "T", doneWhen: "D" }] }, 1, "Why does it fail?")
  assert.match(prompt, /you change nothing and run nothing/)
  assert.match(prompt, /Why does it fail\?/)
  assert.match(prompt, /1\. T/)
})
