import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, realpathSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { kriyaIndex } from "../plugins/brand/index.js"
import { rebrand } from "../src/launch.js"
import { writeDevice } from "../src/store.js"
import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"

// KB-* (owner, 2026-11-06: "completely this was a Kriya harness product"):
// what a person sees says Kriya Harness: the terminal lines, the page title
// and the agent's own identity. DSH stays credited in --version and the
// notices (its MIT licence), which these tests leave alone.

test("KB-01: DSH's terminal lines are said as Kriya Harness; nothing else changes", () => {
  assert.equal(rebrand("dsh web: http://127.0.0.1:3080/?token=abc"), "Kriya Harness: http://127.0.0.1:3080/?token=abc")
  assert.equal(rebrand("dsh web: opening the default browser; pass --no-open to disable"), "Kriya Harness: opening your browser (kriya --no-open to skip)")
  assert.equal(rebrand("dsh: warning: 2 entries did not activate"), "kriya: warning: 2 entries did not activate")
  assert.equal(rebrand("the answer mentions dsh web: inside"), "the answer mentions dsh web: inside", "only a line's start")
  assert.equal(rebrand("kriya: already ours"), "kriya: already ours")
})

test("KB-02: the served page is titled Kriya Harness", () => {
  assert.equal(kriyaIndex("<head><title>DeepSeek Harness</title></head>"), "<head><title>Kriya Harness</title></head>")
  assert.equal(kriyaIndex("<p>no title</p>"), "<p>no title</p>")
})

function kriya(args, cwd) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), ...args], { cwd, env: process.env })
    let stderr = ""
    child.stderr.on("data", (d) => (stderr += d))
    const timer = setTimeout(() => child.kill("SIGKILL"), 150_000)
    child.on("exit", (code) => {
      clearTimeout(timer)
      done({ code, stderr })
    })
  })
}

test("KB-03: kriya run: the agent is told it is Kriya, never DeepSeek Harness, and no web-only plugin warns", { timeout: 300_000 }, async () => {
  freshHome()
  let prompt = ""
  const fake = await startFakeKriya({ approveAfter: 0, chat: (body) => (body.tools?.length && (prompt = JSON.stringify(body.messages[0])), { content: "Done." }) })
  try {
    assert.equal((await kriya(["login", "--url", fake.url, "--no-browser"], ROOT)).code, 0)
    const run = await kriya(["run", "Say done"], realpathSync(mkdtempSync(join(tmpdir(), "kriya-brand-"))))
    assert.equal(run.code, 0, run.stderr.slice(-1500))
    assert.match(prompt, /You are Kriya, a coding agent in Kriya Harness/)
    assert.doesNotMatch(prompt, /DeepSeek Harness/)
    assert.doesNotMatch(run.stderr, /did not activate|waiting for service: connection|^dsh/m)
  } finally {
    await fake.close()
  }
})

const freePort = () =>
  new Promise((done) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })

test("KB-04: the Web UI's terminal lines and page title say Kriya Harness", { timeout: 180_000 }, async () => {
  freshHome()
  const fake = await startFakeKriya()
  const port = await freePort()
  writeDevice({ url: fake.url, token: fake.issueToken(), deviceId: "11111111-2222-4333-8444-555555555555" })
  const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "--no-open", "--port", String(port)], { cwd: mkdtempSync(join(tmpdir(), "kriya-brand-ws-")), env: process.env })
  let output = ""
  child.stdout.on("data", (d) => (output += d))
  child.stderr.on("data", (d) => (output += d))
  try {
    let url = null
    for (let i = 0; i < 90 && !url; i++) {
      await new Promise((done) => setTimeout(done, 1000))
      url = /Kriya Harness: (http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+)/.exec(output)?.[1] ?? null
    }
    const shown = output.replace(/token=[\w-]+/g, "token=<token>")
    assert.ok(url, shown.slice(0, 2000))
    assert.doesNotMatch(output, /^dsh/m, shown.slice(0, 2000))
    // The token link sets the browser cookie on a redirect; carry it, as a browser would
    const first = await fetch(url, { redirect: "manual" })
    const cookie = first.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ")
    const page = await (await fetch(new URL("/", url), { headers: { cookie } })).text()
    assert.match(page, /<title>Kriya Harness<\/title>/)
    assert.doesNotMatch(page, /<title>DeepSeek Harness<\/title>/)
  } finally {
    child.kill("SIGTERM")
    await new Promise((done) => child.on("exit", done))
    await fake.close()
  }
})
