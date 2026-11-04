import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { test } from "node:test"

import { explain, htmlFilter, launchEnv, modelLimits, modelNames, planTiers, startTier, TOKEN_ENV } from "../src/launch.js"
import { freshHome, ROOT } from "./helpers.js"

// The device token reaches DSH only as a launch variable, and DSH removes
// credential-shaped variables from every shell the agent runs. If DSH ever
// changes that pattern, or the variable is renamed, a model's `echo` could
// print the token: this test fails first.

const require = createRequire(join(ROOT, "package.json"))
const subprocess = await import(require.resolve("@deepseek-ai/dsh-subprocess"))

test("DSH scrubs the token variable from agent shells", () => {
  assert.ok(subprocess.SENSITIVE_ENV_PATTERN.test(TOKEN_ENV))
  const before = process.env[TOKEN_ENV]
  process.env[TOKEN_ENV] = "secret-for-test"
  try {
    assert.equal(subprocess.scrubbedParentEnv()[TOKEN_ENV], undefined)
  } finally {
    if (before === undefined) delete process.env[TOKEN_ENV]
    else process.env[TOKEN_ENV] = before
  }
})

test("launch variables: the sign-in's token and gateway only, telemetry off", () => {
  const home = freshHome()
  const env = launchEnv(
    { url: "https://k.example", token: "t1" },
    { PATH: "/bin", KRIYA_DEVICE_TOKEN: "from-shell", KRIYA_GATEWAY_URL: "https://evil.example" }
  )
  assert.equal(env.KRIYA_DEVICE_TOKEN, "t1")
  assert.equal(env.KRIYA_GATEWAY_URL, "https://k.example/api/harness/v1")
  assert.equal(env.DSH_HOME, home)
  assert.equal(env.DSH_TELEMETRY_DISABLED, "1")
  assert.equal(env.PATH, "/bin")

  const signedOut = launchEnv(null, { KRIYA_DEVICE_TOKEN: "from-shell", KRIYA_GATEWAY_URL: "https://evil.example" })
  assert.equal(signedOut.KRIYA_DEVICE_TOKEN, undefined)
  assert.equal(signedOut.KRIYA_GATEWAY_URL, undefined)
})

test("the session starts on balanced, or the best tier the plan allows", async () => {
  const device = { url: "https://k.example", token: "t1" }
  const plan = (...ids) => async () => ({ data: ids.map((id) => ({ id })) })
  assert.equal(await startTier(device, plan("budget")), "budget")
  assert.equal(await startTier(device, plan("budget", "balanced")), "balanced")
  assert.equal(await startTier(device, plan("escalation")), "escalation")
  assert.equal(await startTier(device, plan()), "balanced")
  assert.equal(await startTier(device, async () => { throw new Error("offline") }), "balanced")
  assert.equal(await startTier(null), "balanced")
  // Never from the shell, never an unknown alias
  assert.equal(launchEnv(device, { KRIYA_START_TIER: "escalation" }).KRIYA_START_TIER, "balanced")
  assert.equal(launchEnv(device, {}, undefined, "budget").KRIYA_START_TIER, "budget")
  assert.equal(launchEnv(device, {}, undefined, "gpt-5").KRIYA_START_TIER, "balanced")
})

test("kriya run drops a host's HTML error page, in any chunking, and keeps every other line", () => {
  const page = 'dsh: SERVER: 503 <!DOCTYPE html>\n<html lang="en">\n<body>Down</body>\n</html>\n'
  const text = "dsh: reasoning: fixing\n" + page + "after the page\nlast"
  for (const size of [1, 7, text.length]) {
    let out = ""
    const filter = htmlFilter((t) => (out += t))
    for (let i = 0; i < text.length; i += size) filter.push(text.slice(i, i + size))
    filter.end()
    assert.equal(out, "dsh: reasoning: fixing\nafter the page\nlast", `chunks of ${size}`)
    assert.match(filter.explained, /HTTP 503/)
  }
  // A one-line page, and Kriya's own JSON refusals pass through untouched
  let out = ""
  const filter = htmlFilter((t) => (out += t))
  filter.push('dsh: SERVER: 502 <html><body>x</body></html>\nPI_AI_ERROR: 402 "cap_reached"\n')
  filter.end()
  assert.equal(out, 'PI_AI_ERROR: 402 "cap_reached"\n')
  assert.match(filter.explained, /HTTP 502/)
  const quiet = htmlFilter(() => {})
  quiet.push("dsh: ok\n")
  assert.equal(quiet.explained, null)
})

test("every refusal code in the contract has a plain sentence for kriya run", async () => {
  const { REFUSALS, explain } = await import("../src/launch.js")
  const { contract } = await import("./helpers.js")
  // The device sign-in's own codes; kriya login words those itself
  const codes = contract.error.properties.error.enum.filter((code) => !["pending", "denied", "expired"].includes(code))
  for (const code of codes) {
    assert.ok(REFUSALS[code], code)
    // Kriya's words only: no upstream name, status line or raw code
    assert.doesNotMatch(REFUSALS[code], /deepseek|\bdsh\b|PI_AI|HTTP \d|[a-z]+_[a-z]+/i, code)
  }
  assert.equal(explain('dsh: PI_AI_ERROR: 429 "rate_limited"'), REFUSALS.rate_limited)
  assert.equal(explain('dsh: PI_AI_ERROR: 500 "something_else"'), null)
  assert.equal(explain("no error here"), null)
})

test("the model picker offers only the plan's tiers, so none fails with tier_not_allowed", async () => {
  const device = { url: "https://k.example", token: "t1" }
  const plan = (...ids) => async () => ({ data: ids.map((id) => ({ id })) })
  assert.deepEqual(await planTiers(device, plan("budget")), { start: "budget", allowed: ["budget"], names: {}, limits: {}, encodings: [] })
  assert.deepEqual(await planTiers(device, plan("escalation", "budget", "balanced")), { start: "balanced", allowed: ["balanced", "budget", "escalation"], names: {}, limits: {}, encodings: [] })
  // The body forms Kriya decodes (src/gateway-proxy.js), strings only; none from an older Kriya
  const withEncodings = async () => ({ data: [{ id: "budget" }], bodyEncodings: ["gzip+base64", 7] })
  assert.deepEqual((await planTiers(device, withEncodings)).encodings, ["gzip+base64"])
  assert.deepEqual((await planTiers(device, async () => { throw new Error("offline") })).encodings, [])
  // Unknown aliases are dropped; nothing usable, or Kriya unreachable: all three (the gateway still refuses)
  assert.deepEqual((await planTiers(device, plan("gpt-5"))).allowed, ["balanced", "budget", "escalation"])
  assert.deepEqual((await planTiers(device, async () => { throw new Error("offline") })).allowed, ["balanced", "budget", "escalation"])
  assert.equal(launchEnv(device, {}, undefined, "budget", ["budget"]).KRIYA_ALLOWED_TIERS, "budget")
  // Never from the shell
  assert.equal(launchEnv(device, { KRIYA_ALLOWED_TIERS: "escalation" }).KRIYA_ALLOWED_TIERS, "balanced,budget,escalation")
  assert.equal(launchEnv(device, {}, undefined, "budget", ["budget", "gpt-5"]).KRIYA_ALLOWED_TIERS, "budget")
  assert.match(explain('PI_AI_ERROR: 400 "tier_not_allowed"'), /model picker/)
})

test("the picker names each tier after the owner's model; the same model twice says which tier", () => {
  const m = (id, name) => ({ id, object: "model", owned_by: "kriya", ...(name && { name }) })
  assert.deepEqual(modelNames([m("budget", "DeepSeek V4.1 Flash")], ["budget"]), { budget: "DeepSeek V4.1 Flash" })
  assert.deepEqual(
    modelNames([m("budget", "DeepSeek V4.1 Flash"), m("balanced", "DeepSeek V4.1 Flash"), m("escalation", "Claude Sonnet")], ["budget", "balanced", "escalation"]),
    { budget: "DeepSeek V4.1 Flash · budget", balanced: "DeepSeek V4.1 Flash · balanced", escalation: "Claude Sonnet" }
  )
  // Unnamed, unusable or not allowed: no name (the row keeps "Kriya <tier>")
  assert.deepEqual(modelNames([m("budget"), m("balanced", "<b>x</b>"), m("escalation", "Fine")], ["budget", "balanced"]), {})
  const env = launchEnv({ url: "https://k.example", token: "t" }, { KRIYA_MODEL_NAMES: '{"budget":"Evil"}' }, undefined, "budget", ["budget"], { budget: "DeepSeek V4.1 Flash", gpt: "x" })
  assert.equal(env.KRIYA_MODEL_NAMES, '{"budget":"DeepSeek V4.1 Flash"}')
  assert.equal(launchEnv(null, { KRIYA_MODEL_NAMES: '{"budget":"Evil"}' }).KRIYA_MODEL_NAMES, "{}")
})

test("the kriya provider row lists exactly the allowed tiers", () => {
  const dump = readFileSync(join(ROOT, "expected", "kriya.dump.yml"), "utf8")
  const expr = /models: !!js >-\n((?: {10}.*\n)+)/.exec(dump)[1].replace(/\n {10}/g, " ").trim()
  const list = (tiers, names) =>
    new Function("process", `return ${expr}`)({ env: { ...(tiers !== undefined && { KRIYA_ALLOWED_TIERS: tiers }), ...(names !== undefined && { KRIYA_MODEL_NAMES: names }) } })
  assert.deepEqual(list("budget"), [{ id: "budget", name: "Kriya budget" }])
  assert.deepEqual(list("balanced,escalation").map((m) => m.id), ["balanced", "escalation"])
  assert.deepEqual(list(undefined).map((m) => m.id), ["balanced", "budget", "escalation"])
  assert.deepEqual(list("budget", '{"budget":"DeepSeek V4.1 Flash"}'), [{ id: "budget", name: "DeepSeek V4.1 Flash" }])
  // A broken value never breaks the picker
  assert.deepEqual(list("budget", "{not json"), [{ id: "budget", name: "Kriya budget" }])
})

// Harness upgrade U3 (HU-CL-01): each tier declares what its model holds, so
// DSH compacts before the real window is full; no limits from Kriya, DSH's
// defaults exactly as before
test("HU-CL-01: model limits reach the provider row and compaction, never from the shell", async () => {
  const m = (id, contextWindow, maxOutputTokens) => ({ id, object: "model", owned_by: "kriya", contextWindow, maxOutputTokens })
  assert.deepEqual(modelLimits([m("budget", 131072, 16384), m("balanced", 32768, 16384), m("escalation", 0, 1), { id: "x" }], ["budget", "balanced", "escalation"]), {
    budget: { contextWindow: 131072, maxTokens: 16384, headroomTokens: 32768 },
    // A small window: output and headroom a quarter each, so W − O − headroom stays positive
    balanced: { contextWindow: 32768, maxTokens: 8192, headroomTokens: 8192 },
  })
  // A bigger window than the working one (the budget tier's 1,048,576) is used up to 262,144 only, with DSH's own headroom
  assert.deepEqual(modelLimits([m("budget", 1048576, 16384)], ["budget"]).budget, { contextWindow: 262144, maxTokens: 16384, headroomTokens: 65536 })
  const device = { url: "https://k.example", token: "t1" }
  const tiers = await planTiers(device, async () => ({ data: [m("budget", 131072, 16384)] }))
  assert.deepEqual(tiers.limits, { budget: { contextWindow: 131072, maxTokens: 16384, headroomTokens: 32768 } })
  assert.equal(launchEnv(device, { KRIYA_MODEL_LIMITS: '{"budget":{"contextWindow":1}}' }).KRIYA_MODEL_LIMITS, "{}")

  const dump = readFileSync(join(ROOT, "expected", "kriya.dump.yml"), "utf8")
  const row = (re) => re.exec(dump)[1].replace(/\n {6,10}/g, " ").trim()
  const models = row(/models: !!js >-\n((?: {10}.*\n)+)/)
  const policies = row(/modelPolicies: !!js >-\n((?: {6}.*\n)+)/)
  const run = (expr, env) => new Function("process", `return ${expr}`)({ env })
  const limits = JSON.stringify(tiers.limits)
  assert.deepEqual(run(models, { KRIYA_ALLOWED_TIERS: "budget", KRIYA_MODEL_LIMITS: limits }), [{ id: "budget", name: "Kriya budget", contextWindow: 131072, maxTokens: 16384 }])
  assert.deepEqual(run(policies, { KRIYA_MODEL_LIMITS: limits }), [{ provider: "kriya", model: "budget", headroomTokens: 32768 }])
  // None, or a broken value: DSH's defaults
  assert.deepEqual(run(models, { KRIYA_ALLOWED_TIERS: "budget" }), [{ id: "budget", name: "Kriya budget" }])
  assert.deepEqual(run(policies, {}), [])
  assert.deepEqual(run(policies, { KRIYA_MODEL_LIMITS: "{not json" }), [])
})
