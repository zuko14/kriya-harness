import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"

// The host firewall on the real pinned DSH (2026-11-04): the fake Kriya
// blocks any plain request body holding "rm -rf" with Render's block page,
// as the real host did mid-task. The agent runs `rm -rf` once, so every
// later request carries it in the history. Nothing leaves this machine.

function kriya(args, cwd, env = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), ...args], { cwd, env: { ...process.env, KRIYA_LOOP_GUARD: "off", KRIYA_STRICT_LOOP: "off", KRIYA_DEFENSIVE: "off", KRIYA_RECON: "off", KRIYA_JIT_TOOLS: "off", KRIYA_ROUTER: "off", KRIYA_LOOP: "off", ...env } })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000)
    child.on("exit", (code) => {
      clearTimeout(timer)
      done({ code, stdout, stderr })
    })
  })
}

async function run({ bodyEncodings, env, deployAfterLaunch = false }) {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-relay-")))
  const script = {
    approveAfter: 0,
    firewall: /rm -rf/,
    bodyEncodings,
    chat: (body) => {
      // Kriya's deploy lands while the session runs: from now on it decodes and says so
      if (deployAfterLaunch) script.bodyEncodings = true
      if (!body.tools?.length) return { content: "Relay check" }
      const done = body.messages.filter((m) => m.role === "tool").length
      return done === 0
        ? { toolCall: { name: "bash", args: { command: "mkdir -p scratch && rm -rf scratch && echo cleaned", description: "Clean the scratch folder" } } }
        : { content: "Cleaned the scratch folder." }
    },
  }
  const fake = await startFakeKriya(script)
  const login = await kriya(["login", "--url", fake.url, "--no-browser"], ROOT)
  assert.equal(login.code, 0, login.stderr)
  const result = await kriya(["run", "Clean the scratch folder"], dir, env)
  await fake.close()
  return { ...result, state: fake.state }
}

test("the firewall blocks the conversation once it holds `rm -rf`: as it failed before, when Kriya is reached directly", { timeout: 300_000 }, async () => {
  const r = await run({ bodyEncodings: true, env: { KRIYA_RELAY: "off" } })
  assert.notEqual(r.code, 0, r.stderr.slice(-800))
  assert.ok(r.state.blocked >= 1, "the second request (with the tool result) was blocked")
})

test("through the relay, bodies go encoded and the same task finishes", { timeout: 300_000 }, async () => {
  const r = await run({ bodyEncodings: true })
  assert.equal(r.code, 0, `exit ${r.code}\n${r.stderr.slice(-1200)}`)
  assert.equal(r.state.blocked ?? 0, 0)
  assert.ok(r.state.encoded >= 2, `encoded requests: ${r.state.encoded}`)
  const chats = r.state.requests.filter((q) => q.path === "/chat/completions")
  assert.ok(chats.length >= 2 && chats.every((q) => q.headers["x-kriya-body"] === "gzip+base64"))
  assert.ok(JSON.stringify(chats.at(-1).body).includes("rm -rf scratch"), "the gateway got the history intact")
})

test("with a Kriya that can't decode yet, a block says what it is, not 'API key is invalid'", { timeout: 300_000 }, async () => {
  const r = await run({ bodyEncodings: false })
  assert.notEqual(r.code, 0)
  assert.ok(r.state.blocked >= 1)
  assert.match(r.stderr, /host firewall blocked this request \(request ID a553e7b17903d5ee\)/, r.stderr.slice(-1500))
  assert.doesNotMatch(r.stderr, /API key is invalid|AUTH/)
})

test("Kriya deployed after kriya started (the owner's 19:21 run): the block is re-asked about and the task finishes, no restart", { timeout: 300_000 }, async () => {
  const r = await run({ bodyEncodings: false, deployAfterLaunch: true })
  assert.equal(r.code, 0, `exit ${r.code}\n${r.stderr.slice(-1500)}`)
  assert.equal(r.state.blocked, 1, "the first plain request with `rm -rf` was blocked once")
  assert.ok(r.state.encoded >= 1)
  assert.match(r.stderr, /now decodes encoded request bodies/)
})
