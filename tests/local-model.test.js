import assert from "node:assert/strict"
import { createServer } from "node:http"
import { test } from "node:test"

import { startGatewayProxy } from "../src/gateway-proxy.js"
import { launchEnv, planTiers } from "../src/launch.js"
import { chooseModel, findLocalModel, isLocalAddress, LOCAL_WORKER, localModelArgs, localWorker } from "../src/local-model.js"
import { orchestraFromEnv } from "../src/orchestra.js"

// S-1 local models (src/local-model.js; owner decision SI-01): a model on this
// computer builds the orchestra's worker steps, Kriya's head leads; only with
// the owner's harness.localModels, --local-model, the orchestra and the relay.

const device = { url: "https://kriya.example", token: "dev-token" }
const o = { head: "escalation", worker: "budget" }

test("LM-01: only loopback, private and .local addresses", () => {
  for (const ok of ["http://127.0.0.1:11434/v1", "http://localhost:1234/v1", "http://10.0.0.5:8000/v1", "http://172.20.1.1/v1", "http://192.168.1.9:11434/v1", "http://studio.local:8000/v1", "http://[::1]:11434/v1", "http://[fd12::1]/v1"])
    assert.equal(isLocalAddress(ok), true, ok)
  for (const no of ["https://api.openai.com/v1", "http://8.8.8.8/v1", "http://172.32.0.1/v1", "http://example.com/v1", "file:///etc/passwd", "http://user:pw@127.0.0.1/v1", "not a url", "http://[2001:db8::1]/v1"])
    assert.equal(isLocalAddress(no), false, no)
})

test("LM-02: the named model only if served, else the first coder, else the first", () => {
  assert.equal(chooseModel(["llama3.1:8b", "qwen2.5-coder:14b"]), "qwen2.5-coder:14b")
  assert.equal(chooseModel(["llama3.1:8b"]), "llama3.1:8b")
  assert.equal(chooseModel(["llama3.1:8b"], "qwen2.5-coder:14b"), null)
  assert.equal(chooseModel(["bad id; rm -rf", "ok:1"]), "ok:1")
  assert.equal(chooseModel([]), null)
})

test("LM-03: finds Ollama, then LM Studio; says why when nothing answers", async () => {
  const asked = []
  const fake = (served) => async (url) => {
    asked.push(url)
    if (!served[url]) throw new TypeError("fetch failed")
    return { ok: true, json: async () => ({ data: served[url].map((id) => ({ id })) }) }
  }
  assert.deepEqual(await findLocalModel({ fetchImpl: fake({ "http://127.0.0.1:1234/v1/models": ["qwen2.5-coder-7b"] }) }), { url: "http://127.0.0.1:1234/v1", model: "qwen2.5-coder-7b", server: "LM Studio" })
  assert.deepEqual(asked, ["http://127.0.0.1:11434/v1/models", "http://127.0.0.1:1234/v1/models"])
  assert.match((await findLocalModel({ fetchImpl: fake({}) })).error, /No local model server is running/)
  assert.match((await findLocalModel({ fetchImpl: fake({ "http://127.0.0.1:11434/v1/models": [] }) })).error, /ollama pull/)
  assert.match((await findLocalModel({ url: "https://api.openai.com/v1", fetchImpl: fake({}) })).error, /loopback or private address only/)
  assert.match((await findLocalModel({ url: "http://127.0.0.1:11434/v1", name: "x:1", fetchImpl: fake({ "http://127.0.0.1:11434/v1/models": ["y:1"] }) })).error, /doesn't serve x:1/)
})

test("LM-04: --local-model [url] and --local-model-name leave the other arguments alone", () => {
  const env = {}
  const args = ["--local-model", "--port", "8080"]
  localModelArgs(args, env)
  assert.deepEqual(args, ["--port", "8080"])
  assert.equal(env.KRIYA_LOCAL_MODEL, "on")
  const env2 = {}
  const args2 = ["--local-model", "http://192.168.1.9:11434/v1", "--local-model-name", "qwen2.5-coder:32b", "fix it"]
  localModelArgs(args2, env2)
  assert.deepEqual(args2, ["fix it"])
  assert.deepEqual(env2, { KRIYA_LOCAL_MODEL: "http://192.168.1.9:11434/v1", KRIYA_LOCAL_MODEL_NAME: "qwen2.5-coder:32b" })
  const env3 = {}
  localModelArgs(["--no-open"], env3)
  assert.deepEqual(env3, {})
})

test("LM-05: used only when asked, offered and orchestrated, and a server answered", async () => {
  const found = async () => ({ url: "http://127.0.0.1:11434/v1", model: "qwen2.5-coder:14b", server: "Ollama" })
  assert.deepEqual(await localWorker({}, { offered: true, orchestra: o }, found), {})
  assert.deepEqual(await localWorker({ KRIYA_LOCAL_MODEL: "off" }, { offered: true, orchestra: o }, found), {})
  assert.match((await localWorker({ KRIYA_LOCAL_MODEL: "on" }, { offered: false, orchestra: o }, found)).note, /harness\.localModels/)
  assert.match((await localWorker({ KRIYA_LOCAL_MODEL: "on" }, { offered: true }, found)).note, /orchestra is off/)
  assert.match((await localWorker({ KRIYA_LOCAL_MODEL: "on" }, { offered: true, orchestra: o }, async () => ({ error: "Nothing." }))).note, /Using Kriya's models/)
  const on = await localWorker({ KRIYA_LOCAL_MODEL: "on" }, { offered: true, orchestra: o }, found)
  assert.equal(on.local.model, "qwen2.5-coder:14b")
  assert.match(on.note, /escalation plans, reviews and takes over/)
})

test("LM-06: planTiers carries the owner's offer; nothing without it", async () => {
  const answer = (extra) => async () => ({ data: [{ id: "budget" }, { id: "escalation" }], orchestra: o, ...extra })
  assert.equal((await planTiers(device, answer({ localModels: 1 }))).localModels, true)
  assert.equal((await planTiers(device, answer({}))).localModels, undefined)
})

test("LM-07: launchEnv: the worker becomes local only with a found server and the relay; the shell can't set it", () => {
  const names = { budget: "DeepSeek V4.1 Flash", escalation: "gemini-4-neon" }
  const local = { url: "http://127.0.0.1:11434/v1", model: "qwen2.5-coder:14b", server: "Ollama" }
  const env = launchEnv(device, {}, undefined, "escalation", ["budget", "escalation"], names, {}, [], o, true, local)
  assert.equal(env.KRIYA_ORCHESTRA_WORKER, LOCAL_WORKER)
  assert.equal(env.KRIYA_ORCHESTRA_HEAD, "escalation")
  assert.equal(env.KRIYA_LOCAL_MODEL_ID, "qwen2.5-coder:14b")
  assert.equal(JSON.parse(env.KRIYA_MODEL_NAMES).local, "Local · qwen2.5-coder:14b")
  assert.equal(env.KRIYA_ORCHESTRA_NAME, "Orchestration · gemini-4-neon leads, Local · qwen2.5-coder:14b builds")
  assert.equal(env.KRIYA_ALLOWED_TIERS, "budget,escalation")
  // No relay, no local; no local, exactly as before; the shell's values are dropped
  const before = launchEnv(device, {}, undefined, "escalation", ["budget", "escalation"], names, {}, [], o, true)
  assert.deepEqual(launchEnv(device, {}, undefined, "escalation", ["budget", "escalation"], names, {}, [], o, true, null), before)
  const noRelay = launchEnv(device, { KRIYA_LOCAL_MODEL_ID: "x", KRIYA_LOCAL_MODEL_LABEL: "x" }, undefined, "escalation", ["budget", "escalation"], names, {}, [], o, false, local)
  assert.equal(noRelay.KRIYA_ORCHESTRA_WORKER, "budget")
  assert.equal(noRelay.KRIYA_LOCAL_MODEL_ID, undefined)
  assert.equal(noRelay.KRIYA_LOCAL_MODEL_LABEL, undefined)
  assert.equal(JSON.parse(noRelay.KRIYA_MODEL_NAMES).local, undefined)
})

test("LM-08: the orchestra takes the local worker only with its model id", () => {
  const base = { KRIYA_ORCHESTRA: "on", KRIYA_LOOP: "on", KRIYA_ALLOWED_TIERS: "budget,escalation", KRIYA_ORCHESTRA_HEAD: "escalation", KRIYA_ORCHESTRA_WORKER: "local" }
  assert.equal(orchestraFromEnv(base), undefined)
  assert.deepEqual(orchestraFromEnv({ ...base, KRIYA_LOCAL_MODEL_ID: "qwen2.5-coder:14b" }), { head: "escalation", worker: "local" })
})

test("LM-09: the relay sends only the local model's chat to the local server, with its real name and no Kriya token", async () => {
  const seen = []
  const fake = (name) =>
    createServer(async (req, res) => {
      const chunks = []
      for await (const c of req) chunks.push(c)
      seen.push({ to: name, url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString() || "{}") })
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ from: name }))
    })
  const kriya = fake("kriya")
  const ollama = fake("local")
  await Promise.all([kriya, ollama].map((s) => new Promise((done) => s.listen(0, "127.0.0.1", done))))
  const relay = await startGatewayProxy({ target: `http://127.0.0.1:${kriya.address().port}`, encode: false, local: { url: `http://127.0.0.1:${ollama.address().port}/v1`, model: "qwen2.5-coder:14b" } })
  const send = (model) =>
    fetch(`${relay.url}/api/harness/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer dev-token", "x-kriya-harness": "2.0.1" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "local" }] }) }).then((r) => r.json())
  try {
    assert.deepEqual(await send("local"), { from: "local" })
    assert.deepEqual(await send("budget"), { from: "kriya" })
    const [toLocal, toKriya] = seen
    assert.equal(toLocal.url, "/v1/chat/completions")
    assert.equal(toLocal.body.model, "qwen2.5-coder:14b")
    assert.equal(toLocal.headers.authorization, undefined)
    assert.equal(toLocal.headers["x-kriya-harness"], undefined)
    assert.equal(toKriya.body.model, "budget")
    assert.equal(toKriya.headers.authorization, "Bearer dev-token")
  } finally {
    await relay.close()
    for (const s of [kriya, ollama]) await new Promise((done) => s.close(done))
  }
})

test("LM-10: a local server that's down is a plain 502, never a Kriya request", async () => {
  const kriyaSeen = []
  const kriya = createServer((req, res) => (kriyaSeen.push(req.url), res.end("{}")))
  await new Promise((done) => kriya.listen(0, "127.0.0.1", done))
  const relay = await startGatewayProxy({ target: `http://127.0.0.1:${kriya.address().port}`, encode: false, local: { url: "http://127.0.0.1:9/v1", model: "m" } })
  try {
    const res = await fetch(`${relay.url}/api/harness/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "local", messages: [] }) })
    assert.equal(res.status, 502)
    assert.match((await res.json()).error.message, /local model server/)
    assert.deepEqual(kriyaSeen, [])
  } finally {
    await relay.close()
    await new Promise((done) => kriya.close(done))
  }
})
