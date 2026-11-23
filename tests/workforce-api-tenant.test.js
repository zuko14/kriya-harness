import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import { CONTRACT_NAMES } from "../src/contracts.js"
import { apiGate, badBodies } from "../src/gates/api.js"
import { local } from "../src/gates/http.js"
import { committedRules, sastGate } from "../src/gates/sast.js"
import { tenantConfig, tenantGate } from "../src/gates/tenant.js"
import { planTool } from "../plugins/loop/index.js"
import { ROLES } from "../src/cartridges.js"
import { validatePlan } from "../src/loop.js"
import { useStack } from "../src/stack.js"
import { confirmCheck, readProgress, verifyStep } from "../src/verify.js"
import { freshHome } from "./helpers.js"

// Harness 2.0 W5: G-API and G-TENANT against a real orders API this test
// serves on 127.0.0.1, with a switch per defect (each defect fails its gate,
// the correct server passes); G-SAST with a scripted Semgrep; spec-test steps
// judged red; the plan rules. WT-GATE-API-*, WT-GATE-TEN-*, WT-GATE-SAST-*, WT-PLAN-*.

// ── an orders API with switchable defects ──
let mode = new Set()
let orders = new Map()
let seen = new Map()
let next = 1
const users = { "t-a": "u-a", "t-b": "u-b" }
const send = (res, status, body) => res.writeHead(status, { "content-type": "application/json" }).end(body === undefined ? "" : JSON.stringify(body))
let server
let base
before(async () => {
  // A thrown error answers 500, as a real framework would
  server = createServer((req, res) => handle(req, res).catch(() => res.headersSent || send(res, 500, { error: "server error" })))
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => server?.close())

async function handle(req, res) {
  {
    let raw = ""
    for await (const c of req) raw += c
    let body
    try {
      body = raw ? JSON.parse(raw) : undefined
    } catch {
      return send(res, mode.has("crash-on-bad-json") ? 500 : 400, { error: "bad json" })
    }
    const url = new URL(req.url, "http://x")
    if (url.pathname === "/api/test/sign-in") return send(res, 200, { token: mode.has("same-identity") ? "t-a" : body?.user === "b" ? "t-b" : "t-a" })
    const me = users[(req.headers.authorization ?? "").replace("Bearer ", "")]
    if (!me) return send(res, 401, { error: "sign in" })
    if (url.pathname === "/api/me") return send(res, 200, { id: me })
    if (mode.has("refuse-all")) return send(res, 404, { error: "nope" })
    if (url.pathname === "/api/orders/count") return send(res, 200, { count: [...orders.values()].filter((o) => o.owner === me).length })
    if (url.pathname === "/api/orders" && req.method === "GET") return send(res, 200, [...orders.values()].filter((o) => mode.has("idor-list") || o.owner === me))
    if (url.pathname === "/api/orders" && req.method === "POST") {
      if (!mode.has("no-validation") && (typeof body?.item !== "string" || body.item.length > 20 || !Number.isInteger(body?.qty))) return send(res, 400, { error: "invalid" })
      const key = req.headers["idempotency-key"]
      if (key && !mode.has("no-idempotency") && seen.has(key)) return send(res, 200, seen.get(key))
      const order = { id: next++, owner: me, item: body.item.toUpperCase(), qty: body.qty }
      orders.set(order.id, order)
      if (key) seen.set(key, order)
      return send(res, 201, order)
    }
    const m = /^\/api\/orders\/(\d+)$/.exec(url.pathname)
    if (m) {
      const o = orders.get(Number(m[1]))
      const mine = o && (o.owner === me || (req.method === "GET" && mode.has("idor-read")) || (req.method === "PATCH" && mode.has("idor-update")))
      if (!mine) return send(res, 404, { error: "not found" })
      if (req.method === "GET") return send(res, 200, o)
      if (req.method === "PATCH") return (Object.assign(o, body), send(res, 200, o))
      if (req.method === "DELETE") return (orders.delete(o.id), send(res, 204))
    }
    send(res, 404, { error: "no route" })
  }
}

const API = {
  openapi: "3.1.0",
  info: { title: "orders", version: "1" },
  paths: {
    "/api/orders": {
      post: {
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/NewOrder" } } } },
        responses: { 201: { description: "made", content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } } }, 400: { description: "invalid" } },
        "x-kriya-example": { auth: "A", body: { item: "tea", qty: 2 }, status: 201 },
        "x-kriya-idempotent": { count: "/api/orders/count" },
      },
      get: { responses: { 200: { description: "mine", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Order" } } } } } }, "x-kriya-example": { auth: "A" } },
    },
  },
  components: {
    schemas: {
      NewOrder: { type: "object", required: ["item", "qty"], properties: { item: { type: "string", maxLength: 20 }, qty: { type: "integer" } } },
      Order: { type: "object", required: ["id", "item", "qty"], properties: { id: { type: "integer" }, item: { type: "string" }, qty: { type: "integer" } } },
    },
  },
}
const MATRIX = ["create", "read", "update", "delete", "list"].map((action) => ({ resource: "orders", action, roles: ["member"], tenantScoped: true }))
const TENANTS = {
  signIn: { path: "/api/test/sign-in", method: "POST" },
  tenants: { A: { body: { user: "a" } }, B: { body: { user: "b" } } },
  token: { from: "json", field: "token" },
  whoami: { path: "/api/me", field: "id" },
  resources: { orders: { create: { path: "/api/orders", body: { item: "b-secret", qty: 1 } }, read: { path: "/api/orders/{id}" }, update: { path: "/api/orders/{id}", method: "PATCH", body: { item: "hacked" } }, delete: { path: "/api/orders/{id}" }, list: { path: "/api/orders" } } },
}

function project({ api = API, matrix = MATRIX, tenants = TENANTS, app = true } = {}) {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-api-")))
  mkdirSync(join(dir, ".kriya", "contracts"), { recursive: true })
  mkdirSync(join(dir, ".kriya", "gates"), { recursive: true })
  if (api) writeFileSync(join(dir, ".kriya", "contracts", "api.openapi.json"), JSON.stringify(api))
  if (matrix) writeFileSync(join(dir, ".kriya", "contracts", "auth_matrix.json"), JSON.stringify(matrix))
  if (tenants) writeFileSync(join(dir, ".kriya", "gates", "tenants.json"), JSON.stringify(tenants))
  if (app) useStack(dir, { app: base })
  return dir
}
const reset = (...defects) => {
  mode = new Set(defects)
  orders = new Map()
  seen = new Map()
}

test("WT-GATE-API-00: the loopback helper refuses other hosts before sending; bad bodies are deterministic", async () => {
  let sent = 0
  await assert.rejects(local("https://example.com", "/x", { request: async () => (sent++, new Response("")) }), /refused/)
  assert.equal(sent, 0)
  const bodies = badBodies(API.components.schemas.NewOrder, { item: "tea", qty: 2 })
  assert.deepEqual(bodies.map(([why]) => why), ['without required "item"', 'without required "qty"', '"item" of the wrong type', '"qty" of the wrong type', '"item" longer than its maxLength 20', "a body that isn't JSON"])
  assert.deepEqual(badBodies(API.components.schemas.NewOrder, { item: "tea", qty: 2 }), bodies)
})

test("WT-GATE-API-01: the correct server passes: examples match the schema, bad inputs get 4xx, ten requests with one key make one order", async () => {
  reset()
  const r = await apiGate({ root: project() })
  assert.equal(r.status, "pass", r.excerpt)
  assert.match(r.note, /latency p50/)
})

for (const [defect, pattern] of [
  ["no-validation", /without required "item": answered (500|201), expected a 4xx/],
  ["crash-on-bad-json", /a body that isn't JSON: answered 500/],
  ["no-idempotency", /made 10 effects, expected 1/],
])
  test(`WT-GATE-API mutant ${defect}: fails with the reason`, async () => {
    reset(defect)
    const r = await apiGate({ root: project() })
    assert.equal(r.status, "fail")
    assert.match(r.excerpt, pattern)
  })

test("WT-GATE-API-02: a body that breaks the contract's schema fails; no app is an optional not-checked; no example is not-checked", async () => {
  reset()
  const wrong = structuredClone(API)
  wrong.components.schemas.Order.properties.item = { type: "integer" }
  const r = await apiGate({ root: project({ api: wrong }) })
  assert.equal(r.status, "fail")
  assert.match(r.excerpt, /doesn't match the contract: \/item must be integer/)
  const none = await apiGate({ root: project({ app: false }) })
  assert.equal(none.status, "not_checked")
  assert.equal(none.optional, true)
  const bare = structuredClone(API)
  delete bare.paths["/api/orders"].post["x-kriya-example"]
  delete bare.paths["/api/orders"].get["x-kriya-example"]
  assert.equal((await apiGate({ root: project({ api: bare }) })).status, "not_checked")
})

test("WT-GATE-TEN-01: the correct server passes every probe with its paired control", async () => {
  reset()
  const r = await tenantGate({ root: project() })
  assert.equal(r.status, "pass", r.excerpt)
})

for (const [defect, pattern] of [
  ["idor-read", /tenant A read B's #\d+ \(expected 403\/404, got 200\)/],
  ["idor-list", /tenant A's list includes B's #\d+/],
  ["idor-update", /tenant A changed B's #\d+/],
  ["same-identity", /A and B are the same user/],
  ["refuse-all", /control failed: B couldn't create one/],
])
  test(`WT-GATE-TEN mutant ${defect}: fails with the reason`, async () => {
    reset(defect)
    const r = await tenantGate({ root: project() })
    assert.equal(r.status, "fail", JSON.stringify(r))
    assert.match(r.excerpt, pattern)
    assert.doesNotMatch(r.excerpt, /t-a|t-b|Bearer/)
  })

test("WT-GATE-TEN-02: nothing tenant-scoped passes; a missing or malformed tenants.json, or a resource without probes, can't pass", async () => {
  reset()
  assert.equal((await tenantGate({ root: project({ matrix: [{ resource: "faq", action: "read", roles: ["*"], tenantScoped: false }] }) })).status, "pass")
  const missing = await tenantGate({ root: project({ tenants: null }) })
  assert.equal(missing.status, "not_checked")
  assert.ok(!missing.optional)
  assert.match(tenantConfig(project({ tenants: { ...TENANTS, token: { from: "header" } } })).problem, /tenants\.json/)
  const partial = await tenantGate({ root: project({ tenants: { ...TENANTS, resources: { orders: { create: TENANTS.resources.orders.create } } } }) })
  assert.equal(partial.status, "fail")
  assert.match(partial.excerpt, /the matrix allows "read" but tenants\.json has no call/)
})

// ── G-SAST with a scripted Semgrep, rules from real git ──
const GIT = { GIT_AUTHOR_NAME: "P", GIT_AUTHOR_EMAIL: "p@x", GIT_COMMITTER_NAME: "P", GIT_COMMITTER_EMAIL: "p@x" }
function repo(files) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-sast-")))
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  const git = (...a) => execFileSync("git", a, { cwd: dir, env: { ...process.env, ...GIT } })
  git("init", "-q", "-b", "main")
  git("add", "-A")
  git("commit", "-q", "-m", "base")
  return dir
}

test("WT-GATE-SAST-01: rules come from HEAD (an emptied working copy changes nothing); never a registry config; ERROR findings fail", async () => {
  const dir = repo({ ".semgrep.yml": "rules:\n  - id: no-eval\n", "src/a.js": "ok()\n" })
  writeFileSync(join(dir, ".semgrep.yml"), "rules: []\n")
  writeFileSync(join(dir, "src/a.js"), "eval(x)\n")
  const calls = []
  const real = async (cmd, args, options) => {
    if (cmd !== "semgrep") {
      const { execFile } = await import("node:child_process")
      return new Promise((done) => execFile(cmd, args, options, (e, so, se) => done({ code: e ? 1 : 0, stdout: String(so), stderr: String(se) })))
    }
    calls.push(args)
    if (args[0] === "--version") return { code: 0, stdout: "1.99.0" }
    const rules = (await import("node:fs")).readFileSync(args[args.indexOf("--config") + 1], "utf8")
    assert.match(rules, /no-eval/, "the committed rules, not the emptied copy")
    return { code: 0, stdout: JSON.stringify({ results: [{ path: "src/a.js", start: { line: 1 }, check_id: "no-eval", extra: { severity: "ERROR", message: "eval of input" } }] }) }
  }
  const r = await sastGate({ root: dir, changed: [".semgrep.yml", "src/a.js"], run: real })
  assert.equal(r.status, "fail")
  assert.match(r.excerpt, /src\/a\.js:1 no-eval/)
  const scan = calls.find((a) => a[0] === "scan")
  assert.ok(!scan.includes("auto") && scan.includes("--metrics") && scan[scan.indexOf("--metrics") + 1] === "off")
  assert.equal((await committedRules(repo({ "a.txt": "x" }), mkdtempSync(join(tmpdir(), "r-")))).reason !== undefined, true)
  assert.equal((await sastGate({ root: dir, changed: ["src/a.js"], run: async () => ({ code: -1, missing: true }) })).status, "not_checked")
})

// ── spec-test steps, judged red ──
const PASS = { exitCode: 0, timedOut: false, output: "ok" }
function redRepo() {
  freshHome()
  const dir = repo({ "package.json": "{}", "src/cart.js": "export const total = () => 0\n" })
  confirmCheck(dir, "npm test")
  return dir
}
const verifyRed = (dir, run) => verifyStep({ cwd: dir, sessionId: "s", step: "1 spec", run, expect: "red", guard: true })

test("WT-PLAN-05: a spec step passes only red for the right reason", async () => {
  // Fails because of the new test, passes without it: red, a pass
  let dir = redRepo()
  writeFileSync(join(dir, "src/cart.test.js"), "test('AC-1', () => expect(total([2])).toBe(2))\n")
  let r = await verifyRed(dir, async () => (existsSync(join(dir, "src/cart.test.js")) ? { exitCode: 1, timedOut: false, output: "AssertionError: expected 0 to be 2\n  at src/cart.test.js:1" } : PASS))
  assert.equal(r.status, "pass", JSON.stringify(r))
  assert.equal(readProgress(dir, "s").runs.at(-1).red, true)
  assert.ok(existsSync(join(dir, "src/cart.test.js")), "the new test is put back")
  // The new tests already pass: not red
  dir = redRepo()
  writeFileSync(join(dir, "src/cart.test.js"), "test('AC-1', () => {})\n")
  r = await verifyRed(dir, async () => PASS)
  assert.equal(r.status, "fail")
  assert.equal(r.failure, "not red")
  // It fails without the new tests too: red for another reason
  dir = redRepo()
  writeFileSync(join(dir, "src/cart.test.js"), "test('AC-1', () => {})\n")
  r = await verifyRed(dir, async () => ({ exitCode: 1, timedOut: false, output: "AssertionError: old\n  at src/old.test.js:3" }))
  assert.equal(r.failure, "red for another reason")
  // The new test doesn't parse
  dir = redRepo()
  writeFileSync(join(dir, "src/cart.test.js"), "test('AC-1', () => {\n")
  r = await verifyRed(dir, async () => ({ exitCode: 1, timedOut: false, output: "SyntaxError: Unexpected end of input\n  at src/cart.test.js:2" }))
  assert.equal(r.failure, "syntax")
  // No test file changed
  dir = redRepo()
  writeFileSync(join(dir, "src/cart.js"), "export const total = () => 1\n")
  r = await verifyRed(dir, async () => ({ exitCode: 1, timedOut: false, output: "AssertionError: x" }))
  assert.equal(r.failure, "not red")
})

test("WT-PLAN-01…04: spec steps come before the code; plans for tenant-scoped projects need a security step", async () => {
  const steps = [
    { title: "Contracts", done_when: "written", role: "database" },
    { title: "Spec tests", done_when: "AC-1 red", role: "qa", spec_tests: true },
    { title: "Orders API", done_when: "AC-1 green", role: "backend" },
  ]
  assert.equal(validatePlan({ goal: "g", steps }, { roles: ROLES, specTests: true }).steps[1].specTests, true)
  assert.throws(() => validatePlan({ goal: "g", steps: [steps[0], steps[2], steps[1]] }, { roles: ROLES, specTests: true }), /comes before the code they test/)
  // Without the option, spec_tests is never read
  assert.equal("specTests" in validatePlan({ goal: "g", steps }, { roles: ROLES }).steps[1], false)
  freshHome()
  const dir = project({ api: null, tenants: null, app: false })
  confirmCheck(dir, "npm test")
  const tool = planTool({ isBuilder: () => false, cwd: async () => dir, roles: ROLES, contracts: CONTRACT_NAMES, checked: () => true })
  const exec = { agent: { id: "head" } }
  await assert.rejects(tool.execute({ goal: "Orders", steps: [{ title: "Orders API", done_when: "works", role: "backend" }] }, exec), /needs a step with role "security"/)
  const ok = await tool.execute({ goal: "Orders", steps: [{ title: "Orders API", done_when: "works", role: "backend" }, { title: "Tenant isolation", done_when: "G-TENANT passes", role: "security" }] }, exec)
  assert.equal(ok.steps.length, 2)
  // Without roles and contracts (cartridges or gates off), the rule doesn't apply
  const plain = planTool({ isBuilder: () => false, cwd: async () => dir, checked: () => true })
  assert.equal((await plain.execute({ goal: "Orders", steps: [{ title: "Orders API", done_when: "works" }] }, { agent: { id: "plain" } })).steps.length, 1)
})
