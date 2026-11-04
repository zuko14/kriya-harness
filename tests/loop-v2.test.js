import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { GUIDANCE, GUIDANCE_V2, planTool, verifyTool } from "../plugins/loop/index.js"
import { checkpoint, listCheckpoints, restoreTree } from "../src/checkpoints.js"
import { classify, excerpt, RANK } from "../src/failure.js"
import { builderPrompt, planStatus, runStep, savePlan, stepLabel, validatePlan } from "../src/loop.js"
import { switchEnv } from "../src/modes.js"
import { confirmedRules, confirmRule, dismissRule, listRules, noteFailure } from "../src/rules.js"
import { confirmCheck, readProgress, verifyStep } from "../src/verify.js"
import { freshHome } from "./helpers.js"

// Kriya loop v2 (KRIYA_LOOP_V2.md in the Kriya repository): KV2-* checks.

function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-v2-")))
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString()
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "T")
  writeFileSync(join(dir, "sum.js"), "module.exports = (a, b) => a - b\n")
  mkdirSync(join(dir, "test"))
  writeFileSync(join(dir, "test", "sum.test.js"), 'const assert = require("node:assert")\nassert.strictEqual(require("../sum.js")(2, 2), 4)\n')
  git("add", ".")
  git("commit", "-qm", "base")
  return { dir, git }
}
// The check, run for real in the fixture
const runIn = (dir) => async (command) => {
  const r = spawnSync("sh", ["-c", command], { cwd: dir, encoding: "utf8" })
  return { exitCode: r.status, timedOut: false, output: `${r.stdout}${r.stderr}` }
}

/* ─────────────────────────── failure classes ─────────────────────────── */

test("KV2-FC-01: failures are classified by code from real runner output", () => {
  const cases = [
    [{ output: "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'." , exitCode: 2 }, "type"],
    [{ output: "src/a.ts(1,9): error TS1005: ';' expected.", exitCode: 2 }, "syntax"],
    [{ output: "/p/a.js:2\n  return = 1\n         ^\n\nSyntaxError: Unexpected token '='", exitCode: 1 }, "syntax"],
    [{ output: "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n0 !== 4\n", exitCode: 1 }, "assertion"],
    [{ output: "____ test_sum ____\n    def test_sum():\n>       assert add(2, 2) == 4\nE       assert 0 == 4\n", exitCode: 1 }, "assertion"],
    [{ output: "--- FAIL: TestSum (0.00s)\n    sum_test.go:9: got 0, want 4\nFAIL", exitCode: 1 }, "assertion"],
    [{ output: "sh: jest: command not found", exitCode: 127 }, "environment"],
    [{ output: "npm error Missing script: \"test\"", exitCode: 1 }, "environment"],
    [{ output: "npm ERR! missing script: test", exitCode: 1 }, "environment"],
    [{ output: "ModuleNotFoundError: No module named 'requests'", exitCode: 1 }, "environment"],
    [{ output: "TypeError: sum is not a function\n    at /p/test/sum.test.js:2:3", exitCode: 1 }, "type"],
    [{ output: "", exitCode: null, timedOut: true }, "timeout"],
    [{ output: "something odd happened", exitCode: 3 }, "unknown"],
  ]
  for (const [run, kind] of cases) assert.equal(classify(run).kind, kind, run.output)
  // The ranks order how far from passing each class is
  assert.ok(RANK.syntax < RANK.type && RANK.type < RANK.assertion && RANK.assertion < RANK.pass)
})

test("KV2-FC-02: the excerpt keeps the failing lines and their places, not the noise", () => {
  const noise = Array.from({ length: 400 }, (_, i) => `ok ${i + 1} - passes case ${i + 1}`).join("\n")
  const output = `${noise}\nnot ok 401 - adds two numbers\n  at /p/test/sum.test.js:2:8\n  at node:internal/modules/run_main:1:1\n${noise}\n# fail 1`
  const cut = excerpt(output)
  assert.match(cut, /not ok 401 - adds two numbers/)
  assert.match(cut, /sum\.test\.js:2:8/)
  assert.ok(cut.length < 400, `${cut.length} characters`)
  // Nothing recognisable: the tail, as v1 did
  assert.equal(excerpt("plain\nlines"), "plain\nlines")
  assert.match(excerpt("x".repeat(5000)), /^… \(2500 earlier characters left out\)/)
})

/* ─────────────────────────────── the DAG ─────────────────────────────── */

const PLAN = {
  goal: "Ship the report",
  steps: [
    { title: "Parse input", done_when: "parser tests pass" },
    { title: "Format totals", done_when: "format tests pass" },
    { title: "Render report", done_when: "report tests pass", after: [2] },
    { title: "Write docs", done_when: "docs build", after: [1] },
  ],
}

test("KV2-DAG-01: a v2 plan is a DAG written in topological order; v1 plans are unchanged", () => {
  const v2 = validatePlan(PLAN, { v2: true })
  assert.deepEqual(
    v2.steps.map((s) => s.after),
    [[], [1], [2], [1]]
  )
  assert.equal(validatePlan(PLAN).steps.some((s) => "after" in s), false)
  assert.deepEqual(validatePlan({ goal: "g", steps: [{ title: "a", done_when: "x" }, { title: "b", done_when: "y", after: [1, 1] }] }, { v2: true }).steps[1].after, [1])
  // A cycle, a self-edge or a forward edge can't be written
  for (const after of [[2], [1, 3], [0], ["x"], "1"])
    assert.throws(() => validatePlan({ goal: "g", steps: [{ title: "a", done_when: "x" }, { title: "b", done_when: "y", after }] }, { v2: true }), /earlier step/)
})

test("KV2-DAG-02: a blocked step skips only the steps that need it, spending no builder", async () => {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-dag-")))
  confirmCheck(dir, "check")
  savePlan(dir, "s1", PLAN, undefined, { v2: true })
  const results = { "1 Parse input": "pass", "2 Format totals": "fail", "4 Write docs": "pass" }
  let runs = 0
  const verify = async (label) => {
    const status = results[label]
    const { recordAndVerdict } = await fakeRecord(dir, "s1", label, status)
    runs++
    return recordAndVerdict
  }
  let spawned = 0
  const spawn = async () => ((spawned += 1), { output: [] })
  assert.equal((await runStep({ cwd: dir, sessionId: "s1", n: 1, spawn, verify, v2: {} })).status, "pass")
  assert.equal((await runStep({ cwd: dir, sessionId: "s1", n: 2, spawn, verify, v2: {} })).status, "blocked")
  const before = spawned
  const skipped = await runStep({ cwd: dir, sessionId: "s1", n: 3, spawn, verify, v2: {} })
  assert.equal(skipped.status, "skipped")
  assert.match(skipped.note, /needs step 2 \(Format totals\), which is blocked/)
  assert.equal(spawned, before, "no builder for a skipped step")
  // Step 4 needs only step 1, so it runs although 2 is blocked and 3 skipped
  assert.equal((await runStep({ cwd: dir, sessionId: "s1", n: 4, spawn, verify, v2: {} })).status, "pass")
  assert.deepEqual(
    planStatus(dir, "s1").map((r) => r.status),
    ["pass", "blocked", "skipped", "pass"]
  )
  assert.ok(runs >= 6)
})

// Records one run the way verifyStep does, with a scripted status
async function fakeRecord(dir, sessionId, label, status) {
  const result = await verifyStep({ cwd: dir, sessionId, step: label, run: async () => ({ exitCode: status === "pass" ? 0 : 1, timedOut: false, output: "AssertionError: no" }), tree: async () => undefined })
  return { recordAndVerdict: result }
}

test("KV2-DAG-03: a step can't run before the steps it needs have passed", async () => {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-dag-")))
  confirmCheck(dir, "check")
  savePlan(dir, "s2", PLAN, undefined, { v2: true })
  const spawn = async () => ({ output: [] })
  await assert.rejects(runStep({ cwd: dir, sessionId: "s2", n: 4, spawn, verify: async () => ({}), v2: {} }), /needs step 1 \(Parse input\) first/)
})

/* ───────────────────────────── backtracking ─────────────────────────── */

test("KV2-BT-01: an attempt that fails further from passing is set aside; the next builder starts from the best files", async () => {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-bt-")))
  confirmCheck(dir, "check")
  savePlan(dir, "s3", { goal: "g", steps: [{ title: "Fix sum", done_when: "tests pass" }] }, undefined, { v2: true })
  const outputs = ["AssertionError: 0 !== 4", "SyntaxError: Unexpected token", ""]
  const prompts = []
  const restored = []
  let attempt = 0
  const result = await runStep({
    cwd: dir,
    sessionId: "s3",
    n: 1,
    spawn: async (prompt) => (prompts.push(prompt), { output: [] }),
    verify: (label) =>
      verifyStep({ cwd: dir, sessionId: "s3", step: label, v2: {}, tree: async () => undefined, run: async () => ({ exitCode: outputs[attempt] ? 1 : 0, timedOut: false, output: outputs[attempt++] }) }),
    v2: { snapshot: async (label) => `tree:${label}`, restore: async (tree, label) => restored.push([tree, label]) },
  })
  assert.equal(result.status, "pass")
  assert.deepEqual(restored, [["tree:attempt 1 of step 1", "back to attempt 1 of step 1"]])
  assert.equal(result.builders[1].setAside, true)
  assert.match(prompts[1], /failure class: assertion/)
  assert.match(prompts[2], /This is attempt 3 of 4/)
  assert.match(prompts[2], /set aside: the files are as attempt 1 left them/)
  assert.match(prompts[2], /AssertionError: 0 !== 4/, "the next builder sees the best attempt's error")
})

test("KV2-BT-02: equal or better failures build on the latest files, as in v1; without v2 nothing is restored", async () => {
  for (const v2 of [{ snapshot: async () => "t", restore: async () => assert.fail("restored") }, undefined]) {
    freshHome()
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-bt-")))
    confirmCheck(dir, "check")
    savePlan(dir, "s4", { goal: "g", steps: [{ title: "Fix", done_when: "ok" }] }, undefined, { v2: Boolean(v2) })
    const outputs = ["SyntaxError: x", "AssertionError: y", "AssertionError: z", ""]
    let attempt = 0
    const result = await runStep({
      cwd: dir,
      sessionId: "s4",
      n: 1,
      spawn: async () => ({ output: [] }),
      verify: (label) => verifyStep({ cwd: dir, sessionId: "s4", step: label, tree: async () => undefined, ...(v2 && { v2: {} }), run: async () => ({ exitCode: outputs[attempt] ? 1 : 0, timedOut: false, output: outputs[attempt++] }) }),
      ...(v2 && { v2 }),
    })
    assert.equal(result.status, "pass")
    assert.equal(result.attempts, 4)
  }
})

test("KV2-BT-03: restoreTree puts the files back and keeps what it replaced; the person's HEAD and index are unchanged", async () => {
  freshHome()
  const { dir, git } = repo()
  const head = git("rev-parse", "HEAD")
  const index = readFileSync(join(dir, ".git", "index"))
  writeFileSync(join(dir, "sum.js"), "module.exports = (a, b) => a + b\n")
  const good = await checkpoint(dir, "s5", "attempt 1")
  writeFileSync(join(dir, "sum.js"), "module.exports = = 1\n")
  writeFileSync(join(dir, "extra.js"), "junk\n")
  const back = await restoreTree(dir, good.tree, "back to attempt 1")
  assert.equal(back.changed, 2)
  assert.equal(readFileSync(join(dir, "sum.js"), "utf8"), "module.exports = (a, b) => a + b\n")
  assert.equal(existsSync(join(dir, "extra.js")), false)
  assert.ok((await listCheckpoints(dir)).some((c) => c.kind === "undone" && c.label === "back to attempt 1"))
  assert.equal(git("rev-parse", "HEAD"), head)
  assert.deepEqual(readFileSync(join(dir, ".git", "index")), index)
  assert.equal((await restoreTree(dir, good.tree, "again")).changed, 0)
  assert.equal(await restoreTree(realpathSync(mkdtempSync(join(tmpdir(), "kriya-nogit-"))), good.tree, "x"), undefined)
})

/* ───────────────────────────── test integrity ────────────────────────── */

test("KV2-TG-01: a pass bought by weakening a committed test fails on the originals, and the work's files are put back", async () => {
  freshHome()
  const { dir } = repo()
  confirmCheck(dir, "node test/sum.test.js")
  const weakened = 'const assert = require("node:assert")\nassert.ok(true)\n'
  writeFileSync(join(dir, "test", "sum.test.js"), weakened)
  const run = runIn(dir)
  // v1: a pass that names the changed test
  const v1 = await verifyStep({ cwd: dir, sessionId: "t1", step: "1 sum", run })
  assert.equal(v1.status, "pass")
  assert.deepEqual(v1.touched, ["test/sum.test.js"])
  // v2: the originals fail, so the step fails as "tests changed"
  const v2 = await verifyStep({ cwd: dir, sessionId: "t2", step: "1 sum", run, v2: {} })
  assert.equal(v2.status, "fail")
  assert.equal(v2.failure, "tests changed")
  assert.deepEqual(v2.weakened, ["test/sum.test.js"])
  assert.match(v2.output, /AssertionError/)
  assert.equal(readFileSync(join(dir, "test", "sum.test.js"), "utf8"), weakened, "the work's own test is back")
  assert.equal(readProgress(dir, "t2").runs[0].kind, "tests changed")
})

test("KV2-TG-02: a real fix with added tests passes on the originals; deleted and added test files are restored", async () => {
  freshHome()
  const { dir } = repo()
  confirmCheck(dir, "node test/sum.test.js && (test ! -f test/extra.test.js || node test/extra.test.js)")
  writeFileSync(join(dir, "sum.js"), "module.exports = (a, b) => a + b\n")
  writeFileSync(join(dir, "test", "extra.test.js"), 'require("node:assert").strictEqual(require("../sum.js")(1, 2), 3)\n')
  const ok = await verifyStep({ cwd: dir, sessionId: "t3", step: "1 sum", run: runIn(dir), v2: {} })
  assert.equal(ok.status, "pass")
  assert.deepEqual(ok.touched, ["test/extra.test.js"])
  assert.equal(existsSync(join(dir, "test", "extra.test.js")), true)

  // Deleting the failing test "passes" the check; on the originals it fails, and the folder it deleted goes again
  writeFileSync(join(dir, "sum.js"), "module.exports = (a, b) => a - b\n")
  rmSync(join(dir, "test"), { recursive: true })
  const gone = await verifyStep({ cwd: dir, sessionId: "t4", step: "1 sum", run: async (c) => runIn(dir)(c.replace("node test/sum.test.js", "(test ! -f test/sum.test.js || node test/sum.test.js)")), v2: {} })
  assert.equal(gone.failure, "tests changed")
  assert.equal(existsSync(join(dir, "test")), false)
})

test("KV2-TG-03: no originals run in Read only, outside a repository or before a first commit", async () => {
  freshHome()
  const { dir } = repo()
  confirmCheck(dir, "node test/sum.test.js")
  writeFileSync(join(dir, "test", "sum.test.js"), "\n")
  assert.equal((await verifyStep({ cwd: dir, sessionId: "t5", step: "1", run: runIn(dir), v2: { readOnly: true } })).status, "pass")
  const fresh = realpathSync(mkdtempSync(join(tmpdir(), "kriya-v2-nohead-")))
  execFileSync("git", ["init", "-q"], { cwd: fresh })
  mkdirSync(join(fresh, "test"))
  writeFileSync(join(fresh, "test", "a.test.js"), "\n")
  confirmCheck(fresh, "node test/a.test.js")
  assert.equal((await verifyStep({ cwd: fresh, sessionId: "t6", step: "1", run: runIn(fresh), v2: {} })).status, "pass")
})

/* ──────────────────────────────── rules ──────────────────────────────── */

test("KV2-RL-01: a failure seen twice is proposed once; only the person's confirmation reaches the builders", () => {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-rules-")))
  const failure = classify({ output: "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.", exitCode: 2 })
  assert.equal(noteFailure(dir, "npm run typecheck", failure), undefined)
  // Line numbers differ between runs; the signature ignores them
  const again = classify({ output: "src/a.ts(9,1): error TS2322: Type 'string' is not assignable to type 'number'.", exitCode: 2 })
  const made = noteFailure(dir, "npm run typecheck", again)
  assert.match(made.text, /^Check types, names and call signatures/)
  assert.match(made.text, /`npm run typecheck` failed twice this way: .*TS#: Type 'string'/)
  assert.equal(noteFailure(dir, "npm run typecheck", again), undefined, "proposed once")
  assert.deepEqual(confirmedRules(dir), [], "a proposal isn't seen by the agent")
  assert.equal(confirmRule(dir, 1, "Run npm run typecheck before finishing a step."), "Run npm run typecheck before finishing a step.")
  assert.deepEqual(confirmedRules(dir), ["- Run npm run typecheck before finishing a step."])
  assert.deepEqual(listRules(dir).proposed, [])
  assert.equal(noteFailure(dir, "npm run typecheck", again), undefined, "not proposed again once confirmed")
  // Dismissed: never proposed again
  const other = classify({ output: "AssertionError: 1 !== 2", exitCode: 1 })
  noteFailure(dir, "npm test", other)
  noteFailure(dir, "npm test", other)
  dismissRule(dir, 1)
  noteFailure(dir, "npm test", other)
  assert.deepEqual(listRules(dir).proposed, [])
  assert.throws(() => confirmRule(dir, 4), /no proposed rule 4/)
})

test("KV2-RL-02: the v2 verify step notes failures and names a new proposal; v1 notes nothing", async () => {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-rules-")))
  confirmCheck(dir, "check")
  const run = async () => ({ exitCode: 1, timedOut: false, output: "SyntaxError: Unexpected token ')'" })
  await verifyStep({ cwd: dir, sessionId: "r1", step: "a", run, tree: async () => undefined })
  await verifyStep({ cwd: dir, sessionId: "r1", step: "a", run, tree: async () => undefined })
  assert.deepEqual(listRules(dir).proposed, [], "v1 proposes nothing")
  const first = await verifyStep({ cwd: dir, sessionId: "r2", step: "a", run, tree: async () => undefined, v2: {} })
  assert.equal(first.failure, "syntax")
  assert.equal(first.proposed, undefined)
  const second = await verifyStep({ cwd: dir, sessionId: "r2", step: "a", run, tree: async () => undefined, v2: {} })
  assert.match(second.proposed, /failed to parse/)
  assert.equal(listRules(dir).proposed.length, 1)
})

/* ───────────────────────────── switches, v1 ──────────────────────────── */

test("KV2-REG-01: v2 is opt-in; off, the tools, guidance and prompts are exactly v1's", async () => {
  const env = {}
  switchEnv(["job"], env)
  assert.equal(env.KRIYA_LOOP_V2, "off")
  const on = {}
  const args = ["--loop-v2", "job"]
  switchEnv(args, on)
  assert.deepEqual([on.KRIYA_LOOP_V2, on.KRIYA_LOOP, args], ["on", "on", ["job"]])

  const stepSchema = (host) => planTool({ isBuilder: () => false, cwd: async () => "/", ...host })
  assert.doesNotMatch(JSON.stringify(stepSchema({})), /"after"/)
  assert.match(JSON.stringify(stepSchema({ v2: () => ({}) })), /"after"/)
  assert.ok(!GUIDANCE.includes(GUIDANCE_V2))
  const plan = validatePlan({ goal: "g", steps: [{ title: "a", done_when: "x" }] })
  assert.equal(builderPrompt(plan, 1, undefined, []), builderPrompt(plan, 1))
  assert.equal(stepLabel(plan, 1), "1 a")
  assert.equal(typeof verifyTool({ cwd: async () => "/", run: async () => ({}) }).name, "string")
})

test("KV2-CLI-01: kriya rules lists proposals apart from confirmed rules; confirm and dismiss are the person's", () => {
  const home = freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-rules-cli-")))
  const failure = classify({ output: "AssertionError: 1 !== 2", exitCode: 1 })
  noteFailure(dir, "npm test", failure)
  noteFailure(dir, "npm test", failure)
  const cli = (...args) => spawnSync(process.execPath, [join(import.meta.dirname, "..", "bin", "kriya.js"), "rules", ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, KRIYA_HOME: home } })
  const listed = cli()
  assert.equal(listed.status, 0, listed.stderr)
  assert.match(listed.stdout, /No confirmed rules for this project\./)
  assert.match(listed.stdout, /Proposed by the loop .*\n {2}1\. Read the failing test's expectation/)
  const confirmed = cli("confirm", "1", "Fix", "the", "code,", "not", "the", "test.")
  assert.equal(confirmed.status, 0, confirmed.stderr)
  assert.deepEqual(confirmedRules(dir), ["- Fix the code, not the test."])
  assert.equal(cli("dismiss", "3").status, 1)
  assert.equal(cli("nonsense").status, 1)
})

test("KV2-TG-04: the work's files are saved on a checkpoint before the originals run", async () => {
  freshHome()
  const { dir } = repo()
  confirmCheck(dir, "node test/sum.test.js")
  writeFileSync(join(dir, "test", "sum.test.js"), "\n")
  await verifyStep({ cwd: dir, sessionId: "t7", step: "1", run: runIn(dir), v2: {} })
  const saved = (await listCheckpoints(dir)).find((c) => c.label === "before the check on the committed tests")
  assert.ok(saved)
  assert.equal(execFileSync("git", ["show", `${saved.commit}:test/sum.test.js`], { cwd: dir }).toString(), "\n")
})
