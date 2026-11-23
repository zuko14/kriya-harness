import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { askTake, planTool } from "../plugins/loop/index.js"
import { checkpoint, listCheckpoints, restoreTree, snapshot, trackedRoot } from "../src/checkpoints.js"
import { directionHints, EXPLORE_ROLES, MAX_TAKES, takeQuestion, waitForReload } from "../src/explore.js"
import { runStep, savePlan, validatePlan } from "../src/loop.js"
import { SWITCHES } from "../src/modes.js"
import { confirmCheck, MAX_ATTEMPTS, readProgress, verifyStep } from "../src/verify.js"
import { freshHome } from "./helpers.js"

// Harness 2.0 W14 (WD-18), WT-EXP-*: Explore. Takes are built one after
// another in the same (real git) folder, each checked by the project's real
// check, snapshotted with Kriya's own checkpoints and restored between takes.

const ROLES = ["frontend", "designer", "graphics", "backend"]
const PLAN = (explore = 3, role = "graphics") => ({ goal: "A hero scene", steps: [{ title: "Hero scene", done_when: "node check.js passes", files: ["value.js"], role, explore }] })

function project() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-explore-")))
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" })
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "T")
  writeFileSync(join(dir, "check.js"), 'const assert = require("node:assert")\nconst v = require("./value.js")\nassert.strictEqual(v.ok, true, `value ${v.name} is not ok`)\n')
  writeFileSync(join(dir, "value.js"), 'module.exports = { name: "start", ok: false }\n')
  git("add", ".")
  git("commit", "-qm", "base")
  confirmCheck(dir, "node check.js")
  return dir
}
const runIn = (dir) => async (command) => {
  const r = spawnSync("sh", ["-c", command], { cwd: dir, encoding: "utf8" })
  return { exitCode: r.status, timedOut: false, output: `${r.stdout}${r.stderr}` }
}

/** A scripted builder: each call writes the next value; it records the prompt it was given. */
function scripted(dir, values) {
  const prompts = []
  const spawn = async (prompt, label) => {
    const v = values[prompts.length] ?? values.at(-1)
    prompts.push({ prompt, label })
    writeFileSync(join(dir, "value.js"), `module.exports = ${JSON.stringify(v)}\n`)
    return { output: [{ type: "text", text: `wrote ${v.name}` }] }
  }
  return { spawn, prompts }
}

function setup({ explore = 3, values, pick, rank, readOnly = false, served, reloaded }) {
  freshHome()
  const dir = project()
  savePlan(dir, "s1", PLAN(explore), undefined, { v2: true, roles: ROLES, explore: true })
  const { spawn, prompts } = scripted(dir, values)
  const verify = (label) => verifyStep({ cwd: dir, sessionId: "s1", step: label, run: runIn(dir) })
  const explorer = {
    readOnly,
    snapshot: async (label) => (await checkpoint(dir, "s1", label))?.tree,
    restore: (tree, label) => restoreTree(dir, tree, label),
    ...(pick && { pick }),
    ...(rank && { rank }),
    ...(served && { served, reloaded }),
  }
  return { dir, prompts, step: () => runStep({ cwd: dir, sessionId: "s1", n: 1, spawn, verify, v2: {}, explore: explorer }) }
}
const pass = (name) => ({ name, ok: true })
const fail = (name) => ({ name, ok: false })

test("WT-EXP-01: explore is 2 or 3 takes, only for frontend, designer and graphics, and only with the switch", () => {
  assert.deepEqual(EXPLORE_ROLES, ["frontend", "designer", "graphics"])
  assert.equal(MAX_TAKES, 3)
  assert.equal(validatePlan(PLAN(2), { roles: ROLES, explore: true }).steps[0].explore, 2)
  for (const role of ["frontend", "designer"]) assert.equal(validatePlan(PLAN(3, role), { roles: ROLES, explore: true }).steps[0].explore, 3)
  assert.throws(() => validatePlan(PLAN(4), { roles: ROLES, explore: true }), /explore is 2 or 3 takes/)
  assert.throws(() => validatePlan(PLAN(1), { roles: ROLES, explore: true }), /explore is 2 or 3 takes/)
  assert.throws(() => validatePlan(PLAN(2, "backend"), { roles: ROLES, explore: true }), /explores only with role frontend, designer, graphics/)
  // Off: the field is never read, and the plan tool doesn't offer it
  assert.equal("explore" in validatePlan(PLAN(3), { roles: ROLES }).steps[0], false)
  assert.deepEqual(SWITCHES.find(([f]) => f === "explore"), ["explore", "KRIYA_EXPLORE", false])
  const props = (on) => planTool({ isBuilder: () => false, cwd: async () => "/", roles: ROLES, explore: on }).parameters.properties.steps.items.properties
  assert.equal("explore" in props(false), false)
  assert.equal(props(true).explore.type, "number")
})

test("WT-EXP-02: takes count as attempts; with no take passing, takes + retries stay within MAX_ATTEMPTS", async () => {
  const s = setup({ explore: 3, values: [fail("a"), fail("b"), fail("c"), fail("d"), fail("e"), fail("f")] })
  const r = await s.step()
  assert.equal(r.status, "blocked")
  assert.equal(s.prompts.length, MAX_ATTEMPTS, "3 takes + 1 retry = 4 builders, never more")
  assert.equal(r.attempts, MAX_ATTEMPTS)
  assert.match(s.prompts[3].prompt, /None of the 3 takes passed\. The files are as take \d \(\S+\) left them/)
  const two = setup({ explore: 2, values: [fail("a"), fail("b"), fail("c"), fail("d"), fail("e")] })
  assert.equal((await two.step()).status, "blocked")
  assert.equal(two.prompts.length, MAX_ATTEMPTS)
})

test("WT-EXP-03: the kept take's files are byte-equal to its snapshot; the others stay in kriya undo --list", async () => {
  const s = setup({ explore: 3, values: [pass("one"), pass("two"), pass("three")], pick: async (survivors) => (assert.deepEqual(survivors.map((t) => t.v), [1, 2, 3]), 2) })
  const r = await s.step()
  assert.equal(r.status, "pass")
  assert.deepEqual(r.explore.kept, 2)
  assert.equal(r.explore.by, "person")
  assert.equal(readFileSync(join(s.dir, "value.js"), "utf8"), 'module.exports = {"name":"two","ok":true}\n')
  const root = (await trackedRoot(s.dir)).root
  const kept = readProgress(root, "s1").explore[0].takes.find((t) => t.take === 2).tree
  assert.equal(await snapshot(root), kept, "the working tree is the take's snapshot exactly")
  const labels = (await listCheckpoints(root)).map((c) => c.label)
  for (const v of [1, 2, 3]) assert.ok(labels.some((l) => new RegExp(`^explore take ${v} of step 1: `).test(l)), labels.join(" | "))
  // The step's last run is the kept take's, a pass
  assert.equal(readProgress(root, "s1").runs.at(-1).status, "pass")
  assert.equal(s.prompts.length, 3, "no polish: takes stay inside the bound")
})

test("WT-EXP-04: no pick: the critic's first; no critic: take order; a failed take is never offered", async () => {
  const critic = setup({ explore: 3, values: [pass("one"), fail("two"), pass("three")], rank: async (survivors) => (assert.deepEqual(survivors.map((t) => t.v), [1, 3]), [3, 1]) })
  const r = await critic.step()
  assert.deepEqual([r.explore.kept, r.explore.by], [3, "critic"])
  assert.equal(readFileSync(join(critic.dir, "value.js"), "utf8"), 'module.exports = {"name":"three","ok":true}\n')
  const order = setup({ explore: 2, values: [pass("one"), pass("two")], pick: async () => undefined })
  const o = await order.step()
  assert.deepEqual([o.explore.kept, o.explore.by], [1, "order"])
  const only = setup({ explore: 3, values: [fail("one"), pass("two"), fail("three")] })
  const one = await only.step()
  assert.deepEqual([one.status, one.explore.kept, one.explore.by], ["pass", 2, "only"])
  // The Explore card: only a selected "Take n" counts; no UI is no answer
  const survivors = [{ v: 1, hint: { text: "a" } }, { v: 3, hint: { text: "b" } }]
  const exec = { agent: {}, signal: new AbortController().signal }
  assert.equal(await askTake({ ask: async () => ({ answers: [{ id: "kriya-explore", selected: ["Take 3"] }] }) }, exec, survivors, "Hero"), 3)
  assert.equal(await askTake(undefined, exec, survivors, "Hero"), undefined)
  assert.equal(await askTake({ ask: async () => ({ answers: [{ id: "kriya-explore", selected: ["Take 2"] }] }) }, exec, survivors, "Hero"), undefined, "not a passing take")
  assert.deepEqual(takeQuestion(survivors, "Hero").options.map((o) => o.label), ["Take 1", "Take 3"])
})

test("WT-EXP-05: Read only refuses to explore and builds nothing", async () => {
  const s = setup({ explore: 2, values: [pass("one")], readOnly: true })
  await assert.rejects(s.step(), /Read only mode can't explore/)
  assert.equal(s.prompts.length, 0)
})

test("WT-EXP-06: each take waits for the dev server to reload; a server that never does leaves the step not checked", async () => {
  // waitForReload: a changed ETag is a reload; an unchanged one times out
  let calls = 0
  const fetchImpl = async () => ({ headers: new Headers({ etag: ++calls > 3 ? '"v2"' : '"v1"' }), arrayBuffer: async () => new ArrayBuffer(0) })
  let t = 0
  const clock = { now: () => t, sleep: async (ms) => void (t += ms) }
  assert.deepEqual(await waitForReload("http://127.0.0.1:1/", 'h:"v1"', { fetchImpl, ...clock }), { ok: true })
  t = 0
  const stuck = async () => ({ headers: new Headers({ etag: '"v1"' }), arrayBuffer: async () => new ArrayBuffer(0) })
  assert.deepEqual(await waitForReload("http://127.0.0.1:1/", 'h:"v1"', { fetchImpl: stuck, ...clock }), { ok: false, reason: "dev server didn't reload" })
  assert.equal(t >= 20_000, true)
  // In a step: no take is checked, no check run is recorded, and no retry is spent
  const s = setup({ explore: 2, values: [pass("one"), pass("two")], served: async () => "x", reloaded: async () => ({ ok: false, reason: "dev server didn't reload" }) })
  const r = await s.step()
  assert.equal(r.status, "not checked")
  assert.match(r.note, /Take 1 wasn't checked: dev server didn't reload/)
  assert.equal(readProgress((await trackedRoot(s.dir)).root, "s1").runs.length, 0)
  assert.equal(s.prompts.length, 2)
})

test("WT-EXP-07: each take gets its own direction, chosen by code from the contract and its neighbours", async () => {
  const root = mkdtempSync(join(tmpdir(), "kriya-dir-"))
  mkdirSync(join(root, ".kriya", "contracts"), { recursive: true })
  writeFileSync(join(root, ".kriya", "contracts", "scene_direction.json"), JSON.stringify({ lighting: "night-neon" }))
  assert.deepEqual(directionHints("graphics", 3, root).map((h) => h.id), ["night-neon", "soft-clay", "daylight-exterior"])
  assert.deepEqual(directionHints("frontend", 3, root).map((h) => h.id), ["editorial", "precise", "bold"])
  writeFileSync(join(root, ".kriya", "contracts", "design_tokens.json"), JSON.stringify({ direction: "bold" }))
  assert.deepEqual(directionHints("designer", 2, root).map((h) => h.id), ["bold", "editorial"])
  const s = setup({ explore: 3, values: [pass("one"), pass("two"), pass("three")], pick: async () => 1 })
  await s.step()
  const hints = directionHints("graphics", 3, s.dir)
  s.prompts.forEach((p, i) => {
    assert.match(p.prompt, new RegExp(`## This is take ${i + 1} of 3`))
    assert.ok(p.prompt.includes(hints[i].text), `take ${i + 1} has its own direction`)
    assert.match(p.label, new RegExp(`\\(take ${i + 1} of 3\\)$`))
  })
  assert.equal(new Set(s.prompts.map((p) => p.prompt)).size, 3)
})
