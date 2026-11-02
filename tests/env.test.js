import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { join } from "node:path"
import { test } from "node:test"

import { htmlFilter, launchEnv, startTier, TOKEN_ENV } from "../src/launch.js"
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
