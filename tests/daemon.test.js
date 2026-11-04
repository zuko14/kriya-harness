import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { broadcastRun, LAUNCHD_LABEL, offeredProjects, projectId, projectRules, runArgs, serviceDefinition } from "../src/daemon.js"
import { freshHome } from "./helpers.js"

// `kriya daemon` (the Control Center), CC-D-*: what this computer offers and
// accepts is decided here; tasks become `kriya run` flags; the terminal
// tells Kriya what runs without the task.

test("CC-D-01: only real folders the person offered; never home or a drive root; ids from the real path", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kriya-daemon-home-")))
  const app = join(home, "Developer", "app")
  mkdirSync(join(app, ".git"), { recursive: true })
  const notes = join(home, "notes")
  mkdirSync(notes)
  writeFileSync(join(home, "file.txt"), "x")
  const offered = offeredProjects([app, notes, app, home, "/", join(home, "missing"), join(home, "file.txt")], home)
  assert.deepEqual(
    offered.map((p) => [p.name, p.shown, p.git]),
    [["app", "~/Developer/app", true], ["notes", "~/notes", false]]
  )
  assert.equal(offered[0].id, projectId(app))
  assert.match(offered[0].id, /^[a-f0-9]{16}$/)
})

test("CC-D-02: a task becomes kriya run flags exactly; the prompt is one argument", () => {
  const prompt = 'fix it; rm -rf / && echo "$(whoami)"'
  assert.deepEqual(runArgs({ mode: "auto", prompt, switches: { loopV2: true, budget: false, anchor: true, browser: false } }), [
    "run",
    "--mode",
    "auto",
    "--loop-v2",
    "--no-budget",
    "--anchor",
    "--no-browser-tools",
    prompt,
  ])
  assert.deepEqual(runArgs({ mode: "plan", prompt: "p", switches: { loopV2: false, budget: true, anchor: false, browser: true } }), ["run", "--mode", "plan", "p"])
})

test("CC-D-03: a folder's rules are listed by number, proposed and confirmed", async () => {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-daemon-rules-")))
  mkdirSync(join(dir, ".git"))
  const { noteFailure, confirmRule } = await import("../src/rules.js")
  const { projectRoot } = await import("../src/skill-switches.js")
  for (let i = 0; i < 2; i++) noteFailure(projectRoot(dir), "npm test", { kind: "environment", excerpt: "Cannot find module 'x'" })
  for (let i = 0; i < 2; i++) noteFailure(projectRoot(dir), "npm test", { kind: "timeout", excerpt: "timed out" })
  const [p] = offeredProjects([dir])
  let rules = projectRules([p])
  assert.deepEqual(rules.map((r) => [r.n, r.status]), [[1, "proposed"], [2, "proposed"]])
  confirmRule(dir, 1)
  rules = projectRules([p])
  assert.deepEqual(rules.map((r) => [r.n, r.status]), [[1, "proposed"], [1, "confirmed"]])
  assert.ok(rules.every((r) => r.project === p.id && r.text.length > 0))
})

test("CC-D-04: kriya daemon install writes a launchd agent or a systemd user unit with the given folders and flags", () => {
  const mac = serviceDefinition({ platform: "darwin", home: "/Users/a", node: "/usr/bin/node", bin: "/opt/kriya/bin/kriya.js", args: ["--folder", "/Users/a/My <App> & Co", "--allow-serve"] })
  assert.equal(mac.path, `/Users/a/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`)
  assert.match(mac.content, /<string>\/opt\/kriya\/bin\/kriya\.js<\/string>\s*<string>daemon<\/string>/)
  assert.match(mac.content, /My &lt;App&gt; &amp; Co/)
  assert.match(mac.content, /<key>KeepAlive<\/key><true\/>/)
  assert.deepEqual(mac.start, [["launchctl", "load", "-w", mac.path]])
  const linux = serviceDefinition({ platform: "linux", home: "/home/a", node: "/usr/bin/node", bin: "/opt/kriya/bin/kriya.js", args: ["--folder", "/home/a/my app"] })
  assert.equal(linux.path, "/home/a/.config/systemd/user/kriya-daemon.service")
  assert.match(linux.content, /ExecStart=\/usr\/bin\/node \/opt\/kriya\/bin\/kriya\.js daemon --folder "\/home\/a\/my app"/)
  assert.equal(serviceDefinition({ platform: "win32", bin: "x", args: [] }), null)
})

test("CC-D-05: the terminal tells Kriya what runs, never the task; a dispatch id links it; off is silent", async () => {
  const sent = []
  const fetchCall = async (_url, method, path, { body }) => sent.push({ method, path, body })
  const device = { url: "http://kriya.test", token: "t" }
  const b = broadcastRun(device, { kind: "run", mode: "auto", switches: { loop: true }, cwd: "/Users/a/Developer/app", env: {}, fetchCall })
  await b.end("completed", 0)
  assert.equal(sent.length, 2)
  assert.deepEqual(sent.map((s) => s.body.status), ["running", "completed"])
  assert.equal(sent[0].body.source, "terminal")
  assert.equal(sent[0].body.project, "app")
  assert.equal(sent[1].body.exitCode, 0)
  assert.equal(sent[0].body.localId, sent[1].body.localId)
  for (const key of Object.keys(sent[0].body)) assert.ok(["localId", "source", "kind", "mode", "switches", "project", "status"].includes(key), key)
  const id = "11111111-2222-4333-8444-555555555555"
  sent.length = 0
  await broadcastRun(device, { kind: "run", mode: "auto", switches: {}, env: { KRIYA_DISPATCH_ID: id }, fetchCall }).end("failed", 1)
  assert.equal(sent[0].body.source, "dispatch")
  assert.equal(sent[0].body.dispatchId, id)
  sent.length = 0
  await broadcastRun(device, { kind: "run", mode: "auto", switches: {}, env: { KRIYA_BROADCAST: "off" }, fetchCall }).end("completed", 0)
  await broadcastRun(null, { kind: "run", mode: "auto", switches: {}, env: {}, fetchCall }).end("completed", 0)
  assert.equal(sent.length, 0)
  // A Kriya without the Control Center (404) changes nothing
  const failing = async () => {
    throw new Error("404")
  }
  await broadcastRun(device, { kind: "app", mode: "ask", switches: {}, env: {}, fetchCall: failing }).end("completed", 0)
})

test("CC-D-06: a running process sends a heartbeat until it ends", async () => {
  const sent = []
  const fetchCall = async (_url, _method, _path, { body }) => sent.push(body.status)
  const b = broadcastRun({ url: "http://kriya.test", token: "t" }, { kind: "run", mode: "auto", switches: {}, env: {}, fetchCall, heartbeatMs: 20 })
  await new Promise((wake) => setTimeout(wake, 75))
  await b.end("completed", 0)
  const beats = sent.filter((s) => s === "running").length
  assert.ok(beats >= 3, `beats: ${beats}`)
  const after = sent.length
  await new Promise((wake) => setTimeout(wake, 60))
  assert.equal(sent.length, after, "no heartbeat after the end")
  assert.equal(sent.at(-1), "completed")
})
