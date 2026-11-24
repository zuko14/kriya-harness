import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createServer } from "node:https"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { addModel, saveKey, setOrchestra } from "../src/own-models.js"
import { confirmCheck } from "../src/verify.js"
import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"

// Own models end to end on the real, pinned DSH (headless `kriya run --loop`),
// Kriya-Tavi docs/kriya-harness/OWN_MODELS.md. The person's own orchestration
// (head and worker from a custom OpenAI-compatible provider, here a local
// HTTPS fake with a throwaway certificate) runs the whole task: Kriya gets no
// chat request and never the key; the provider gets the key and only its own
// model names; Kriya gets the counts. Without the owner's advert, nothing of it.

const KEY = "sk-test-own-0123456789abcdefgh"
const textOf = (content) => (typeof content === "string" ? content : (content ?? []).map((p) => p?.text ?? "").join("\n"))

function certificate(dir) {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" })
  return { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")), ca: join(dir, "cert.pem") }
}

/** An OpenAI-compatible provider: one scripted conversation, streamed */
async function fakeProvider(tls, script) {
  const seen = []
  const server = createServer({ key: tls.key, cert: tls.cert }, async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
    seen.push({ url: req.url, auth: req.headers.authorization, kriya: req.headers["x-kriya-harness"], model: body?.model, raw: Buffer.concat(chunks).toString() })
    if (req.url !== "/v1/chat/completions") return res.writeHead(404).end()
    const reply = script(body)
    const base = { id: "c", object: "chat.completion.chunk", created: 1, model: body.model }
    res.writeHead(200, { "content-type": "text/event-stream" })
    const event = (d) => res.write(`data: ${JSON.stringify(d)}\n\n`)
    if (reply.toolCall) {
      event({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${seen.length}`, type: "function", function: { name: reply.toolCall.name, arguments: JSON.stringify(reply.toolCall.args) } }] }, finish_reason: null }] })
      event({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })
    } else {
      event({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: reply.content }, finish_reason: null }] })
      event({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
    }
    event({ ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.0001 } })
    res.end("data: [DONE]\n\n")
  })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  return { seen, url: `https://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((done) => server.close(done)) }
}

function kriya(args, cwd, extra = {}) {
  return new Promise((done) => {
    const off = { KRIYA_LOOP_GUARD: "off", KRIYA_STRICT_LOOP: "off", KRIYA_DEFENSIVE: "off", KRIYA_RECON: "off", KRIYA_JIT_TOOLS: "off", KRIYA_ROUTER: "off", KRIYA_BUDGET: "off", KRIYA_ANCHOR: "off", KRIYA_BROWSER: "off", KRIYA_CARTRIDGES: "off", KRIYA_LOOP_V2: "off" }
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("KRIYA_") || k === "KRIYA_HOME"))
    const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), ...args], { cwd, env: { ...base, ...off, ...extra } })
    let stderr = ""
    child.stderr.on("data", (d) => (stderr += d))
    const timer = setTimeout(() => child.kill("SIGKILL"), 150_000)
    child.on("exit", (code) => (clearTimeout(timer), done({ code, stderr })))
  })
}

async function runOnce({ ownModels }) {
  const home = freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-own-run-")))
  mkdirSync(join(dir, ".git"))
  writeFileSync(join(dir, "check.js"), 'const fs = require("node:fs")\nconst n = Number(fs.existsSync(".runs") ? fs.readFileSync(".runs", "utf8") : 0) + 1\nfs.writeFileSync(".runs", String(n))\nif (n < 2) { console.error("OWN-CHECK: not yet"); process.exit(1) }\nconsole.log("OWN-CHECK: ok")\n')
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "commonjs", scripts: { test: "node check.js" } }))
  confirmCheck(dir, "npm test")
  const tls = certificate(realpathSync(mkdtempSync(join(tmpdir(), "kriya-own-tls-"))))
  const builders = []
  const provider = await fakeProvider(tls, (body) => {
    if (!body.tools?.length) return { content: "Title" }
    const first = textOf(body.messages.find((m) => m.role === "user")?.content)
    const results = body.messages.filter((m) => m.role === "tool")
    if (/Do only this step, then stop\./.test(first)) return (results.length || builders.push(body.model), { content: "Built the step." })
    if (results.length === 0) return { toolCall: { name: "kriya_plan", args: { goal: "Make the check pass", steps: [{ title: "Pass the check", done_when: "npm test exits 0" }] } } }
    if (results.length === 1) return { toolCall: { name: "kriya_step", args: { step: 1 } } }
    return { content: "Done." }
  })
  // The person's setup, as the Developer tab saves it
  const file = join(home, "own-models.json")
  saveKey("custom", KEY, provider.url, file)
  addModel("custom", "fake/head-model", 65_536, file)
  addModel("custom", "fake/worker-model", 32_768, file)
  setOrchestra({ head: "own-1", worker: "own-2" }, file)
  const fake = await startFakeKriya({ approveAfter: 0, ownModels, chat: () => ({ content: "From Kriya." }) })
  assert.equal((await kriya(["login", "--url", fake.url, "--no-browser"], ROOT)).code, 0)
  const run = await kriya(["run", "--loop", "Make the check pass"], dir, { NODE_EXTRA_CA_CERTS: tls.ca })
  await fake.close()
  await provider.close()
  return { run, provider, builders, fake }
}

test("OM-RUN-01: the person's own orchestration runs the task on their provider; Kriya sees counts, never the key or a chat (real DSH)", { timeout: 300_000 }, async () => {
  const { run, provider, builders, fake } = await runOnce({ ownModels: true })
  const chats = provider.seen.filter((s) => s.url === "/v1/chat/completions")
  const report = JSON.stringify({ exit: run.code, chats: chats.map((c) => c.model), builders, stderr: run.stderr.slice(-1500) }, null, 1)
  assert.equal(run.code, 0, report)
  assert.match(run.stderr, /your orchestration: Custom · fake\/head-model leads, Custom · fake\/worker-model builds/, report)
  assert.ok(chats.length >= 3, report)
  assert.ok(chats.every((c) => c.auth === `Bearer ${KEY}` && c.kriya === undefined), "the provider gets the key, never Kriya's headers")
  assert.ok(chats.some((c) => c.model === "fake/head-model"), report)
  // The check fails once: tries 1 and 2 are the worker's (the head takes over only after escalateAfter = 2)
  assert.deepEqual(builders, ["fake/worker-model", "fake/worker-model"], report)
  assert.ok(chats.every((c) => !/own-\d/.test(c.model)), "the provider sees its own model names")
  const toKriya = fake.state.requests
  assert.equal(toKriya.filter((r) => r.path === "/chat/completions").length, 0, "no chat went to Kriya")
  assert.ok(!JSON.stringify(toKriya).includes(KEY), "Kriya never saw the key")
  const counted = (fake.state.ownUsage ?? []).flatMap((b) => b.entries)
  assert.ok(counted.length >= 1, report)
  assert.ok(counted.every((e) => e.provider === "custom" && /^fake\//.test(e.model) && e.inputTokens > 0), JSON.stringify(counted))
  assert.ok(!JSON.stringify(fake.state.ownUsage).includes("Make the check pass"), "counts only, no content")
})

test("OM-RUN-02: without the owner's advert, the saved setup is ignored and everything runs on Kriya (real DSH)", { timeout: 300_000 }, async () => {
  const { run, provider, fake } = await runOnce({ ownModels: false })
  assert.equal(run.code, 0, run.stderr.slice(-800))
  assert.equal(provider.seen.length, 0, "the provider was never called")
  assert.ok(fake.state.requests.some((r) => r.path === "/chat/completions"), "Kriya answered")
  assert.equal(fake.state.ownUsage, undefined)
})
