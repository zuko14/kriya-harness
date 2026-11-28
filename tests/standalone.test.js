import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createServer as createHttp } from "node:http"
import { createServer } from "node:https"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { createServer as createNet } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { deviceFromEnv, KriyaError } from "../src/api.js"
import { ORCHESTRA_ALIAS, startGatewayProxy } from "../src/gateway-proxy.js"
import { launchEnv, OFFLINE, planTiers, STANDALONE_TOKEN } from "../src/launch.js"
import { applyWorkforce, STANDALONE_SWITCHES, SWITCHES, WORKFORCE_SWITCHES } from "../src/modes.js"
import { addModel, launchOwn, saveKey, setOrchestra } from "../src/own-models.js"
import { activeDevice, writeDevice } from "../src/store.js"
import { confirmCheck } from "../src/verify.js"
import { freshHome, ROOT } from "./helpers.js"

// Standalone Mode: no Kriya account (no device.json), `--standalone`, or Kriya
// unreachable (network error, timeout, 5xx such as Render's 503 for a suspended
// service). Every Harness 2.0 feature runs on this computer on the person's own
// keys and local model, through the local relay. A Kriya that answers and
// refuses (401, 403, 426) is never bypassed.

const KEY = "sk-test-standalone-0123456789abcd"
const refusal = (status, code) => new KriyaError(status, code, `refused ${status}`)
const failing = (error) => async () => {
  throw error
}

test("SA-01: no device → Standalone Mode with every Harness 2.0 offer on", async () => {
  const t = await planTiers(null)
  assert.equal(t.standalone, true)
  assert.equal(t.reason, "signed_out")
  assert.deepEqual([t.workforce, t.cockpit, t.ownModels, t.localModels], [true, true, true, true])
  assert.deepEqual(t.allowed, [], "no Kriya tier is offered")
})

test("SA-02: Kriya unreachable (503 suspend, 502, network, timeout) → Standalone Mode", async () => {
  const device = { url: "http://127.0.0.1:9", token: "t" }
  for (const error of [refusal(503, "http_error"), refusal(502, "http_error"), refusal(500, "server_error"), new KriyaError(0, "network", "Couldn't reach")]) {
    const t = await planTiers(device, failing(error))
    assert.equal(t.standalone, true, `status ${error.status}`)
    assert.equal(t.reason, "server_unreachable")
    assert.equal(t.workforce, true)
  }
  assert.equal((await planTiers(device, failing(new Error("x")), { standalone: true })).reason, "requested")
})

test("SA-03 (security): 401, 403 and 426 are surfaced and never turned into Standalone Mode", async () => {
  const device = { url: "http://127.0.0.1:9", token: "t" }
  for (const [status, code] of [[401, "unauthorized"], [403, "suspended"], [426, "upgrade"]]) {
    const t = await planTiers(device, failing(refusal(status, code)))
    assert.equal(t.standalone, undefined, `status ${status}`)
    assert.deepEqual(t.refused, { status, code, message: `refused ${status}` })
    assert.equal(t.workforce, undefined)
    assert.equal(t.ownModels, undefined)
    assert.equal(t.cockpit, undefined)
  }
  // A 200 is obeyed exactly: nothing on without the server's flags
  const t = await planTiers(device, async () => ({ data: [{ id: "balanced" }] }))
  assert.equal(t.standalone, undefined)
  assert.equal(t.workforce, undefined)
})

test("SA-04: standalone launch variables: no Kriya tier, starts on the person's model or orchestration, plugins see no device", () => {
  const home = freshHome()
  const file = join(home, "own-models.json")
  saveKey("openrouter", KEY, undefined, file)
  addModel("openrouter", "anthropic/claude-x", 200_000, file)
  addModel("openrouter", "qwen/qwen3-coder", 131_072, file)
  const single = launchOwn(file, { allowed: [], local: true })
  const env = launchEnv({ url: "http://127.0.0.1:5", token: STANDALONE_TOKEN }, { KRIYA_STANDALONE: "spoof", PATH: "/bin" }, "ask", "balanced", [], {}, {}, [], undefined, true, null, single, "signed_out")
  assert.equal(env.KRIYA_ALLOWED_TIERS, "none")
  assert.equal(env.KRIYA_START_TIER, "own-1")
  assert.equal(env.KRIYA_STANDALONE, "on")
  assert.equal(env.KRIYA_STANDALONE_REASON, "signed_out")
  assert.equal(deviceFromEnv(env), null, "Kriya plugins see Standalone Mode as signed out")
  assert.ok(!JSON.stringify(env).includes(KEY), "the key never reaches DSH's environment")
  setOrchestra({ head: "own-1", worker: "own-2" }, file)
  const own = launchOwn(file, { allowed: [], local: true })
  const orchestrated = launchEnv({ url: "http://127.0.0.1:5", token: STANDALONE_TOKEN }, {}, "ask", own.orchestra.head, [], {}, {}, [], own.orchestra, true, null, own, "requested")
  assert.equal(orchestrated.KRIYA_START_TIER, ORCHESTRA_ALIAS)
  assert.deepEqual([orchestrated.KRIYA_ORCHESTRA_HEAD, orchestrated.KRIYA_ORCHESTRA_WORKER], ["own-1", "own-2"])
  // A local model alone, no orchestration: listed and started on
  const local = launchEnv({ url: "http://127.0.0.1:5", token: STANDALONE_TOKEN }, {}, "ask", "balanced", [], {}, {}, [], undefined, true, { url: "http://127.0.0.1:11434/v1", model: "qwen2.5-coder:7b", server: "Ollama" }, null, "signed_out")
  assert.equal(local.KRIYA_START_TIER, "local")
  assert.equal(local.KRIYA_LOCAL_MODEL_ID, "qwen2.5-coder:7b")
  // Connected launches are as before: the shell can't claim Standalone Mode
  const connected = launchEnv({ url: "http://127.0.0.1:5", token: "real" }, { KRIYA_STANDALONE: "on" })
  assert.equal(connected.KRIYA_STANDALONE, undefined)
  assert.equal(connected.KRIYA_ALLOWED_TIERS, "balanced,budget,escalation")
  assert.equal(activeDevice({ KRIYA_STANDALONE: "on" }), null)
})

test("SA-05: standalone switches are the local Harness 2.0 ones; defaults are unchanged", () => {
  assert.ok(!STANDALONE_SWITCHES.includes("mcp"), "MCP needs Kriya's registry")
  for (const flag of ["cartridges", "orchestra", "gates", "critic", "milestones", "grounding", "explore", "runstrip"]) assert.ok(STANDALONE_SWITCHES.includes(flag), flag)
  const env = { KRIYA_SWITCHES_SET: "gates", KRIYA_GATES: "off" }
  const turned = applyWorkforce(env, true, STANDALONE_SWITCHES)
  assert.ok(!turned.includes("gates"), "the person's --no-gates wins")
  assert.equal(env.KRIYA_GATES, "off")
  assert.equal(env.KRIYA_MCP, undefined)
  // SWITCHES defaults stay off for every Harness 2.0 switch outside Standalone/workforce
  for (const [flag, , byDefault] of SWITCHES) if (WORKFORCE_SWITCHES.includes(flag)) assert.equal(byDefault, false, flag)
})

test("SA-06: the relay runs with no Kriya behind it: own models answer, a Kriya tier gets the plain offline sentence", async () => {
  const seen = []
  const provider = createHttp(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) })
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
  })
  await new Promise((done) => provider.listen(0, "127.0.0.1", done))
  const relay = await startGatewayProxy({ offline: OFFLINE.server_unreachable, routes: { "own-1": { url: `http://127.0.0.1:${provider.address().port}/v1`, model: "real/model", key: KEY, provider: "openrouter" } } })
  try {
    const post = (model) => fetch(`${relay.url}/api/harness/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${STANDALONE_TOKEN}` }, body: JSON.stringify({ model, messages: [] }) })
    const own = await post("own-1")
    assert.equal(own.status, 200)
    assert.equal(seen[0].body.model, "real/model")
    assert.equal(seen[0].auth, `Bearer ${KEY}`, "the provider gets the person's key, never the stand-in token")
    const tier = await post("escalation")
    assert.equal(tier.status, 400, "shown, not retried")
    const body = await tier.json()
    assert.equal(body.error.code, "kriya_offline")
    assert.match(body.error.message, /Kriya server is offline.*own models or the local model.*Developer tab/)
    assert.equal(seen.length, 1, "nothing else left this computer")
  } finally {
    await relay.close()
    await new Promise((done) => provider.close(done))
  }
  await assert.rejects(() => startGatewayProxy({}), /needs a Kriya address/)
})

// ---------- Real DSH, end to end ----------

function certificate(dir) {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" })
  return { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")), ca: join(dir, "cert.pem") }
}

const textOf = (content) => (typeof content === "string" ? content : (content ?? []).map((p) => p?.text ?? "").join("\n"))

/** An OpenAI-compatible provider (OpenRouter's shape) driving one loop task, streamed */
async function fakeProvider(tls) {
  const seen = []
  const builders = []
  const server = createServer({ key: tls.key, cert: tls.cert }, async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
    seen.push({ url: req.url, auth: req.headers.authorization, model: body?.model })
    if (req.url !== "/v1/chat/completions") return res.writeHead(404).end()
    const first = textOf(body.messages.find((m) => m.role === "user")?.content)
    const results = body.messages.filter((m) => m.role === "tool")
    let reply
    if (!body.tools?.length) reply = { content: "Title" }
    else if (/Do only this step, then stop\./.test(first)) reply = (results.length || builders.push(body.model), { content: "Built the step." })
    else if (results.length === 0) reply = { toolCall: { name: "kriya_plan", args: { goal: "Make the check pass", steps: [{ title: "Pass the check", done_when: "npm test exits 0" }] } } }
    else if (results.length === 1) reply = { toolCall: { name: "kriya_step", args: { step: 1 } } }
    else reply = { content: "Done." }
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
    event({ ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } })
    res.end("data: [DONE]\n\n")
  })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  return { seen, builders, url: `https://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((done) => server.close(done)) }
}

/** A Kriya that answers every request with one status (Render's suspended page is a 503) */
async function statusKriya(status) {
  const hits = []
  const server = createHttp((req, res) => {
    hits.push(req.url)
    res.writeHead(status, { "content-type": status === 503 ? "text/html" : "application/json" }).end(status === 503 ? "<html>Service Suspended</html>" : JSON.stringify({ error: status === 401 ? "unauthorized" : "suspended", message: "Refused by Kriya." }))
  })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  return { hits, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) }
}

function kriya(args, cwd, extra = {}) {
  return new Promise((done) => {
    const quiet = { KRIYA_LOOP_GUARD: "off", KRIYA_STRICT_LOOP: "off", KRIYA_DEFENSIVE: "off", KRIYA_RECON: "off", KRIYA_JIT_TOOLS: "off", KRIYA_ROUTER: "off", KRIYA_BUDGET: "off", KRIYA_BROWSER: "off", KRIYA_CRITIC: "off", KRIYA_EXPLORE: "off", KRIYA_MILESTONES: "off" }
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("KRIYA_") || k === "KRIYA_HOME"))
    const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), ...args], { cwd, env: { ...base, ...quiet, ...extra } })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    const timer = setTimeout(() => child.kill("SIGKILL"), 200_000)
    child.on("exit", (code) => (clearTimeout(timer), done({ code, stdout, stderr })))
  })
}

async function project(device) {
  const home = freshHome()
  if (device) writeDevice({ ...device, deviceId: "11111111-2222-4333-8444-555555555555" })
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-standalone-")))
  mkdirSync(join(dir, ".git"))
  writeFileSync(join(dir, "check.js"), 'const fs = require("node:fs")\nconst n = Number(fs.existsSync(".runs") ? fs.readFileSync(".runs", "utf8") : 0) + 1\nfs.writeFileSync(".runs", String(n))\nif (n < 2) { console.error("SA-CHECK: not yet"); process.exit(1) }\nconsole.log("SA-CHECK: ok")\n')
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "commonjs", scripts: { test: "node check.js" } }))
  confirmCheck(dir, "npm test")
  const tls = certificate(realpathSync(mkdtempSync(join(tmpdir(), "kriya-sa-tls-"))))
  const provider = await fakeProvider(tls)
  // The person's setup, as the Developer tab saves it (a custom OpenAI-compatible provider: OpenRouter's shape)
  const file = join(home, "own-models.json")
  saveKey("custom", KEY, provider.url, file)
  addModel("custom", "fake/head-model", 65_536, file)
  addModel("custom", "fake/worker-model", 32_768, file)
  setOrchestra({ head: "own-1", worker: "own-2" }, file)
  return { dir, tls, provider }
}

test("SA-RUN-01: kriya run --standalone, no device.json: own orchestration + cartridges + gates + loop on the real DSH, and a proof receipt", { timeout: 300_000 }, async () => {
  const { dir, tls, provider } = await project(null)
  const run = await kriya(["run", "--standalone", "--loop", "Make the check pass"], dir, { NODE_EXTRA_CA_CERTS: tls.ca })
  await provider.close()
  const chats = provider.seen.filter((s) => s.url === "/v1/chat/completions")
  const report = JSON.stringify({ exit: run.code, chats: chats.map((c) => c.model), builders: provider.builders, stderr: run.stderr.slice(-2500) }, null, 1)
  assert.equal(run.code, 0, report)
  assert.match(run.stderr, /Not signed in to Kriya\. Standalone Mode/, report)
  assert.match(run.stderr, /Harness 2\.0 is on: .*cartridges.*orchestra.*gates/, report)
  assert.match(run.stderr, /your orchestration: Custom · fake\/head-model leads, Custom · fake\/worker-model builds/, report)
  assert.ok(chats.length >= 3, report)
  assert.ok(chats.every((c) => c.auth === `Bearer ${KEY}`), "the provider gets the person's key only")
  assert.deepEqual(provider.builders, ["fake/worker-model", "fake/worker-model"], report)
  const receipt = await kriya(["receipt", "make"], dir)
  assert.equal(receipt.code, 0, receipt.stdout + receipt.stderr)
  assert.match(receipt.stdout, /Receipt for session .*: verified/, receipt.stdout)
})

test("SA-RUN-02: a suspended Kriya (HTTP 503) and a refused port (ECONNREFUSED) degrade into Standalone Mode (real DSH)", { timeout: 400_000 }, async () => {
  const down = await statusKriya(503)
  const refused = await new Promise((done) => {
    const s = createNet().listen(0, "127.0.0.1", () => {
      const port = s.address().port
      s.close(() => done(`http://127.0.0.1:${port}`))
    })
  })
  for (const url of [down.url, refused]) {
    const { dir, tls, provider } = await project({ url, token: "device-token-0123456789" })
    const run = await kriya(["run", "--loop", "Make the check pass"], dir, { NODE_EXTRA_CA_CERTS: tls.ca })
    await provider.close()
    const report = JSON.stringify({ url, exit: run.code, stderr: run.stderr.slice(-2000) }, null, 1)
    assert.equal(run.code, 0, report)
    assert.match(run.stderr, /Kriya isn't reachable right now.*Standalone Mode/, report)
    assert.ok(provider.seen.some((s) => s.url === "/v1/chat/completions"), report)
  }
  assert.deepEqual(down.hits, ["/api/harness/v1/models"], "only the models question went to Kriya: no chat, no usage, no broadcast")
  await down.close()
})

test("SA-RUN-03 (security): a Kriya that answers 401 or 403 is never bypassed: no own-model call, the refusal is said (real DSH)", { timeout: 300_000 }, async () => {
  for (const status of [401, 403]) {
    const kriyaServer = await statusKriya(status)
    const { dir, tls, provider } = await project({ url: kriyaServer.url, token: "device-token-0123456789" })
    const run = await kriya(["run", "Say hello"], dir, { NODE_EXTRA_CA_CERTS: tls.ca })
    await provider.close()
    await kriyaServer.close()
    const report = JSON.stringify({ status, exit: run.code, stderr: run.stderr.slice(-1500) }, null, 1)
    assert.notEqual(run.code, 0, report)
    assert.match(run.stderr, new RegExp(`Kriya refused this device \\(${status}\\)`), report)
    assert.doesNotMatch(run.stderr, /Standalone Mode/, report)
    assert.equal(provider.seen.length, 0, "the person's own provider was never called")
  }
})

test("SA-CLI: every switch works on plain kriya; unknown words and flags are still refused", async () => {
  freshHome()
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "kriya-sa-cli-")))
  const word = await kriya(["frobnicate"], cwd)
  assert.equal(word.code, 1)
  assert.match(word.stdout, /Unknown command frobnicate/)
  const unknown = await kriya(["--orchestra", "--runstrip", "--standalone", "--workforce", "--local-model-name", "x", "--bogus"], cwd)
  assert.equal(unknown.code, 1)
  assert.match(unknown.stdout, /Unknown option --bogus/, "every known flag was taken; only --bogus is left")
  const signedOut = await kriya(["usage"], cwd)
  assert.equal(signedOut.code, 1)
  assert.match(signedOut.stdout, /needs a Kriya account: run `kriya login`/)
})

test("SA-WEB: plain `kriya` boots the real Web UI signed out, every plugin active, on loopback with its token", { timeout: 180_000 }, async () => {
  freshHome()
  const port = await new Promise((done) => {
    const s = createNet().listen(0, "127.0.0.1", () => {
      const { port } = s.address()
      s.close(() => done(port))
    })
  })
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("KRIYA_") || k === "KRIYA_HOME"))
  const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "--no-open", "--port", String(port)], { cwd: realpathSync(mkdtempSync(join(tmpdir(), "kriya-sa-web-"))), env: base })
  let output = ""
  child.stdout.on("data", (d) => (output += d))
  child.stderr.on("data", (d) => (output += d))
  try {
    let status = null
    for (let i = 0; i < 90 && status === null; i++) {
      await new Promise((done) => setTimeout(done, 1000))
      if (output.includes(`127.0.0.1:${port}`)) status = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.status, () => null)
    }
    const shown = output.replace(/[A-Za-z0-9_-]{43}/g, "<token>").slice(0, 3000)
    assert.equal(status, 401, shown)
    assert.match(output, /Standalone Mode/, shown)
    assert.match(output, /Harness 2\.0 is on: cartridges, orchestra, gates, critic, milestones, grounding, explore, runstrip/, shown)
    assert.match(output, /no model is set up yet: open the Developer tab/, shown)
    assert.doesNotMatch(output, /startup failed|did not activate|Unhandled|unhandled rejection/i, shown)
  } finally {
    child.kill("SIGTERM")
    await new Promise((done) => child.on("exit", done))
  }
})

test("SA-RUN-04: a default model the person pinned to a Kriya tier (agent-default-model: escalation) doesn't strand a standalone run (real DSH)", { timeout: 300_000 }, async () => {
  const { dir, tls, provider } = await project(null)
  const profile = join(process.env.KRIYA_HOME, "profiles", "kriya-run")
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, "cordis.patch.yml"), "- id: agent-default-model\n  name: \"@deepseek-ai/dsh-agent-default-model\"\n  config:\n    provider: kriya\n    model: escalation\n")
  const run = await kriya(["run", "--standalone", "Say hello"], dir, { NODE_EXTRA_CA_CERTS: tls.ca, KRIYA_LOOP: "off" })
  await provider.close()
  const report = JSON.stringify({ exit: run.code, models: provider.seen.map((s) => s.model), stderr: run.stderr.slice(-1500) }, null, 1)
  assert.equal(run.code, 0, report)
  assert.ok(provider.seen.some((s) => s.url === "/v1/chat/completions"), report)
})
