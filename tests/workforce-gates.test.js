import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { after, before, test } from "node:test"

import { contractProblems, contractSlices, drifted, ownedHashes, presentContracts, resolvePointer } from "../src/contracts.js"
import { runGates, trace } from "../src/gates/index.js"
import { builderPrompt, runStep, savePlan, validatePlan } from "../src/loop.js"
import { SWITCHES } from "../src/modes.js"
import { confirmCheck, readProgress, verifyStep } from "../src/verify.js"
import { freshHome, ROOT } from "./helpers.js"

// Harness 2.0 W3: gates on real git repositories (each gate's mutant fails,
// the clean fixture passes), the contract bus, and verifyStep with and
// without gates. WT-GATE-*, WT-CB-*, WT-REG-03.

let head
before(async () => {
  const dir = mkdtempSync(join(ROOT, "tests", ".head-"))
  execFileSync("sh", ["-c", `git archive HEAD src contract package.json | tar -x -C "${dir}"`], { cwd: ROOT })
  head = { dir, verify: await import(pathToFileURL(join(dir, "src", "verify.js")).href) }
})
after(() => rmSync(head.dir, { recursive: true, force: true }))

// A fixed date too: two identical fixtures then have the same HEAD, so run records
// (whose tree fingerprint includes HEAD) compare equal whatever second they were made in
const GIT = { GIT_AUTHOR_NAME: "P", GIT_AUTHOR_EMAIL: "p@x", GIT_COMMITTER_NAME: "P", GIT_COMMITTER_EMAIL: "p@x", GIT_AUTHOR_DATE: "2026-11-23T00:00:00Z", GIT_COMMITTER_DATE: "2026-11-23T00:00:00Z" }
function repo(files = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-gate-")))
  const git = (...args) => execFileSync("git", args, { cwd: dir, env: { ...process.env, ...GIT } })
  git("init", "-q", "-b", "main")
  write(dir, { "package.json": "{}", "README.md": "# app\n", ...files })
  git("add", "-A")
  git("commit", "-q", "-m", "base")
  return dir
}
function write(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
}
const changed = (dir) =>
  execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: dir, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3))
const PASS = { exitCode: 0, timedOut: false, output: "" }
const BACKEND = { role: "backend", gates: ["G-DETECT"], detectors: [{ id: "BE-SQL-INTERP", severity: "error" }, { id: "BE-NO-TIMEOUT", severity: "warn" }], owns: [] }
const gate = (dir, extra = {}) => runGates({ root: dir, changed: changed(dir), output: "", rerun: async () => PASS, label: "1 x", ...extra })

test("WT-GATE-01: a clean change passes every gate; results are listed in order", async () => {
  const dir = repo()
  write(dir, { "src/orders.ts": "export const total = (xs) => xs.reduce((a, b) => a + b, 0)\n" })
  const r = await gate(dir, { cartridge: BACKEND })
  assert.equal(r.failure, undefined)
  assert.deepEqual(r.results.map((x) => [x.id, x.status]), [["G-CONTRACT", "pass"], ["G-DETECT", "pass"], ["G-SECRETS", "pass"]])
})

test("WT-GATE-02 (G-SECRETS mutant): a key added to the work fails, and the excerpt names the place, not the value", async () => {
  const dir = repo()
  const key = "AKIA" + "QWERTYUIOPASDFGH"
  write(dir, { "src/config.ts": `export const key = "${key}"\n` })
  const r = await gate(dir)
  assert.equal(r.failure?.id, "G-SECRETS")
  assert.match(r.failure.excerpt, /src\/config\.ts:1/)
  assert.ok(!r.failure.excerpt.includes(key))
})

test("WT-GATE-03 (G-DETECT mutant): an error finding on an added line fails; the same code already committed doesn't", async () => {
  const bad = "export const q = (db, id) => db.query(`SELECT * FROM orders WHERE id = ${id}`)\n"
  let dir = repo()
  write(dir, { "src/db.ts": bad })
  const r = await gate(dir, { cartridge: BACKEND })
  assert.equal(r.failure?.id, "G-DETECT")
  assert.match(r.failure.excerpt, /BE-SQL-INTERP/)
  dir = repo({ "src/db.ts": bad })
  write(dir, { "src/db.ts": `${bad}export const ok = 1\n` })
  assert.equal((await gate(dir, { cartridge: BACKEND })).failure, undefined)
  // Without a cartridge, detectors don't run (only the gates every step gets)
  dir = repo()
  write(dir, { "src/db.ts": bad })
  assert.equal((await gate(dir)).failure, undefined)
})

test("WT-GATE-04 (G-FLAKE mutant): a check that fails on a re-run fails the step; a steady one passes", async () => {
  const dir = repo()
  const sdet = { role: "sdet", gates: ["G-FLAKE"], detectors: [], owns: [] }
  let n = 0
  const flaky = await gate(dir, { cartridge: sdet, rerun: async () => (++n === 2 ? { exitCode: 1, timedOut: false, output: "1 failed" } : PASS) })
  assert.equal(flaky.failure?.id, "G-FLAKE")
  assert.equal(flaky.failure.kind, "flaky")
  assert.equal((await gate(dir, { cartridge: sdet })).failure, undefined)
})

test("WT-GATE-05 (G-TRACE): every AC-n needs a passing test named for it; no ids or no names reads not checked", () => {
  const step = { title: "t", doneWhen: "AC-1 totals add up; AC-2 empty cart is zero" }
  assert.equal(trace(step, "✔ AC-1: totals add up\n✔ AC-2: empty cart").status, "pass")
  const miss = trace(step, "✔ AC-1: totals add up\n✖ AC-2: empty cart")
  assert.equal(miss.status, "fail")
  assert.match(miss.excerpt, /AC-2/)
  assert.equal(trace({ title: "t", doneWhen: "it works" }, "✔ AC-1").status, "not_checked")
  assert.equal(trace(step, "Test Files 3 passed").status, "not_checked")
  // The same id on two calls gives the same answer (no regex state carried over)
  assert.equal(trace(step, "✔ AC-1: x\n✔ AC-2: y").status, trace(step, "✔ AC-1: x\n✔ AC-2: y").status)
})

test("WT-CB-01: contracts are validated: bad JSON, a schema violation, a dangling $ref and an unknown threat test all fail G-CONTRACT", async () => {
  const cases = {
    "auth_matrix.json": "[{",
    "component_states.json": JSON.stringify({ Cart: { states: ["loading", "spinning"] } }),
    "api.openapi.json": JSON.stringify({ openapi: "3.1.0", info: { title: "a", version: "1" }, paths: { "/o": { get: { responses: { 200: { $ref: "#/components/responses/Nope" } } } } } }),
    "threat_model.json": JSON.stringify([{ asset: "orders", boundary: "api", threat: "idor", control: "rls", test: "tests/nowhere.test.ts" }]),
  }
  for (const [name, text] of Object.entries(cases)) {
    const dir = repo()
    write(dir, { [`.kriya/contracts/${name}`]: text })
    const r = await gate(dir)
    assert.equal(r.failure?.id, "G-CONTRACT", name)
    assert.equal(r.failure.kind, "gate", name)
  }
  const dir = repo()
  write(dir, {
    ".kriya/contracts/api.openapi.json": JSON.stringify({ openapi: "3.1.0", info: { title: "a", version: "1" }, paths: { "/o": { get: { responses: { 200: { $ref: "#/components/responses/Ok" } } } } }, components: { responses: { Ok: { description: "ok" } } } }),
    ".kriya/contracts/threat_model.json": JSON.stringify([{ asset: "orders", boundary: "api", threat: "idor", control: "rls", test: "G-SECRETS" }]),
    ".kriya/contracts/schema.sql": "create table orders (id uuid primary key);\n",
  })
  assert.equal((await gate(dir)).failure, undefined)
  assert.deepEqual(contractProblems(dir, "api"), [])
})

test("WT-CB-02: a contract changed by a role that doesn't own it fails as contract changed; its owner may change it", async () => {
  const dir = repo({ ".kriya/contracts/schema.sql": "create table orders (id uuid);\n" })
  const recorded = ownedHashes(dir, ["schema"], "1 schema")
  assert.deepEqual(Object.keys(recorded), ["schema"])
  write(dir, { ".kriya/contracts/schema.sql": "create table orders (id uuid, note text);\n" })
  assert.deepEqual(drifted(dir, recorded, []).map((d) => d.name), ["schema"])
  assert.deepEqual(drifted(dir, recorded, ["schema"]), [])
  const r = await gate(dir, { cartridge: BACKEND, recorded })
  assert.equal(r.failure?.kind, "contract changed")
  assert.match(r.failure.excerpt, /schema\.sql changed/)
  const owner = await gate(dir, { cartridge: { role: "database", gates: ["G-DETECT"], detectors: [], owns: ["schema"] }, recorded })
  assert.equal(owner.failure, undefined)
  assert.notEqual(owner.contracts.schema.sha, recorded.schema.sha)
})

test("WT-CB-03: slices by JSON Pointer are exact, bounded and skip what doesn't resolve", () => {
  const dir = repo({ ".kriya/contracts/api.openapi.json": JSON.stringify({ openapi: "3.1.0", info: { title: "a", version: "1" }, paths: { "/orders": { post: { responses: { 201: { description: "made" } } } }, "/x": {} } }) })
  const text = contractSlices(dir, ["api#/paths/~1orders", "api#/paths/~1missing", "nope"])
  assert.match(text, /api\.openapi\.json#\/paths\/~1orders/)
  assert.match(text, /"201"/)
  assert.doesNotMatch(text, /missing|\/x/)
  assert.equal(resolvePointer({ "a/b": { "c~d": 1 } }, "/a~1b/c~0d"), 1)
  assert.deepEqual(presentContracts(repo()), {})
})

const CHECKED = (dir) => {
  confirmCheck(dir, "npm test")
  return dir
}

test("WT-REG-03: without gates, verifyStep is byte for byte the code at HEAD (pass and fail)", async () => {
  freshHome()
  for (const outcome of [PASS, { exitCode: 1, timedOut: false, output: "AssertionError: x\n  at a.js:1" }]) {
    for (const extra of [{}, { guard: true }, { v2: { readOnly: false } }]) {
      const a = CHECKED(repo())
      const b = CHECKED(repo())
      const fixed = () => new Date("2026-11-23T00:00:00Z")
      const now = await verifyStep({ cwd: a, sessionId: "s", step: "1 x", run: async () => outcome, now: fixed, ...extra })
      const before = await head.verify.verifyStep({ cwd: b, sessionId: "s", step: "1 x", run: async () => outcome, now: fixed, ...extra })
      assert.deepEqual(now, before, JSON.stringify({ outcome, extra }))
      assert.deepEqual(readProgress(a, "s").runs, head.verify.readProgress(b, "s").runs)
    }
  }
})

test("WT-GATE-06: with gates, a passing check whose gate fails is a failed run with the gate's class; a pass records the owner's contract hashes", async () => {
  freshHome()
  const dir = CHECKED(repo())
  write(dir, { "src/config.ts": `export const key = "${"AKIA" + "ZXCVBNMLKJHGFDSA"}"\n` })
  const gates = (input) => runGates({ ...input, cartridge: BACKEND })
  const failed = await verifyStep({ cwd: dir, sessionId: "s", step: "1 x", run: async () => PASS, gates, guard: true })
  assert.equal(failed.status, "fail")
  assert.equal(failed.failure, "gate")
  assert.match(failed.output, /G-SECRETS/)
  const run = readProgress(dir, "s").runs.at(-1)
  assert.equal(run.kind, "gate")
  assert.deepEqual(run.gates.map((g) => [g.id, g.status]), [["G-CONTRACT", "pass"], ["G-DETECT", "pass"], ["G-SECRETS", "fail"]])
  // An owner's pass records its contract hashes in the ledger
  const db = CHECKED(repo())
  write(db, { ".kriya/contracts/schema.sql": "create table t (id int);\n" })
  const ok = await verifyStep({ cwd: db, sessionId: "s", step: "1 schema", run: async () => PASS, gates: (input) => runGates({ ...input, cartridge: { role: "database", gates: [], detectors: [], owns: ["schema"] } }) })
  assert.equal(ok.status, "pass")
  assert.equal(readProgress(db, "s").contracts.schema.step, "1 schema")
})

test("WT-GATE-07: the switch defaults off; with contracts on, a plan step names slices and its builder gets them after the cartridge", async () => {
  assert.deepEqual(SWITCHES.find(([n]) => n === "gates"), ["gates", "KRIYA_GATES", false])
  const names = ["api", "schema"]
  const input = { goal: "g", steps: [{ title: "Orders API", done_when: "works", contracts: ["api#/paths/~1orders"] }] }
  assert.deepEqual(validatePlan(input, { contracts: names }).steps[0].contracts, ["api#/paths/~1orders"])
  assert.equal("contracts" in validatePlan(input).steps[0], false)
  assert.throws(() => validatePlan({ goal: "g", steps: [{ title: "a", done_when: "b", contracts: ["secrets#/x"] }] }, { contracts: names }), /isn't one of/)
  freshHome()
  const dir = CHECKED(repo({ ".kriya/contracts/api.openapi.json": JSON.stringify({ openapi: "3.1.0", info: { title: "a", version: "1" }, paths: { "/orders": { post: { responses: { 201: { description: "made" } } } } } }) }))
  savePlan(dir, "s", input, undefined, { contracts: names })
  const prompts = []
  await runStep({ cwd: dir, sessionId: "s", n: 1, spawn: async (p) => (prompts.push(p), { output: [] }), verify: (label) => verifyStep({ cwd: dir, sessionId: "s", step: label, run: async () => PASS }), slices: (step) => contractSlices(dir, step.contracts) })
  assert.match(prompts[0], /^Contracts for this step\./)
  assert.match(prompts[0], /"201"/)
  // No slices: the prompt is as before
  const plan = validatePlan(input, { contracts: names })
  assert.equal(builderPrompt(plan, 1, undefined, [], { slices: "" }), builderPrompt(plan, 1, undefined, []))
})
