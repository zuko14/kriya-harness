import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { critiquePrompt, MAX_DEFECTS, parseDefects } from "../src/critic.js"
import { confirmBaseline, GateCommandError, useGateCommand } from "../src/gate-commands.js"
import { commandGate, dataGate, evalGate, simHeadlessGate } from "../src/gates/commands.js"
import { builderPrompt, runStep, savePlan, validatePlan } from "../src/loop.js"
import { SWITCHES } from "../src/modes.js"
import { confirmCheck, readProgress, verifyStep } from "../src/verify.js"
import { freshHome } from "./helpers.js"

// Harness 2.0 W6: the critic's answer and bounds, the monotone polish, and
// the gates that run a person-confirmed command. WT-CRI-*, WT-GATE-CMD-*.

const D = (severity, where = "src/a.ts:3", fix = "Name the empty state's next step") => ({ id: "next-step", severity, where, fix })

test("WT-CRI-01: only exactly-shaped JSON counts as defects; anything else is none", () => {
  assert.deepEqual(parseDefects(JSON.stringify({ defects: [D("major")] })), [D("major")])
  assert.deepEqual(parseDefects(`Here you go:\n${JSON.stringify({ defects: [D("minor")] })}\nThanks`), [D("minor")])
  assert.deepEqual(parseDefects('{"defects":[{"severity":"blocker","where":"x","fix":"y"}]}'), [])
  assert.deepEqual(parseDefects('{"defects":[{"severity":"major","where":"x","fix":"y","pass":true}]}'), [])
  assert.deepEqual(parseDefects(JSON.stringify({ defects: Array.from({ length: MAX_DEFECTS + 1 }, () => D("major")) })), [])
  assert.deepEqual(parseDefects("The step passes; ship it."), [])
  assert.deepEqual(parseDefects("{not json}"), [])
  const prompt = critiquePrompt({ role: "frontend", judgement: [{ id: "hierarchy", ask: "Does the hierarchy read at a glance?", severity: "major" }], plan: { goal: "G", steps: [{ title: "T", doneWhen: "D" }] }, n: 1, changed: ["src/a.tsx"], notes: ["G-UI: small target"] })
  assert.match(prompt, /you change nothing and run nothing/)
  assert.match(prompt, /hierarchy: Does the hierarchy read at a glance\? \(major\)/)
  assert.match(prompt, /G-UI: small target/)
})

function project() {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-cri-")))
  writeFileSync(join(dir, "package.json"), "{}")
  confirmCheck(dir, "npm test")
  savePlan(dir, "s", { goal: "g", steps: [{ title: "one", done_when: "it works" }] })
  return dir
}
const PASS = { exitCode: 0, timedOut: false, output: "" }
const FAIL = { exitCode: 1, timedOut: false, output: "AssertionError: x\n  at a.js:1" }
const verifier = (dir, results) => {
  let i = 0
  return (label) => verifyStep({ cwd: dir, sessionId: "s", step: label, run: async () => results[Math.min(i++, results.length - 1)] })
}

test("WT-CRI-02: a major defect after a pass earns one polish builder; kept when every check still passes", async () => {
  const dir = project()
  const prompts = []
  let critiques = 0
  const r = await runStep({ cwd: dir, sessionId: "s", n: 1, spawn: async (p) => (prompts.push(p), { output: [] }), verify: verifier(dir, [PASS, PASS]), polish: { critique: async (_step, n) => (critiques++, assert.equal(n, 1), [D("major"), D("minor", "b", "c")]), snapshot: async () => "tree-pass", restore: async () => assert.fail("nothing to restore") } })
  assert.equal(r.status, "pass")
  assert.equal(r.polished, 1)
  assert.equal(critiques, 1)
  assert.equal(prompts.length, 2)
  assert.match(prompts[1], /found these major defects:\n- src\/a\.ts:3: Name the empty state's next step/)
  assert.doesNotMatch(prompts[1], /- b: c/)
  assert.ok(readProgress(dir, "s").builders.some((b) => b.polish === 1))
})

test("WT-CRI-03: a polish that breaks a check is reverted to the passing files and checked again; the step still passes", async () => {
  const dir = project()
  const restored = []
  const r = await runStep({ cwd: dir, sessionId: "s", n: 1, spawn: async () => ({ output: [] }), verify: verifier(dir, [PASS, FAIL, PASS]), polish: { critique: async () => [D("major")], snapshot: async () => "tree-pass", restore: async (tree, why) => restored.push([tree, why]) } })
  assert.equal(r.status, "pass")
  assert.equal(r.polishReverted, true)
  assert.deepEqual(restored, [["tree-pass", "polish of step 1 broke a check"]])
  const runs = readProgress(dir, "s").runs.map((x) => x.status)
  assert.deepEqual(runs, ["pass", "fail", "pass"])
})

test("WT-CRI-04: no polish for minor defects only, for a step near its failure limit, without a snapshot, or without the option", async () => {
  let dir = project()
  let builds = 0
  await runStep({ cwd: dir, sessionId: "s", n: 1, spawn: async () => (builds++, { output: [] }), verify: verifier(dir, [PASS]), polish: { critique: async () => [D("minor")], snapshot: async () => "t", restore: async () => {} } })
  assert.equal(builds, 1)
  dir = project()
  builds = 0
  let asked = 0
  await runStep({ cwd: dir, sessionId: "s", n: 1, spawn: async () => (builds++, { output: [] }), verify: verifier(dir, [FAIL, FAIL, FAIL, PASS]), polish: { critique: async () => (asked++, [D("major")]), snapshot: async () => "t", restore: async () => {} } })
  assert.equal(builds, 4, "three failures and a pass: no fifth builder")
  assert.equal(asked, 0)
  dir = project()
  builds = 0
  await runStep({ cwd: dir, sessionId: "s", n: 1, spawn: async () => (builds++, { output: [] }), verify: verifier(dir, [PASS]), polish: { critique: async () => [D("major")], snapshot: async () => undefined, restore: async () => {} } })
  assert.equal(builds, 1, "no snapshot of the passing files, no polish")
  const plan = validatePlan({ goal: "g", steps: [{ title: "one", done_when: "x" }] })
  assert.equal(builderPrompt(plan, 1, undefined, [], { polish: [] }), builderPrompt(plan, 1, undefined, []))
  assert.deepEqual(SWITCHES.find(([n]) => n === "critic"), ["critic", "KRIYA_CRITIC", false])
})

// ── the command gates ──
function root() {
  freshHome()
  return realpathSync(mkdtempSync(join(tmpdir(), "kriya-cmd-")))
}

test("WT-GATE-CMD-01: commands are confirmed by the person, one line, paths inside the project", () => {
  const dir = root()
  assert.throws(() => useGateCommand(dir, "deploy", "x"), GateCommandError)
  assert.throws(() => useGateCommand(dir, "data", "make load"), /--output/)
  assert.throws(() => useGateCommand(dir, "data", "make load", { output: "../elsewhere" }), /inside it/)
  assert.throws(() => useGateCommand(dir, "eval", "python eval.py", { metrics: "/tmp/m.json", metric: "f1" }), /inside it/)
  assert.throws(() => useGateCommand(dir, "san", "make\nrm -rf /"), /one line/)
  assert.equal(useGateCommand(dir, "eval", "python eval.py", { metrics: "out/m.json", metric: "f1" }).direction, "higher")
})

test("WT-GATE-CMD-02: G-DATA runs the pipeline twice and fails when the output changes", async () => {
  const dir = root()
  assert.equal((await dataGate({ root: dir, command: async () => PASS })).status, "not_checked")
  useGateCommand(dir, "data", "load", { output: "out" })
  mkdirSync(join(dir, "out"))
  let n = 0
  const idempotent = async () => (writeFileSync(join(dir, "out", "sales.csv"), "id,amount\n1,10\n"), PASS)
  assert.equal((await dataGate({ root: dir, command: idempotent })).status, "pass")
  const appending = async () => (writeFileSync(join(dir, "out", "sales.csv"), `id,amount\n${"1,10\n".repeat(++n)}`), PASS)
  const r = await dataGate({ root: dir, command: appending })
  assert.equal(r.status, "fail")
  assert.match(r.excerpt, /isn't idempotent/)
})

test("WT-GATE-CMD-03: G-EVAL records a first run for the person to confirm, then fails a regression; a changed evaluation can't judge itself", async () => {
  const dir = root()
  useGateCommand(dir, "eval", "python eval.py", { metrics: "out/m.json", metric: "f1", margin: "0.01" })
  mkdirSync(join(dir, "out"))
  const score = (f1) => async () => (writeFileSync(join(dir, "out", "m.json"), JSON.stringify({ f1 })), PASS)
  const first = await evalGate({ root: dir, command: score(0.8) })
  assert.equal(first.status, "not_checked")
  assert.match(first.reason, /kriya eval baseline confirm/)
  assert.equal(confirmBaseline(dir).value, 0.8)
  assert.equal((await evalGate({ root: dir, command: score(0.795) })).status, "pass")
  const worse = await evalGate({ root: dir, command: score(0.7) })
  assert.equal(worse.status, "fail")
  assert.match(worse.excerpt, /worse than the confirmed baseline 0\.8/)
  assert.equal((await evalGate({ root: dir, command: score(0.9), changed: ["eval/score.py"] })).status, "not_checked")
  // A metrics file the run didn't write is refused
  writeFileSync(join(dir, "out", "m.json"), JSON.stringify({ f1: 0.99 }))
  const old = new Date(Date.now() - 60_000)
  utimesSync(join(dir, "out", "m.json"), old, old)
  assert.equal((await evalGate({ root: dir, command: async () => PASS })).status, "fail")
})

test("WT-GATE-CMD-04: G-SAN fails on a sanitizer report even at exit 0; G-IAC and G-SIM on a non-zero exit", async () => {
  const dir = root()
  useGateCommand(dir, "san", "make asan")
  useGateCommand(dir, "iac", "tofu validate")
  useGateCommand(dir, "sim", "xcodebuild test")
  const asan = async () => ({ exitCode: 0, timedOut: false, output: "==123==ERROR: AddressSanitizer: heap-buffer-overflow\n    #0 0x1 in parse src/p.c:10" })
  const r = await commandGate({ root: dir, command: asan, gate: "san", id: "G-SAN" })
  assert.equal(r.status, "fail")
  assert.match(r.excerpt, /heap-buffer-overflow/)
  assert.equal((await commandGate({ root: dir, command: async () => PASS, gate: "san", id: "G-SAN" })).status, "pass")
  assert.equal((await commandGate({ root: dir, command: async () => ({ exitCode: 1, timedOut: false, output: "Error: invalid" }), gate: "iac", id: "G-IAC" })).status, "fail")
  assert.equal((await commandGate({ root: dir, command: async () => PASS, gate: "sim", id: "G-SIM" })).status, "pass")
  assert.equal((await commandGate({ root: root(), command: async () => PASS, gate: "sim", id: "G-SIM" })).status, "not_checked")
})

test("WT-GATE-CMD-05: G-SIM-HEADLESS needs the same STATE-HASH twice, and a median frame within budget", async () => {
  const dir = root()
  useGateCommand(dir, "sim-headless", "node sim.js", { frameBudgetMs: "16.6" })
  const out = (hash, frame) => async () => ({ exitCode: 0, timedOut: false, output: `ticks 10000\nSTATE-HASH: ${hash}\nFRAME-MS-MEDIAN: ${frame}` })
  assert.equal((await simHeadlessGate({ root: dir, command: out("ab12cd34ef56", 3.2) })).status, "pass")
  let i = 0
  const drifting = async () => ({ exitCode: 0, timedOut: false, output: `STATE-HASH: ${++i % 2 ? "aaaaaaaa" : "bbbbbbbb"}` })
  assert.match((await simHeadlessGate({ root: dir, command: drifting })).excerpt, /isn't deterministic/)
  assert.match((await simHeadlessGate({ root: dir, command: out("ab12cd34ef56", 21) })).excerpt, /over the 16\.6 ms budget/)
  assert.match((await simHeadlessGate({ root: dir, command: async () => PASS })).excerpt, /must print STATE-HASH/)
})
