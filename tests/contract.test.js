import assert from "node:assert/strict"
import { after, before, test } from "node:test"

import { deviceCode, deviceToken, KriyaError, me, models, revokeDevice } from "../src/api.js"
import { CLIENT_VERSION } from "../src/paths.js"
import { startFakeKriya } from "./fake-kriya.js"
import { contract, route, violations } from "./helpers.js"

// Contract tests (API_AND_CONTRACTS §8, client side): every request this
// client sends, and every answer the fake gives it, matches the pinned copy
// of docs/kriya-harness/contract.json (contract/SOURCE.md). A fake that
// drifted from the contract would make every other test meaningless.

let fake
before(async () => {
  fake = await startFakeKriya({ approveAfter: 0 })
})
after(() => fake.close())

const last = () => fake.state.requests.at(-1)

function checkExchange(method, path) {
  const exchange = last()
  const shape = route(method, path)
  assert.equal(exchange.method, method)
  assert.equal(exchange.path, path)
  assert.equal(exchange.headers[contract.headers.version.toLowerCase()], CLIENT_VERSION)
  assert.deepEqual(violations(shape.request, exchange.body), [], `${method} ${path} request`)
  if (exchange.status < 300)
    assert.deepEqual(violations(shape.response, exchange.response), [], `${method} ${path} response`)
  else assert.deepEqual(violations(contract.error, exchange.response), [], `${method} ${path} error`)
  assert.equal(!!exchange.headers.authorization, shape.auth, `${method} ${path} auth`)
}

test("the client version is plain x.y.z, as clientVersion and X-Kriya-Harness require", () => {
  assert.match(CLIENT_VERSION, /^\d{1,3}\.\d{1,3}\.\d{1,3}$/)
})

test("the device flow, /me, /models and DELETE /device match the contract", async () => {
  const code = await deviceCode(fake.url, { deviceName: "Test laptop", platform: "darwin" })
  checkExchange("POST", "/device/code")
  const { token } = await deviceToken(fake.url, code.deviceCode)
  checkExchange("POST", "/device/token")
  await me(fake.url, token)
  checkExchange("GET", "/me")
  await models(fake.url, token)
  checkExchange("GET", "/models")
  await revokeDevice(fake.url, token)
  checkExchange("DELETE", "/device")
})

test("errors are thrown with the contract's code and message", async () => {
  await assert.rejects(me(fake.url, "not-a-token"), (error) => {
    assert.ok(error instanceof KriyaError)
    assert.equal(error.status, 401)
    assert.equal(error.code, "unauthorized")
    assert.match(error.message, /kriya login/)
    return true
  })
  assert.deepEqual(violations(contract.error, last().response), [])
})

test("an unreachable Kriya is a plain network error, not a stack", async () => {
  await assert.rejects(me("http://127.0.0.1:9", "x"), (error) => {
    assert.equal(error.code, "network")
    assert.match(error.message, /Couldn't reach/)
    return true
  })
})

test("the contract covers every route this client calls", () => {
  const called = new Set(["POST /device/code", "POST /device/token", "GET /me", "GET /models", "DELETE /device", "POST /chat/completions", "POST /approvals", "GET /approvals/{id}", "DELETE /approvals/{id}", "POST /sessions", "POST /sessions/{id}/turns", "GET /skills", "GET /skills/{id}/{version}", "POST /memory/search", "POST /memory"])
  const known = new Set(contract.routes.map((r) => `${r.method} ${r.path}`))
  for (const name of called) assert.ok(known.has(name), name)
  assert.equal(contract.basePath, "/api/harness/v1")
})

test("contract.json is the recorded copy (contract/SOURCE.md), not hand-edited", async () => {
  const { createHash } = await import("node:crypto")
  const { readFileSync } = await import("node:fs")
  const { join } = await import("node:path")
  const { ROOT } = await import("./helpers.js")
  const recorded = /sha256 \| `([0-9a-f]{64})`/.exec(readFileSync(join(ROOT, "contract", "SOURCE.md"), "utf8"))?.[1]
  const actual = createHash("sha256").update(readFileSync(join(ROOT, "contract", "contract.json"))).digest("hex")
  assert.equal(actual, recorded)
})
