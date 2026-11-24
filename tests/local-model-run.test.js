import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { confirmCheck } from "../src/verify.js"
import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"

// S-1 end to end on the real, pinned DSH (headless `kriya run --loop
// --orchestra --local-model <url>`): a fake Kriya offering the orchestra and
// local models, and a fake OpenAI-compatible server standing in for Ollama.
// The check fails twice, then passes: attempts 1 and 2 are built by the local
// model, attempt 3 by Kriya's head. The local server never sees the device
// token, and Kriya never sees the local model. Nothing leaves this machine.

function kriya(args, cwd) {
  return new Promise((done) => {
    const off = { KRIYA_LOOP_GUARD: "off", KRIYA_STRICT_LOOP: "off", KRIYA_DEFENSIVE: "off", KRIYA_RECON: "off", KRIYA_JIT_TOOLS: "off", KRIYA_ROUTER: "off", KRIYA_LOOP: "off", KRIYA_LOOP_V2: "off", KRIYA_BUDGET: "off", KRIYA_ANCHOR: "off", KRIYA_BROWSER: "off", KRIYA_CARTRIDGES: "off", KRIYA_ORCHESTRA: "off" }
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("KRIYA_LOCAL")))
    const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), ...args], { cwd, env: { ...base, ...off } })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    const timer = setTimeout(() => child.kill("SIGKILL"), 150_000)
    child.on("exit", (code) => {
      clearTimeout(timer)
      done({ code, stdout, stderr })
    })
  })
}

const textOf = (content) => (typeof content === "string" ? content : (content ?? []).map((p) => p?.text ?? "").join("\n"))

/** A stand-in for Ollama's OpenAI-compatible API: one model, plain streamed answers */
async function fakeLocal(model) {
  const seen = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
    seen.push({ url: req.url, headers: req.headers, model: body?.model })
    if (req.method === "GET" && req.url === "/v1/models") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [{ id: model, object: "model" }] }))
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") return res.writeHead(404).end()
    const base = { id: "chatcmpl-local", object: "chat.completion.chunk", created: 1, model }
    res.writeHead(200, { "content-type": "text/event-stream" })
    const event = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`)
    event({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Built the step locally." }, finish_reason: null }] })
    event({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
    event({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
    res.end("data: [DONE]\n\n")
  })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  return { seen, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((done) => server.close(done)) }
}

async function runOnce({ localModels }) {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-local-run-")))
  mkdirSync(join(dir, ".git"))
  writeFileSync(join(dir, "check.js"), 'const fs = require("node:fs")\nconst n = Number(fs.existsSync(".runs") ? fs.readFileSync(".runs", "utf8") : 0) + 1\nfs.writeFileSync(".runs", String(n))\nif (n < 3) { console.error("LOCAL-CHECK: not yet, run " + n); process.exit(1) }\nconsole.log("LOCAL-CHECK: ok")\n')
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "commonjs", scripts: { test: "node check.js" } }))
  confirmCheck(dir, "npm test")
  const local = await fakeLocal("qwen-test-coder:7b")
  const kriyaSeen = { head: [], builders: [] }
  const fake = await startFakeKriya({
    approveAfter: 0,
    orchestra: { head: "escalation", worker: "budget" },
    localModels,
    chat: (body) => {
      if (!body.tools?.length) return { content: "Title" }
      const first = textOf(body.messages.find((m) => m.role === "user")?.content)
      const results = body.messages.filter((m) => m.role === "tool")
      if (/Do only this step, then stop\./.test(first)) {
        if (!results.length) kriyaSeen.builders.push(body.model)
        return { content: "Built the step." }
      }
      kriyaSeen.head.push(body.model)
      if (results.length === 0) return { toolCall: { name: "kriya_plan", args: { goal: "Make the check pass", steps: [{ title: "Pass the check", done_when: "npm test exits 0" }] } } }
      if (results.length === 1) return { toolCall: { name: "kriya_step", args: { step: 1 } } }
      return { content: "Done." }
    },
  })
  const login = await kriya(["login", "--url", fake.url, "--no-browser"], ROOT)
  assert.equal(login.code, 0, login.stderr)
  const run = await kriya(["run", "--loop", "--orchestra", "--local-model", local.url, "Make the check pass"], dir)
  await fake.close()
  await local.close()
  return { run, kriyaSeen, localSeen: local.seen, kriyaRequests: fake.state }
}

test("LM-RUN-01: the local model builds attempts 1 and 2, Kriya's head attempt 3; no token reaches it (real DSH)", { timeout: 300_000 }, async () => {
  const { run, kriyaSeen, localSeen } = await runOnce({ localModels: true })
  const chats = localSeen.filter((s) => s.url === "/v1/chat/completions")
  const report = JSON.stringify({ exit: run.code, kriya: kriyaSeen, local: localSeen.map((s) => [s.url, s.model]), stderr: run.stderr.slice(-1200) }, null, 1)
  assert.equal(run.code, 0, report)
  assert.match(run.stderr, /qwen-test-coder:7b \(your server, .*\) builds on this computer; Kriya's escalation plans/, report)
  assert.ok(kriyaSeen.head.length > 0 && kriyaSeen.head.every((m) => m === "escalation"), report)
  // Kriya builds only the head's takeover; it never sees "local"
  assert.deepEqual(kriyaSeen.builders, ["escalation"], report)
  assert.ok(chats.length >= 2, report)
  assert.ok(chats.every((s) => s.model === "qwen-test-coder:7b"), report)
  assert.ok(localSeen.every((s) => s.headers.authorization === undefined && s.headers["x-kriya-harness"] === undefined), report)
})

test("LM-RUN-02: without the owner's offer, --local-model says so and everything runs on Kriya as before (real DSH)", { timeout: 300_000 }, async () => {
  const { run, kriyaSeen, localSeen } = await runOnce({ localModels: false })
  const report = JSON.stringify({ exit: run.code, kriya: kriyaSeen, local: localSeen.length, stderr: run.stderr.slice(-1200) }, null, 1)
  assert.equal(run.code, 0, report)
  assert.match(run.stderr, /harness\.localModels/, report)
  assert.deepEqual(kriyaSeen.builders, ["budget", "budget", "escalation"], report)
  assert.equal(localSeen.length, 0, report)
})
