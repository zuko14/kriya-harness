import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { mkdtempSync, readFileSync, realpathSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { KriyaError } from "../src/api.js"
import { startGatewayProxy, usageOf } from "../src/gateway-proxy.js"
import { launchEnv } from "../src/launch.js"
import { orchestraFromEnv } from "../src/orchestra.js"
import { addModel, customUrl, keyHashes, launchOwn, listProviderModels, OwnModelsError, publicView, readOwn, removeKey, removeModel, saveKey, setOrchestra } from "../src/own-models.js"
import { usageReporter } from "../src/own-usage.js"
import { handler } from "../plugins/cockpit/index.js"
import { fileGuard, REDACTED, redactHook, redactKeys } from "../plugins/keyguard/index.js"

// Own models (src/own-models.js, Kriya-Tavi docs/kriya-harness/OWN_MODELS.md):
// the person's own API keys and orchestration. Keys stay in one 600 file and the
// launcher's relay; Kriya, the Web UI, DSH and models never get one. OM-*.

const tmp = () => join(realpathSync(mkdtempSync(join(tmpdir(), "kriya-own-"))), "own-models.json")
const KEY = "sk-or-v1-abcdef0123456789abcdef"
const OTHER = "sk-proj-zyxwvutsrqponm987654"

test("OM-01: the store: keys validated and private, the view masked, removals cascade", () => {
  const file = tmp()
  assert.throws(() => saveKey("openrouter", "short", undefined, file), OwnModelsError)
  assert.throws(() => saveKey("openrouter", "has a space in it", undefined, file), OwnModelsError)
  assert.throws(() => saveKey("evil", KEY, undefined, file), OwnModelsError)
  saveKey("openrouter", ` ${KEY} `, undefined, file)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(readOwn(file).keys.openrouter.key, KEY)
  addModel("openrouter", "deepseek/deepseek-chat", 65_536, file)
  addModel("openrouter", "deepseek/deepseek-chat", 65_536, file)
  addModel("openrouter", "qwen/qwen-2.5-coder-32b-instruct", 1, file)
  assert.throws(() => addModel("openai", "gpt-x", 1, file), /key first/)
  assert.throws(() => addModel("openrouter", "bad model; rm", 1, file), /model id/)
  const view = publicView(file)
  assert.ok(!JSON.stringify(view).includes(KEY), "never the key")
  assert.equal(view.providers.find((p) => p.id === "openrouter").last4, KEY.slice(-4))
  assert.deepEqual(view.models.map((m) => [m.id, m.name, m.contextWindow]), [["own-1", "OpenRouter · deepseek/deepseek-chat", 65_536], ["own-2", "OpenRouter · qwen/qwen-2.5-coder-32b-instruct", 16_384]])
  assert.throws(() => setOrchestra({ head: "own-1", worker: "own-1" }, file), /different/)
  assert.throws(() => setOrchestra({ head: "local", worker: "own-1" }, file), /stronger model/)
  assert.throws(() => setOrchestra({ head: "own-9", worker: "budget" }, file), /lists/)
  setOrchestra({ head: "own-1", worker: "own-2" }, file)
  removeModel("own-2", file)
  assert.equal(readOwn(file).orchestra, null, "an orchestration that lost a model is cleared")
  setOrchestra({ head: "own-1", worker: "budget" }, file)
  removeKey("openrouter", file)
  assert.deepEqual([readOwn(file).models, readOwn(file).orchestra, readOwn(file).keys], [[], null, {}])
})

test("OM-02: a custom provider is an https API address with no credentials in it", () => {
  assert.equal(customUrl("https://api.example.com/v1/"), "https://api.example.com/v1")
  for (const bad of ["http://api.example.com/v1", "https://user:pw@api.example.com/v1", "https://api.example.com/v1?key=x", "not a url", "file:///etc/passwd"]) assert.throws(() => customUrl(bad), OwnModelsError, bad)
})

test("OM-03: a provider's models, asked with the person's key; refusals said plainly", async () => {
  const file = tmp()
  saveKey("openrouter", KEY, undefined, file)
  const seen = []
  const fake = (status, body) => async (url, init) => (seen.push([url, init.headers.authorization, init.redirect]), { status, ok: status === 200, json: async () => body })
  const list = await listProviderModels("openrouter", file, fake(200, { data: [{ id: "z/model", context_length: 32_000 }, { id: "a/model" }, { id: "bad id; rm" }] }))
  assert.deepEqual(list, [{ id: "a/model" }, { id: "z/model", contextWindow: 32_000 }])
  assert.deepEqual(seen[0], ["https://openrouter.ai/api/v1/models", `Bearer ${KEY}`, "error"])
  await assert.rejects(listProviderModels("openrouter", file, fake(401, {})), /refused that key/)
  await assert.rejects(listProviderModels("openai", file, fake(200, {})), /key first/)
})

test("OM-04: a launch: the picker gets ids and names only; the person's orchestration only when every part is usable", () => {
  const file = tmp()
  saveKey("openrouter", KEY, undefined, file)
  addModel("openrouter", "deepseek/deepseek-chat", 65_536, file)
  setOrchestra({ head: "own-1", worker: "budget" }, file)
  const own = launchOwn(file, { allowed: ["budget", "escalation"], local: false })
  assert.deepEqual(own.models, [{ id: "own-1", name: "OpenRouter · deepseek/deepseek-chat", contextWindow: 65_536 }])
  assert.deepEqual(own.routes["own-1"], { url: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-chat", key: KEY, provider: "openrouter" })
  assert.deepEqual(own.orchestra, { head: "own-1", worker: "budget" })
  assert.deepEqual(own.hashes, [createHash("sha256").update(KEY).digest("hex")])
  assert.equal(launchOwn(file, { allowed: ["escalation"] }).orchestra, undefined, "a tier the plan lacks: not usable")
  setOrchestra({ head: "own-1", worker: "local" }, file)
  assert.equal(launchOwn(file, { allowed: ["budget"], local: false }).orchestra, undefined)
  assert.deepEqual(launchOwn(file, { allowed: ["budget"], local: true }).orchestra, { head: "own-1", worker: "local" })
})

test("OM-05: launchEnv: the person's orchestration, own models in the picker, hashes not keys; nothing without the relay", () => {
  const file = tmp()
  saveKey("openrouter", KEY, undefined, file)
  addModel("openrouter", "deepseek/deepseek-chat", 65_536, file)
  setOrchestra({ head: "own-1", worker: "budget" }, file)
  const own = launchOwn(file, { allowed: ["budget", "escalation"] })
  const device = { url: "http://127.0.0.1:9", token: "dev-token" }
  const env = launchEnv(device, { KRIYA_ORCHESTRA: "on", KRIYA_LOOP: "on" }, undefined, "escalation", ["budget", "escalation"], {}, {}, [], own.orchestra, true, null, own)
  assert.deepEqual([env.KRIYA_ORCHESTRA_HEAD, env.KRIYA_ORCHESTRA_WORKER, env.KRIYA_START_TIER], ["own-1", "budget", "orchestra"])
  assert.equal(env.KRIYA_ORCHESTRA_NAME, "Orchestration · OpenRouter · deepseek/deepseek-chat leads, Kriya budget builds")
  assert.equal(env.KRIYA_OWN_MODEL_IDS, "own-1")
  assert.equal(env.KRIYA_KEY_HASHES, own.hashes[0])
  assert.ok(!JSON.stringify(env).includes(KEY), "no key in DSH's environment")
  assert.deepEqual(orchestraFromEnv({ ...env, KRIYA_ORCHESTRA: "on", KRIYA_LOOP: "on" }), { head: "own-1", worker: "budget" })
  const direct = launchEnv(device, { KRIYA_OWN_MODELS: "[]", KRIYA_KEY_HASHES: "x" }, undefined, "escalation", ["budget", "escalation"], {}, {}, [], own.orchestra, false, null, own)
  for (const k of ["KRIYA_OWN_MODELS", "KRIYA_OWN_MODEL_IDS", "KRIYA_KEY_HASHES", "KRIYA_ORCHESTRA_HEAD"]) assert.equal(direct[k], undefined, k)
  // The owner's orchestra is untouched by own models it doesn't use
  const owner = { head: "escalation", worker: "budget" }
  const withOwner = launchEnv(device, {}, undefined, "escalation", ["budget", "escalation"], {}, {}, [], owner, true, null, { ...own, orchestra: undefined })
  assert.deepEqual([withOwner.KRIYA_ORCHESTRA_HEAD, withOwner.KRIYA_ORCHESTRA_WORKER, withOwner.KRIYA_OWN_MODEL_IDS], ["escalation", "budget", "own-1"])
})

test("OM-06: the relay: an own model's request goes to its provider with the person's key only; counts come back", async () => {
  const seen = []
  const provider = createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    seen.push({ to: "provider", auth: req.headers.authorization, kriya: req.headers["x-kriya-harness"], body })
    if (body.stream_options && body.model === "picky/model") return res.writeHead(400, { "content-type": "application/json" }).end('{"error":"unknown field stream_options"}')
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 7, cost: 0.00042 } })}\n\n`)
    res.end("data: [DONE]\n\n")
  })
  const kriya = createServer(async (req, res) => {
    seen.push({ to: "kriya", auth: req.headers.authorization })
    res.writeHead(200, { "content-type": "application/json" }).end("{}")
  })
  await Promise.all([provider, kriya].map((s) => new Promise((done) => s.listen(0, "127.0.0.1", done))))
  const base = `http://127.0.0.1:${provider.address().port}/v1`
  const usage = []
  const relay = await startGatewayProxy({
    target: `http://127.0.0.1:${kriya.address().port}`,
    encode: false,
    aliases: { orchestra: "own-1" },
    routes: { "own-1": { url: base, model: "deepseek/deepseek-chat", key: KEY, provider: "openrouter" }, "own-2": { url: base, model: "picky/model", key: OTHER, provider: "custom" } },
    onUsage: (u) => usage.push(u),
  })
  const send = (model) => fetch(`${relay.url}/api/harness/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer dev-token", "x-kriya-harness": "2.0.1" }, body: JSON.stringify({ model, stream: true, messages: [] }) }).then((r) => r.text())
  try {
    assert.match(await send("orchestra"), /"hi"/)
    await send("own-2")
    await send("budget")
    await new Promise((r) => setTimeout(r, 50))
    const toProvider = seen.filter((s) => s.to === "provider")
    assert.deepEqual(toProvider.map((s) => [s.auth, s.body.model, s.kriya]), [[`Bearer ${KEY}`, "deepseek/deepseek-chat", undefined], [`Bearer ${OTHER}`, "picky/model", undefined], [`Bearer ${OTHER}`, "picky/model", undefined]])
    assert.equal(toProvider[2].body.stream_options, undefined, "retried once without stream_options")
    assert.deepEqual(seen.filter((s) => s.to === "kriya").map((s) => s.auth), ["Bearer dev-token"], "only the Kriya tier went to Kriya, with the device token")
    assert.deepEqual(usage[0], { provider: "openrouter", model: "deepseek/deepseek-chat", requests: 1, inputTokens: 120, outputTokens: 7, reportedCostMicroUsd: 420 })
    assert.equal(usage.length, 2)
  } finally {
    await relay.close()
    for (const s of [provider, kriya]) await new Promise((done) => s.close(done))
  }
})

test("OM-07: usage figures from JSON, SSE and Groq's x_groq; none when absent", () => {
  assert.deepEqual(usageOf('{"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4}}'), { inputTokens: 3, outputTokens: 4 })
  assert.deepEqual(usageOf('data: {"x_groq":{"usage":{"prompt_tokens":9,"completion_tokens":1}}}\n\ndata: [DONE]\n'), { inputTokens: 9, outputTokens: 1 })
  assert.equal(usageOf("data: {\"choices\":[]}\n\ndata: [DONE]\n"), null)
  assert.deepEqual(usageOf('data: {"usage":{"prompt_tokens":-5,"completion_tokens":"x","cost":-1}}\n'), { inputTokens: 0, outputTokens: 0 })
})

test("OM-08: the reporter batches counts, keeps them on a network error, stops on 404", async () => {
  const posted = []
  let mode = "ok"
  const r = usageReporter({ device: { url: "x", token: "t" }, every: 60_000, post: async (body) => {
    if (mode === "down") throw Object.assign(new Error("down"), { code: "ECONNREFUSED" })
    if (mode === "off") throw new KriyaError(404, "not_found", "Not found.")
    posted.push(body)
  } })
  r.add({ provider: "openrouter", model: "m", requests: 1, inputTokens: 10, outputTokens: 2, reportedCostMicroUsd: 5 })
  r.add({ provider: "openrouter", model: "m", requests: 1, inputTokens: 5, outputTokens: 1 })
  for (let i = 0; i < 60; i++) r.add({ provider: "custom", model: `m${i}`, requests: 1, inputTokens: 1, outputTokens: 1 })
  mode = "down"
  await r.flush()
  assert.equal(r.pending().length, 61, "nothing lost")
  mode = "ok"
  await r.flush()
  assert.deepEqual(posted.map((b) => b.entries.length), [50, 11])
  const all = posted.flatMap((b) => b.entries)
  assert.equal(all.length, 61)
  assert.deepEqual(all.find((e) => e.provider === "openrouter"), { provider: "openrouter", model: "m", requests: 2, inputTokens: 15, outputTokens: 3 }, "a partly reported cost isn't sent")
  mode = "off"
  r.add({ provider: "custom", model: "m", requests: 1, inputTokens: 1, outputTokens: 1 })
  await r.flush()
  r.add({ provider: "custom", model: "m", requests: 1, inputTokens: 1, outputTokens: 1 })
  assert.equal(r.pending().length, 0, "switched off: no more")
  await r.close()
})

test("OM-09: keys never reach a model: tool results redacted by hash, the key file refused", async () => {
  const hashes = new Set(keyHashes((() => {
    const f = tmp()
    saveKey("openrouter", KEY, undefined, f)
    return f
  })()))
  assert.equal(redactKeys(`{"keys":{"openrouter":{"key":"${KEY}"}}}`, hashes), `{"keys":{"openrouter":{"key":"${REDACTED}"}}}`)
  assert.equal(redactKeys(`OPENROUTER_API_KEY=${KEY}`, hashes), `OPENROUTER_API_KEY=${REDACTED}`)
  assert.equal(redactKeys("ordinary words and sk-or-v1-notthekey", hashes), "ordinary words and sk-or-v1-notthekey")
  const hook = redactHook(hashes)
  const viaContent = await hook({}, { content: [{ type: "text", text: `key: ${KEY}` }, { type: "image", data: "x" }] }, async () => ({ kind: "accept" }))
  assert.deepEqual(viaContent.content, [{ type: "text", text: `key: ${REDACTED}` }, { type: "image", data: "x" }])
  const viaValue = await hook({}, { content: [] }, async () => ({ kind: "accept", value: { token: KEY } }))
  assert.equal(viaValue.content[0].text, `{"token":"${REDACTED}"}`)
  const untouched = { kind: "accept" }
  assert.equal(await hook({}, { content: [{ type: "text", text: "fine" }] }, async () => untouched), untouched)
  assert.match(fileGuard({ arguments: { command: "cat ~/.kriya/own-models.json" } }), /out of the agent's reach/)
  assert.equal(fileGuard({ arguments: { command: "ls" } }), undefined)
})

test("OM-10: the Developer tab's own-model actions: off refused; on, the key in and never out", async () => {
  const file = tmp()
  let on = false
  const routes = handler({ folderOf: async () => "/p", run: async () => ({ code: 0, stdout: "", stderr: "" }), ownOn: () => on, ownFile: file, fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ data: [{ id: "deepseek/deepseek-chat", context_length: 65_536 }] }) }) })
  const post = (body) => routes.act(new Request("http://x/api/kriya.cockpit", { method: "POST", body: JSON.stringify({ session: "s", ...body }) }))
  await assert.rejects(post({ action: "own.key.save", provider: "openrouter", key: KEY }), /aren't turned on/)
  on = true
  const saved = await post({ action: "own.key.save", provider: "openrouter", key: KEY })
  assert.ok(!JSON.stringify(saved).includes(KEY), "the answer never carries the key")
  assert.equal(saved.own.providers.find((p) => p.id === "openrouter").last4, KEY.slice(-4))
  assert.deepEqual((await post({ action: "own.models.list", provider: "openrouter" })).models, [{ id: "deepseek/deepseek-chat", contextWindow: 65_536 }])
  await post({ action: "own.model.add", provider: "openrouter", model: "deepseek/deepseek-chat", contextWindow: 65_536 })
  const set = await post({ action: "own.orchestra", orchestra: { head: "own-1", worker: "budget" } })
  assert.deepEqual(set.own.orchestra, { head: "own-1", worker: "budget" })
  assert.ok(set.own.choices.some((c) => c.id === "own-1"))
  const view = await routes.read(new Request("http://x/api/kriya.cockpit?session=s"))
  assert.ok(!JSON.stringify(view).includes(KEY))
  assert.ok(readFileSync(file, "utf8").includes(KEY), "kept on this computer")
})
