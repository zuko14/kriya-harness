import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { askCheck, stepTool } from "../plugins/loop/index.js"
import { syncedFolder, tierNote } from "../src/doctor.js"
import { startGatewayProxy } from "../src/gateway-proxy.js"
import { runStep, savePlan } from "../src/loop.js"
import { confirmedCheck, currentVerdict, normalStep, verifyStep } from "../src/verify.js"
import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"

// The tool failures of a real long task (a Three.js scene built in
// ~/Documents, 2026-11-06), each reproduced on the real pinned DSH with a
// scripted model. Nothing leaves this machine.

function kriya(args, cwd) {
  const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), ...args], { cwd, env: process.env })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (d) => (stdout += d))
  child.stderr.on("data", (d) => (stderr += d))
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 200_000)
    child.on("exit", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

const call = (name, args) => ({ toolCall: { name, args } })
const toolTexts = (body) => body.messages.filter((m) => m.role === "tool").map((m) => JSON.stringify(m.content))

/** A signed-in project; `chat` scripts the agent, `then` is what its tool results said */
async function agent(script, files = {}) {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-tools-")))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  let last = []
  const fake = await startFakeKriya({
    approveAfter: 0,
    models: ["budget"],
    ...script,
    chat(body) {
      if (!body.tools?.length) return { content: "Title" }
      last = toolTexts(body)
      return script.chat(body, last.length, dir)
    },
  })
  const login = await kriya(["login", "--url", fake.url, "--no-browser"], ROOT)
  assert.equal(login.code, 0, login.stderr)
  const run = await kriya(["run", "--mode", "auto", "Do the task"], dir)
  await fake.close()
  return { dir, run, results: () => last, fake }
}

const PREMORTEM = {
  failures: [
    { what: "a null value crashes the reader", covered_by: "test/reader.test.js" },
    { what: "the export renames and the importer breaks", covered_by: "test/export.test.js" },
  ],
  blast_radius: ["the scene module"],
  negatives: ["an empty list"],
}
const PLAN = {
  goal: "Build the scene from nothing",
  kind: "feature_dag",
  steps: [
    { title: "Scaffold the app", done_when: "npm run build exits 0" },
    { title: "Add the ocean", done_when: "the ocean renders" },
  ],
  premortem: PREMORTEM,
}

test("TF-01: a plan in an empty folder is recorded, not refused as 'not lossless JSON' with a plan slot spent", { timeout: 240_000 }, async () => {
  const { run, results } = await agent({
    chat: (_body, done) => (done === 0 ? call("kriya_plan", PLAN) : { content: "Planned." }),
  })
  assert.equal(run.code, 0, run.stderr)
  assert.match(results()[0], /Plan recorded \(2 steps\)/)
  assert.doesNotMatch(results()[0], /invalid output/)
})

test("TF-02: a file whose metadata alone changed after a read can be edited (iCloud bumps ctime, not the content)", { timeout: 240_000 }, async () => {
  const { dir, run, results } = await agent(
    {
      chat(_body, done, cwd) {
        if (done === 0) return call("read", { file_path: join(cwd, "app.js") })
        if (done === 1) {
          chmodSync(join(cwd, "app.js"), 0o640)
          return call("edit", { file_path: join(cwd, "app.js"), old_string: "one", new_string: "two" })
        }
        return { content: "Edited." }
      },
    },
    { "app.js": "export const a = 'one'\n" }
  )
  assert.equal(run.code, 0, run.stderr)
  assert.doesNotMatch(results()[1], /changed since it was read/)
  assert.equal(readFileSync(join(dir, "app.js"), "utf8"), "export const a = 'two'\n")
})

test("TF-03: an overwrite after a metadata-only change goes through too", { timeout: 240_000 }, async () => {
  const { dir, run, results } = await agent(
    {
      chat(_body, done, cwd) {
        if (done === 0) return call("read", { file_path: join(cwd, "app.js") })
        if (done === 1) {
          chmodSync(join(cwd, "app.js"), 0o640)
          return call("write", { file_path: join(cwd, "app.js"), content: "export const b = 2\n" })
        }
        return { content: "Written." }
      },
    },
    { "app.js": "export const a = 1\n" }
  )
  assert.equal(run.code, 0, run.stderr)
  assert.doesNotMatch(results()[1], /changed since it was read/)
  assert.equal(readFileSync(join(dir, "app.js"), "utf8"), "export const b = 2\n")
})

test("TF-04: a real change after a read is still refused, so nothing is overwritten blind", { timeout: 240_000 }, async () => {
  const { dir, run, results } = await agent(
    {
      chat(_body, done, cwd) {
        if (done === 0) return call("read", { file_path: join(cwd, "app.js") })
        if (done === 1) {
          writeFileSync(join(cwd, "app.js"), "export const a = 'one', other = 'someone else'\n")
          return call("edit", { file_path: join(cwd, "app.js"), old_string: "one", new_string: "two" })
        }
        return { content: "Stopped." }
      },
    },
    { "app.js": "export const a = 'one'\n" }
  )
  assert.equal(run.code, 0, run.stderr)
  assert.match(results()[1], /changed since it was read/)
  assert.equal(readFileSync(join(dir, "app.js"), "utf8"), "export const a = 'one', other = 'someone else'\n")
})

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64")
const looking = (_body, done, cwd) => {
  if (done === 0) {
    writeFileSync(join(cwd, "shot.png"), PNG)
    return call("read_image", { file_path: join(cwd, "shot.png") })
  }
  return { content: "Looked." }
}

test("TF-05: a tier Kriya says takes images really gets the image", { timeout: 240_000 }, async () => {
  let sent = ""
  const { run, results } = await agent({
    modelLimits: { budget: { images: true } },
    chat(body, done, cwd) {
      if (done === 1) sent = JSON.stringify(body.messages)
      return looking(body, done, cwd)
    },
  })
  assert.equal(run.code, 0, run.stderr)
  assert.doesNotMatch(results()[0], /does not declare image input/)
  assert.match(sent, /data:image\/png;base64/)
})

test("TF-06: a tier Kriya doesn't say takes images stays text only: the tool says so and no image is sent", { timeout: 240_000 }, async () => {
  const { run, results } = await agent({ chat: looking })
  assert.equal(run.code, 0, run.stderr)
  assert.match(results()[0], /does not declare image input/)
})

test("TF-07: the model's own wording of a step label is cleaned, not refused", () => {
  assert.equal(normalStep("6 animate ship, bloom and procedural audio"), "6 animate ship bloom and procedural audio")
  assert.equal(normalStep("1 scaffold Vite + Three.js with cinematic HUD"), "1 scaffold Vite Three.js with cinematic HUD")
  assert.equal(normalStep("x".repeat(200)).length, 80)
  assert.equal(normalStep(",,,"), "all", "nothing left is the whole-project label")
  assert.equal(normalStep(undefined), "all")
})

test("TF-08: pressing Stop during a step reads as stopped, never as [object Object]", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-stop-")))
  savePlan(dir, "s1", { goal: "A goal", steps: [{ title: "Only step", done_when: "It is done" }] })
  const tool = stepTool({
    isBuilder: () => false,
    cwd: async () => dir,
    checked: () => null,
    spawn: () => Promise.reject({ kind: "user" }),
    verify: async () => ({}),
  })
  await assert.rejects(tool.execute({ step: 1 }, { agent: { id: "s1" } }), (e) => e instanceof Error && !/object Object/.test(e.message))
})

test("TF-09: a dropped connection is logged with its reason, not a bare TypeError", async () => {
  const up = createServer((req) => req.socket.destroy())
  await new Promise((done) => up.listen(0, "127.0.0.1", done))
  const logs = []
  const relay = await startGatewayProxy({ target: `http://127.0.0.1:${up.address().port}`, encode: false, log: (t) => logs.push(t) })
  await fetch(`${relay.url}/api/harness/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    .then((r) => r.text())
    .catch(() => {})
  await relay.close()
  await new Promise((done) => up.close(done))
  assert.equal(logs.length, 1)
  assert.doesNotMatch(logs[0], /TypeError/)
  assert.match(logs[0], /connection to Kriya dropped \([A-Z_]+\); retrying/)
})

// What a real step needs: a builder, the real verify step with a scripted command, the check the project offers
function project(exit = () => 0) {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-new-")))
  savePlan(dir, "s1", { goal: "Build it from nothing", steps: [{ title: "Scaffold", done_when: "It builds" }, { title: "Add the ocean", done_when: "It renders" }] })
  let runs = 0
  const step = (n, pickCheck, found = [{ command: "npm run build", source: "package.json" }]) =>
    runStep({
      cwd: dir,
      sessionId: "s1",
      n,
      hasCheck: Boolean(confirmedCheck(dir)),
      spawn: async () => ({ output: [], stopReason: "completed" }),
      verify: async (label) => {
        if (!confirmedCheck(dir)) return { status: "not configured", step: label, suggestions: found }
        return verifyStep({ cwd: dir, sessionId: "s1", step: label, run: async () => ({ exitCode: exit(++runs), timedOut: false, output: "" }) })
      },
      ...(pickCheck && { pickCheck }),
    })
  return { dir, step }
}

test("TF-10: a from-scratch project: the person picks the check the step just created, and the step is judged by it", async () => {
  const { dir, step } = project()
  const result = await step(1, async (found) => found[0].command)
  assert.equal(result.status, "pass")
  assert.equal(confirmedCheck(dir).command, "npm run build")
})

test("TF-11: a failing check found this way goes back to a builder, as any check does", async () => {
  const { step } = project((run) => (run === 1 ? 1 : 0))
  const result = await step(1, async (found) => found[0].command)
  assert.equal(result.status, "pass")
  assert.equal(result.builders.length, 2)
})

test("TF-12: no answer leaves the step not checked, and the person is asked once, not at every step", async () => {
  const { dir, step } = project()
  let asked = 0
  const quiet = async () => void asked++
  assert.equal((await step(1, quiet)).status, "not checked")
  assert.equal((await step(2, quiet)).status, "not checked")
  assert.equal(asked, 1)
  assert.equal(confirmedCheck(dir), undefined)
})

test("TF-13: with nothing to offer yet nothing is asked, and the next step asks; the step built before it is then judged too", async () => {
  const { dir, step } = project()
  let asked = 0
  const pick = async (found) => (asked++, found[0].command)
  assert.equal((await step(1, pick, [])).status, "not checked")
  assert.equal(asked, 0)
  assert.equal((await step(2, pick)).status, "pass")
  assert.equal(asked, 1)
  assert.equal((await currentVerdict(dir, "s1", async () => null)).status, "verified")
})

test("TF-14: only an offered command the person selected counts", async () => {
  const found = [{ command: "npm test", source: "package.json" }]
  const exec = { agent: {}, signal: new AbortController().signal }
  const answering = (item) => ({ ask: async (request) => ((answering.seen = request), { answers: [{ id: "kriya-check", ...item }] }) })
  assert.equal(await askCheck(answering({ selected: ["npm test"] }), exec, found), "npm test")
  assert.match(answering.seen.questions[0].options.map((o) => o.label).join(), /npm test/)
  assert.equal(await askCheck(answering({ selected: ["Not now"] }), exec, found), undefined)
  assert.equal(await askCheck(answering({ selected: ["rm -rf ."] }), exec, found), undefined)
  assert.equal(await askCheck(answering({ selected: [], custom: "exit 0" }), exec, found), undefined, "a typed check stays kriya verify use")
  assert.equal(await askCheck({ ask: () => Promise.reject(new Error("no user-questions answerer")) }, exec, found), undefined, "no Web UI: no question")
  assert.equal(await askCheck(undefined, exec, found), undefined)
})

const down = (code) => Object.assign(new TypeError("fetch failed"), { cause: { code } })
async function through(fetchImpl, options = {}) {
  const logs = []
  let t = 0
  const relay = await startGatewayProxy({ target: "http://kriya.test", encode: false, fetchImpl, log: (l) => logs.push(l), now: () => (t += 1000), retryMs: 1, outageWaitMs: 1, ...options })
  const res = await fetch(`${relay.url}/api/harness/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
  const text = await res.text()
  await relay.close()
  return { status: res.status, text, logs }
}

test("TF-15: an outage is waited out: a request that couldn't connect goes through when the network is back", async () => {
  let tries = 0
  const { status, logs } = await through(async () => {
    if (++tries < 4) throw down("ENOTFOUND")
    return new Response("{}", { status: 200 })
  })
  assert.equal(status, 200)
  assert.equal(tries, 4)
  assert.equal(logs.length, 2, "one line when it starts, one when it's over")
  assert.match(logs[0], /can't reach Kriya \(ENOTFOUND\); waiting/)
})

test("TF-16: an outage longer than the wait is reported, so DSH's own retries take over", async () => {
  const { status } = await through(async () => {
    throw down("UND_ERR_CONNECT_TIMEOUT")
  }, { outageMs: 3000 })
  assert.equal(status, 502)
})

test("TF-17: a dead pooled connection is tried once more at once, and only once: the request may have reached Kriya", async () => {
  let tries = 0
  assert.equal((await through(async () => (++tries === 1 ? Promise.reject(down("ECONNRESET")) : new Response("{}")))).status, 200)
  assert.equal(tries, 2)
  tries = 0
  assert.equal((await through(async () => (tries++, Promise.reject(down("EPIPE"))))).status, 502)
  assert.equal(tries, 2)
})

test("TF-18: a stream cut mid-answer is logged; the person's own hang-up isn't", { timeout: 20_000 }, async (t) => {
  const up = createServer((req, res) => {
    req.resume()
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write("data: {}\n\n", () => setTimeout(() => res.destroy(), 20))
  })
  await new Promise((done) => up.listen(0, "127.0.0.1", done))
  const logs = []
  const relay = await startGatewayProxy({ target: `http://127.0.0.1:${up.address().port}`, encode: false, log: (l) => logs.push(l) })
  t.after(async () => {
    await relay.close()
    await new Promise((done) => up.close(done))
  })
  const post = (signal) => fetch(`${relay.url}/api/harness/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal })
  await (await post()).text().catch(() => {})
  for (let i = 0; i < 100 && !logs.length; i++) await new Promise((done) => setTimeout(done, 10))
  assert.equal(logs.length, 1)
  assert.match(logs[0], /connection to Kriya dropped \(UND_ERR_SOCKET\)/)
  const gone = new AbortController()
  const reading = await post(gone.signal)
  gone.abort()
  await reading.text().catch(() => {})
  await new Promise((done) => setTimeout(done, 80))
  assert.equal(logs.length, 1)
})

test("TF-19: a read of a long file returns a page with what's left, not a refusal", { timeout: 240_000 }, async () => {
  const lines = Array.from({ length: 900 }, (_, i) => `const line${i + 1} = ${i + 1}`).join("\n")
  const { run, results } = await agent(
    { chat: (_body, done, cwd) => (done === 0 ? call("read", { file_path: join(cwd, "big.js") }) : { content: "Read." }) },
    { "big.js": `${lines}\n` }
  )
  assert.equal(run.code, 0, run.stderr)
  assert.doesNotMatch(results()[0], /^"Error/)
  assert.match(results()[0], /line400 /)
  assert.doesNotMatch(results()[0], /line401 /)
})

test("TF-20: the doctor names a synced folder and a set of tiers that can't step up", () => {
  assert.match(syncedFolder("/Users/a/Documents/app", "/Users/a", true), /iCloud/)
  assert.equal(syncedFolder("/Users/a/Documents/app", "/Users/a", false), undefined)
  assert.equal(syncedFolder("/Users/a/Developer/app", "/Users/a", true), undefined)
  assert.match(syncedFolder("/Users/a/Library/Mobile Documents/com~apple~CloudDocs/app", "/Users/a", false), /iCloud/)
  assert.match(syncedFolder("/Users/a/Library/CloudStorage/Dropbox/app", "/Users/a", false), /synced/)
  assert.match(tierNote([{ id: "budget", name: "M" }, { id: "escalation", name: "M" }]), /one model \(M\)/)
  assert.equal(tierNote([{ id: "budget", name: "M" }, { id: "escalation", name: "N" }]), undefined)
  assert.equal(tierNote([{ id: "budget", name: "M" }]), undefined)
})
