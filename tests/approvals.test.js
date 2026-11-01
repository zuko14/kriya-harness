import assert from "node:assert/strict"
import { after, afterEach, before, beforeEach, test } from "node:test"

import { Context } from "@deepseek-ai/cordis"

import * as approvals from "../plugins/approvals/index.js"
import { BASE_PATH } from "../src/api.js"
import { startFakeKriya } from "./fake-kriya.js"
import { route, violations } from "./helpers.js"

// H5 client part (HD-08): the Kriya approvals plugin in a real cordis
// Context from the pinned DSH, dispatched the way dsh-user-approval does
// (`approval/request` waterfall, "unavailable" innermost), against the fake
// Kriya. A test-registered listener stands in for DSH's local prompt.

const PHONE_LINE = "Waiting for your answer here or in Kriya on your phone."

let fake
let token
before(async () => {
  fake = await startFakeKriya()
  token = fake.issueToken()
})
after(() => fake.close())

let script
let stderr
const write = process.stderr.write
beforeEach(() => {
  script = {}
  stderr = ""
  process.stderr.write = (chunk) => ((stderr += chunk), true)
  process.env.KRIYA_DEVICE_TOKEN = token
  process.env.KRIYA_GATEWAY_URL = `${fake.url}${BASE_PATH}`
  fake.state.requests.length = 0
})
afterEach(() => {
  process.stderr.write = write
})

// What DSH's local prompt does in a test: answer after `ms`, or wait until
// withdrawn ("cancelled"), or not exist ("unavailable", as in headless)
function localPrompt(behaviour) {
  return (req, next) => {
    behaviour.seen = req
    if (behaviour.none) return next()
    return new Promise((done) => {
      req.signal?.addEventListener("abort", () => done("cancelled"), { once: true })
      if (behaviour.answer) setTimeout(() => done(behaviour.answer), behaviour.ms ?? 50)
    })
  }
}

async function compose(local) {
  const ctx = new Context()
  await ctx.plugin(approvals)
  if (local) ctx.on("approval/request", localPrompt(local))
  return ctx
}

const ask = (ctx, req = {}) =>
  ctx.waterfall({}, "approval/request", { agent: { sessionId: "sess-1" }, toolName: "bash", callId: "call-1", reason: "Run the tests", ...req }, () =>
    Promise.resolve("unavailable")
  )

// The phone answers once the request reaches Kriya
function phone(status, ms = 50) {
  fake.state.approvals.clear()
  const timer = setInterval(() => {
    const [approval] = fake.state.approvals.values()
    if (approval) {
      clearInterval(timer)
      setTimeout(() => (status === "expired" ? fake.expire(approval.id) : fake.answer(approval.id, status)), ms)
    }
  }, 10)
}

const only = () => [...fake.state.approvals.values()][0]
const sent = (method, path) => fake.state.requests.filter((r) => r.method === method && (path instanceof RegExp ? path.test(r.path) : r.path === path))

async function until(check, ms = 3000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((done) => setTimeout(done, 20))
  }
}

test("the phone approves first: allowed once, and DSH's prompt is withdrawn", async () => {
  const local = {}
  const ctx = await compose(local)
  phone("approved")
  assert.equal(await ask(ctx), "allowed-once")
  assert.equal(local.seen.signal.aborted, true)
  assert.match(local.seen.displayReason.en, new RegExp(`Run the tests\\n\\n${PHONE_LINE}`))
  assert.equal(only().status, "approved")
  assert.equal(sent("DELETE", /^\/approvals\//).length, 0)
})

test("the phone declines: rejected", async () => {
  const ctx = await compose({})
  phone("declined")
  assert.equal(await ask(ctx), "rejected")
})

test("answered here first: that answer stands and the request is canceled on Kriya", async () => {
  fake.state.approvals.clear()
  const ctx = await compose({ answer: "allowed-once", ms: 100 })
  assert.equal(await ask(ctx), "allowed-once")
  await until(() => only()?.status === "canceled")
  assert.equal(sent("DELETE", /^\/approvals\//).length, 1)
})

test("headless (no local prompt): waits for the phone and says so on stderr", async () => {
  const ctx = await compose({ none: true })
  phone("approved", 150)
  assert.equal(await ask(ctx), "allowed-once")
  assert.match(stderr, /bash needs your OK\. Waiting for your answer in Kriya on your phone\./)
})

test("the request expires on Kriya: the local prompt still decides; with none it fails closed", async () => {
  let ctx = await compose({ answer: "rejected", ms: 300 })
  phone("expired", 20)
  assert.equal(await ask(ctx), "rejected")
  ctx = await compose({ none: true })
  phone("expired", 20)
  assert.equal(await ask(ctx), "unavailable")
})

test("Kriya unreachable or refusing: only the local prompt answers; with none it fails closed", async () => {
  process.env.KRIYA_GATEWAY_URL = `http://127.0.0.1:9${BASE_PATH}`
  assert.equal(await ask(await compose({ answer: "allowed-once" })), "allowed-once")
  assert.equal(await ask(await compose({ none: true })), "unavailable")
  const refusing = await startFakeKriya({ approvalsError: { status: 403, error: "suspended", message: "Paused." } })
  try {
    process.env.KRIYA_GATEWAY_URL = `${refusing.url}${BASE_PATH}`
    process.env.KRIYA_DEVICE_TOKEN = refusing.issueToken()
    const local = { answer: "rejected" }
    assert.equal(await ask(await compose(local)), "rejected")
    // The local prompt got the original request, not the phone copy
    assert.equal(local.seen.displayReason, undefined)
  } finally {
    await refusing.close()
  }
})

test("signed out: the plugin steps aside and Kriya isn't asked", async () => {
  delete process.env.KRIYA_DEVICE_TOKEN
  assert.equal(await ask(await compose({ answer: "allowed-once" })), "allowed-once")
  assert.equal(fake.state.requests.length, 0)
})

test("the tool call is canceled: the request is withdrawn on both sides", async () => {
  fake.state.approvals.clear()
  const ctx = await compose({})
  const controller = new AbortController()
  const asking = ask(ctx, { signal: controller.signal })
  await until(() => only() !== undefined)
  controller.abort()
  assert.equal(await asking, "cancelled")
  await until(() => only().status === "canceled")
})

test("the request is the contract: the call's arguments, secrets redacted before they leave, folder and session", async () => {
  const ctx = await compose({})
  // DSH's tools pipeline runs this before it asks; the plugin only watches
  const decision = await ctx.waterfall(
    {},
    "tools/pre-execute",
    { callId: "call-7", name: "web_fetch", arguments: { url: "https://example.test", apiKey: "sk-local", headers: { Authorization: "Bearer x" } } },
    () => Promise.resolve({ kind: "ask", reason: "network" })
  )
  assert.deepEqual(decision, { kind: "ask", reason: "network" })
  phone("approved")
  await ask(ctx, { toolName: "web_fetch", callId: "call-7" })
  const [request] = sent("POST", "/approvals")
  assert.deepEqual(violations(route("POST", "/approvals").request, request.body), [])
  assert.deepEqual(request.body.input, {
    url: "https://example.test",
    apiKey: "[redacted]",
    headers: { Authorization: "[redacted]" },
  })
  assert.equal(request.body.tool, "web_fetch")
  assert.equal(request.body.sessionRef, "sess-1")
  assert.doesNotMatch(JSON.stringify(request.body), /sk-local|Bearer x/)
  for (const r of sent("GET", /^\/approvals\//)) assert.deepEqual(violations(route("GET", "/approvals/{id}").response, r.response), [])
})

test("large or unknown arguments still make a valid request", async () => {
  assert.ok(JSON.stringify(approvals.inputFor({ diff: "x\"".repeat(9_000) })).length <= 8 * 1024)
  assert.deepEqual(approvals.inputFor(undefined), { arguments: "not shared by this tool" })
  assert.deepEqual(approvals.inputFor(["a"]), { arguments: ["a"] })
  const ctx = await compose({})
  phone("approved")
  await ask(ctx, { callId: "never-seen", reason: undefined })
  const [request] = sent("POST", "/approvals")
  assert.deepEqual(violations(route("POST", "/approvals").request, request.body), [])
  assert.equal(request.body.summary, "Run bash")
})
