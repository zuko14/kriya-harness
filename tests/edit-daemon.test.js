import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { MAX_RUNNING, offeredProjects, runDaemon } from "../src/daemon.js"
import { readDevice } from "../src/store.js"
import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"

// ET-DMN-01…05 and the daemon's half of ET-REG-01 and -03: the daemon only hands an edit
// over. The Host is a stand-in here; the real one is in edit-tavi and the media suite.

const JOB = "11111111-1111-4111-8111-111111111111"

async function setup(script = {}) {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-edit-daemon-")))
  mkdirSync(join(dir, ".git"))
  const fake = await startFakeKriya({ approveAfter: 0, editing: true, ...script })
  const login = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "login", "--url", fake.url, "--no-browser"], { stdio: "ignore" })
  assert.equal(await new Promise((done) => login.on("exit", done)), 0)
  const [project] = offeredProjects([dir])
  const handed = []
  const cancels = []
  const editHost = {
    hand: async (job) => handed.push(job),
    cancel: async ({ dispatch }) => (cancels.push(dispatch), { known: handed.some((j) => j.dispatch === dispatch) }),
  }
  const once = (options = {}) => runDaemon({ device: readDevice(), folders: [dir], once: true, log: () => {}, env: { KRIYA_EDIT: "on" }, allowEdit: true, editHost, ...options })
  const edit = () => fake.queue("edit", { project: project.id, job: JOB, brief: "Cut a reel", effort: "best" })
  return { dir, fake, project, once, edit, handed, cancels }
}
const reports = (fake, id) => fake.state.reports?.filter((r) => r.id === id) ?? []
const settle = () => new Promise((done) => setTimeout(done, 30))

test("ET-DMN-01: an edit never enters running, so the person's tasks still start", async () => {
  const { fake, once, edit, handed, project } = await setup()
  const id = edit()
  await once()
  assert.deepEqual(reports(fake, id).map((r) => r.status), ["running"])
  assert.equal(handed.length, 1)
  assert.equal(handed[0].dispatch, id)
  assert.equal(handed[0].brief, "Cut a reel")
  assert.match(handed[0].folder, /kriya-edit-daemon-/)

  // MAX_RUNNING is the person's own count: a task isn't refused for the edit in the Host
  const run = fake.queue("run", { project: project.id, prompt: "x", mode: "full", switches: {} })
  await once()
  assert.equal(MAX_RUNNING, 2)
  assert.doesNotMatch(reports(fake, run)[0].result.error, /already running/)
  await fake.close()
})

test("ET-DMN-02: the capability needs the switch, the allowance and the manifest's 200 (EH-01)", async () => {
  const on = await setup()
  await on.once()
  assert.equal(on.fake.state.hello.capabilities.edit, true)
  await on.fake.close()

  // An older server: 404, no new field, and everything else as before
  const old = await setup({ editing: false })
  await old.once()
  assert.deepEqual(old.fake.state.hello.capabilities, { fullAccess: false, serve: false, handoff: true })
  const refused = old.edit()
  await old.once()
  assert.deepEqual(reports(old.fake, refused).map((r) => [r.status, r.result?.code]), [["failed", "not_allowed"]])
  assert.equal(old.handed.length, 0)
  await old.fake.close()

  // Without the allowance it doesn't even ask
  const notAllowed = await setup()
  await notAllowed.once({ allowEdit: false })
  assert.deepEqual(notAllowed.fake.state.hello.capabilities, { fullAccess: false, serve: false, handoff: true })
  assert.ok(!notAllowed.fake.state.requests.some((r) => r.path === "/editing/manifest"))
  await notAllowed.fake.close()
})

test("ET-DMN-03: the cancel goes to the Host first, and serving survives it", async () => {
  const { dir, fake, project, edit } = await setup()
  const serve = fake.queue("serve_start", { project: project.id })
  const proxies = []
  const cancels = []
  const stop = new AbortController()
  const fakeBin = join(dir, "fake-kriya-bin.js")
  writeFileSync(fakeBin, "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)\n")
  const done = runDaemon({
    device: readDevice(),
    folders: [dir],
    log: () => {},
    signal: stop.signal,
    allowServe: true,
    allowEdit: true,
    env: { KRIYA_EDIT: "on" },
    kriya: { node: process.execPath, bin: fakeBin },
    editHost: { hand: async (job) => proxies.push(job), cancel: async ({ dispatch }) => (cancels.push(dispatch), { known: true }) },
  })
  const until = async (check) => {
    for (let i = 0; i < 400 && !check(); i++) await settle()
    assert.ok(check())
  }
  await until(() => reports(fake, serve).some((r) => r.status === "running"))
  const id = edit()
  await until(() => proxies.length === 1)
  fake.state.dispatches.find((d) => d.id === id).status = "canceling"
  await until(() => cancels.includes(id))
  await settle()
  assert.ok(!reports(fake, serve).some((r) => r.status === "done"), "kriya serve wasn't stopped")
  // The Host reports the end itself; the daemon said nothing for it
  assert.ok(!reports(fake, id).some((r) => r.status === "canceled"))
  fake.state.dispatches.find((d) => d.id === id).status = "canceled"
  stop.abort()
  await done
  await fake.close()
})

test("ET-DMN-04: a job nobody knows is closed at once, so the poll can't run hot", async () => {
  const { fake, once, cancels } = await setup()
  const lost = "22222222-2222-4222-8222-222222222222"
  ;(fake.state.dispatches ??= []).push({ id: lost, kind: "edit", payload: {}, status: "canceling" })
  await once()
  await settle()
  assert.deepEqual(cancels, [lost])
  assert.deepEqual(reports(fake, lost).map((r) => r.status), ["canceled"])
  assert.equal(fake.state.dispatches.find((d) => d.id === lost).status, "canceled")

  // The Host not running at all is the same answer
  const gone = "33333333-3333-4333-8333-333333333333"
  fake.state.dispatches.push({ id: gone, kind: "edit", payload: {}, status: "canceling" })
  await once({ editHost: { hand: async () => {}, cancel: async () => { throw new Error("no socket") } } })
  await settle()
  assert.deepEqual(reports(fake, gone).map((r) => r.status), ["canceled"])
  await fake.close()
})

test("ET-DMN-05: control.update keeps and changes the capability; the daemon never kills the Host", async () => {
  const { dir, fake, edit } = await setup()
  const control = {}
  const stop = new AbortController()
  const handed = []
  const done = runDaemon({ device: readDevice(), folders: [dir], log: () => {}, signal: stop.signal, control, allowEdit: true, env: { KRIYA_EDIT: "on" }, editHost: { hand: async (job) => handed.push(job), cancel: async () => ({ known: false }) } })
  for (let i = 0; i < 400 && !fake.state.hello; i++) await settle()
  assert.equal(fake.state.hello.capabilities.edit, true)
  await control.update({ folders: [dir], allowEdit: true, allowServe: true })
  assert.equal(fake.state.hello.capabilities.edit, true, "an update with it on keeps it")
  assert.equal(fake.state.hello.capabilities.serve, true)
  await control.update({ folders: [dir], allowEdit: false })
  assert.equal("edit" in fake.state.hello.capabilities, false)
  await control.update({ folders: [dir], allowEdit: true })
  assert.equal(fake.state.hello.capabilities.edit, true)
  const id = edit()
  for (let i = 0; i < 400 && !handed.length; i++) await settle()
  stop.abort()
  await done
  // Nothing was sent for the job on the way out: it's the Host's now (EH-05)
  assert.deepEqual(reports(fake, id).map((r) => r.status), ["running"])
  await fake.close()
})

test("ET-REG-01, -03: with KRIYA_EDIT off the daemon is what it was", async () => {
  const { fake, once, project, cancels } = await setup()
  // Even with the flag: no request, no field
  await once({ env: {}, allowEdit: true })
  assert.deepEqual(fake.state.hello.capabilities, { fullAccess: false, serve: false, handoff: true })
  assert.ok(!fake.state.requests.some((r) => r.path.startsWith("/editing")))
  // A cancel of an unknown id takes the old path: nothing to the Host, nothing reported
  const unknown = "44444444-4444-4444-8444-444444444444"
  ;(fake.state.dispatches ??= []).push({ id: unknown, kind: "run", payload: {}, status: "canceling" })
  await once({ env: {}, allowEdit: true })
  await settle()
  assert.deepEqual(cancels, [])
  assert.deepEqual(reports(fake, unknown), [])
  // An edit that reached it anyway is refused
  fake.state.dispatches.pop()
  const id = fake.queue("edit", { project: project.id, job: JOB, brief: "x", effort: "best" })
  await once({ env: {}, allowEdit: true })
  assert.deepEqual(reports(fake, id).map((r) => r.result?.code), ["not_allowed"])
  await fake.close()
})

test("the daemon hands over a revision's fields, and wakes the Host for watched folders", async () => {
  const { fake, once, handed, project } = await setup()
  let woke = 0
  const editHost = { hand: async (job) => handed.push(job), cancel: async () => ({ known: false }), wake: async () => woke++ }
  const parent = "55555555-5555-4555-8555-555555555555"
  fake.queue("edit", { project: project.id, job: JOB, brief: "Cut a reel", effort: "best", revisionOf: parent, change: "Tighter" })
  await once({ editHost })
  assert.equal(handed[0].revisionOf, parent)
  assert.equal(handed[0].change, "Tighter")
  assert.ok(woke > 0)
  // A wake that fails costs the daemon nothing
  await once({ editHost: { ...editHost, wake: async () => { throw new Error("no") } } })
  await fake.close()
})
