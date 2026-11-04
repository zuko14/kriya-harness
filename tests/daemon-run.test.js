import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { offeredProjects, runDaemon } from "../src/daemon.js"
import { projectRoot } from "../src/skill-switches.js"
import { noteFailure, listRules } from "../src/rules.js"
import { readDevice } from "../src/store.js"
import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"

// The Control Center end to end on the real, pinned DSH, CC-RUN-*: a task
// queued in (a fake) Kriya is claimed by `kriya daemon`, run as `kriya run`
// in the offered folder, and reported with its answer; the run tells Kriya
// what it runs, linked to the action. Refusals happen on the computer.

function kriya(args, cwd) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), ...args], { cwd, env: { ...process.env, KRIYA_LOOP: "off" } })
    let stderr = ""
    child.stderr.on("data", (d) => (stderr += d))
    child.on("exit", (code) => done({ code, stderr }))
  })
}

async function setup(chat) {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-daemon-run-")))
  mkdirSync(join(dir, ".git"))
  const fake = await startFakeKriya({ approveAfter: 0, chat })
  const login = await kriya(["login", "--url", fake.url, "--no-browser"], ROOT)
  assert.equal(login.code, 0, login.stderr)
  const [project] = offeredProjects([dir])
  const lines = []
  const once = (options = {}) => runDaemon({ device: readDevice(), folders: [dir], once: true, log: (l) => lines.push(l), ...options })
  return { dir, fake, project, once, lines }
}

const reportsOf = (fake, id) => fake.state.reports.filter((r) => r.id === id)

test("CC-RUN-01: a task from Kriya runs as kriya run in the offered folder and comes back with its answer", { timeout: 300_000 }, async () => {
  const { fake, project, once } = await setup((body) => (body.tools?.length ? { content: "Done: the laptop says hello." } : { content: "Daemon check" }))
  const id = fake.queue("run", { project: project.id, prompt: "Say hello from the laptop", mode: "auto", switches: { loopV2: false, budget: true, anchor: false, browser: false } })
  await once()
  await fake.close()
  const reports = reportsOf(fake, id)
  assert.deepEqual(reports.map((r) => r.status), ["running", "done"], JSON.stringify(reports))
  assert.equal(reports[1].result.exitCode, 0)
  assert.match(reports[1].result.answer, /the laptop says hello/)
  // The hello offered this folder and what the computer allows
  assert.deepEqual(fake.state.hello.capabilities, { fullAccess: false, serve: false, handoff: true })
  assert.deepEqual(fake.state.hello.projects.map((p) => p.id), [project.id])
  // The run told Kriya what it ran, linked to the action, without the task
  const runs = fake.state.runs.filter((r) => r.dispatchId === id)
  assert.deepEqual(runs.map((r) => r.status), ["running", "completed"])
  assert.equal(runs[0].source, "dispatch")
  assert.equal(runs[0].mode, "auto")
  assert.ok(!JSON.stringify(runs).includes("Say hello"), "no task text in the broadcast")
  // The model saw the person's task
  const asked = fake.state.requests.find((r) => r.path === "/chat/completions" && r.body?.tools?.length)
  assert.match(JSON.stringify(asked.body.messages), /Say hello from the laptop/)
})

test("CC-RUN-02: refused on the computer: Full access not allowed, a folder not offered, an unknown action", { timeout: 120_000 }, async () => {
  const { fake, project, once } = await setup(() => ({ content: "never asked" }))
  const full = fake.queue("run", { project: project.id, prompt: "x", mode: "full", switches: {} })
  await once()
  const elsewhere = fake.queue("run", { project: "0000000000000000", prompt: "x", mode: "auto", switches: {} })
  await once()
  const odd = fake.queue("format_disk", { project: project.id })
  await once()
  await fake.close()
  assert.match(reportsOf(fake, full).at(-1).result.error, /Full access from Kriya is off/)
  assert.match(reportsOf(fake, elsewhere).at(-1).result.error, /isn't offered/)
  assert.match(reportsOf(fake, odd).at(-1).result.error, /doesn't know that action/)
  for (const id of [full, elsewhere, odd]) assert.equal(reportsOf(fake, id).at(-1).status, "failed")
  assert.equal(fake.state.requests.filter((r) => r.path === "/chat/completions").length, 0, "no model call for a refusal")
})

test("CC-RUN-03: a rule decided in Kriya lands in the folder's rules; the health check reports each check", { timeout: 300_000 }, async () => {
  const { dir, fake, project, once } = await setup(() => ({ content: "ok" }))
  for (let i = 0; i < 2; i++) noteFailure(projectRoot(dir), "npm test", { kind: "environment", excerpt: "Cannot find module 'left-pad'" })
  assert.equal(listRules(dir).proposed.length, 1)
  const rule = fake.queue("rule_confirm", { project: project.id, n: 1 })
  await once()
  assert.equal(reportsOf(fake, rule).at(-1).status, "done")
  assert.deepEqual(listRules(dir), { proposed: [], confirmed: [listRules(dir).confirmed[0]] })
  assert.ok(fake.state.hello.rules.some((r) => r.status === "confirmed"), "the rules were sent again after the decision")
  const health = fake.queue("doctor", {})
  await once()
  await fake.close()
  const checks = reportsOf(fake, health).at(-1).result.checks
  assert.ok(checks.length >= 4, JSON.stringify(checks))
  assert.ok(checks.some((c) => /^Node /.test(c.name) && c.ok))
  assert.ok(checks.some((c) => /signed in to/.test(c.name)))
  assert.ok(readFileSync(join(ROOT, "package.json"), "utf8"))
})

test("CC-RUN-04: the person stops a running task in Kriya: the daemon ends it and reports canceled", { timeout: 300_000 }, async () => {
  const { fake, project } = await setup((body) => (body.tools?.length ? { content: "too late", delayMs: 120_000 } : { content: "Stop check" }))
  const id = fake.queue("run", { project: project.id, prompt: "A long job", mode: "auto", switches: { loopV2: false, budget: true, anchor: false, browser: false } })
  const stop = new AbortController()
  const daemon = runDaemon({ device: readDevice(), folders: [project.path], signal: stop.signal, log: () => {} })
  const until = async (check, ms = 60_000) => {
    const end = Date.now() + ms
    while (!check()) {
      if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(fake.state.reports)}`)
      await new Promise((wake) => setTimeout(wake, 100))
    }
  }
  await until(() => fake.state.requests.some((r) => r.path === "/chat/completions" && r.body?.tools?.length))
  // As the person's Stop in Kriya does: the action is "canceling" until its computer ends it
  fake.state.dispatches.find((d) => d.id === id).status = "canceling"
  await until(() => reportsOf(fake, id).some((r) => r.status === "canceled"))
  stop.abort()
  await daemon
  await fake.close()
  assert.deepEqual(reportsOf(fake, id).map((r) => r.status), ["running", "canceled"])
})

test("CC-RUN-05: a task that fails comes back with its reason, not just an exit code", { timeout: 300_000 }, async () => {
  const { fake, project, once } = await setup((body) => (body.tools?.length ? { error: { status: 503, error: "not_priced", message: "That model has no price yet." } } : { content: "Fail check" }))
  const id = fake.queue("run", { project: project.id, prompt: "Anything", mode: "auto", switches: { loopV2: false, budget: true, anchor: false, browser: false } })
  await once()
  await fake.close()
  const last = reportsOf(fake, id).at(-1)
  assert.equal(last.status, "failed")
  assert.notEqual(last.result.exitCode, 0)
  assert.match(last.result.answer, /not_priced|no price/, last.result.answer)
  assert.doesNotMatch(last.result.answer, /entries did not activate|pending \(waiting for service/)
})
