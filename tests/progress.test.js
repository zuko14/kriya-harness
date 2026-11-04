import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { answer, handler, ROUTE } from "../plugins/progress/index.js"
import { savePlan } from "../src/loop.js"
import { confirmCheck, verifyStep } from "../src/verify.js"
import { freshHome } from "./helpers.js"

// The Progress tab (plugins/progress), WP-PG-*: what the loop recorded for
// one session, from its check runs only.

const request = (session) => new Request(`http://127.0.0.1${ROUTE}${session === undefined ? "" : `?session=${encodeURIComponent(session)}`}`)

function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-progress-")))
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" })
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "t")
  writeFileSync(join(dir, "a.js"), "1\n")
  git("add", ".")
  git("commit", "-qm", "base")
  return dir
}

test("WP-PG-01: plan, step statuses, runs newest first and the verdict come from the records", async () => {
  freshHome()
  const dir = repo()
  confirmCheck(dir, "npm test")
  savePlan(dir, "s1", { goal: "Ship it", steps: [{ title: "Parse", done_when: "parser passes" }, { title: "Render", done_when: "render passes" }] })
  const run = (exitCode, output = "") => async () => ({ exitCode, timedOut: false, output })
  await verifyStep({ cwd: dir, sessionId: "s1", step: "1 Parse", run: run(1, "AssertionError: no"), v2: {} })
  await verifyStep({ cwd: dir, sessionId: "s1", step: "1 Parse", run: run(0) })
  const route = handler({ folderOf: async (id) => (id === "s1" ? dir : undefined) })
  const body = await (await answer(route, request("s1"))).json()
  assert.deepEqual(body.check, { command: "npm test", source: "kriya verify use" })
  assert.equal(body.plan.goal, "Ship it")
  assert.deepEqual(
    body.plan.steps.map((s) => [s.n, s.title, s.status, s.attempts, s.doneWhen]),
    [
      [1, "Parse", "pass", 2, "parser passes"],
      [2, "Render", "not started", 0, "render passes"],
    ]
  )
  assert.deepEqual(
    body.runs.map((r) => [r.step, r.status, r.exitCode]),
    [
      ["1 Parse", "pass", 0],
      ["1 Parse", "fail", 1],
    ]
  )
  assert.equal(body.runs[1].kind, "assertion")
  assert.deepEqual(body.verdict, { status: "verified" })
  // A change after the pass: the verdict is stale, from the files' fingerprint
  writeFileSync(join(dir, "a.js"), "2\n")
  const later = await (await answer(route, request("s1"))).json()
  assert.deepEqual(later.verdict, { status: "not checked", stale: true })
})

test("WP-PG-02: no check, no plan and no runs read as such; unknown sessions are refused", async () => {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-progress-empty-")))
  const route = handler({ folderOf: async (id) => (id === "s2" || id === "../../x" ? dir : undefined) })
  const body = await (await answer(route, request("s2"))).json()
  assert.deepEqual(body, { check: null, plan: null, earlierPlans: 0, verdict: { status: "not checked" }, runs: [] })
  assert.equal((await answer(route, request())).status, 400)
  assert.equal((await answer(route, request("nope"))).status, 400)
  // An id that can't name a progress file has no progress, rather than a 500
  assert.equal((await (await answer(route, request("../../x"))).json()).runs.length, 0)
})
