import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { useStack } from "../src/stack.js"
import { confirmCheck } from "../src/verify.js"
import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"

// Harness 2.0 W5 end to end on the real, pinned DSH, scripted model: a
// security step's app lets tenant A read tenant B's order (its ownership check
// is off in the project's policy.json). The project's check passes; G-TENANT
// fails the step with the leak; the next builder turns the check on; the step
// passes. The app is a local server reading the project's policy.json,
// confirmed with kriya stack use. Nothing leaves this machine.

function kriya(args, cwd) {
  return new Promise((done) => {
    const off = { KRIYA_LOOP_GUARD: "off", KRIYA_STRICT_LOOP: "off", KRIYA_DEFENSIVE: "off", KRIYA_RECON: "off", KRIYA_JIT_TOOLS: "off", KRIYA_ROUTER: "off", KRIYA_LOOP: "off", KRIYA_LOOP_V2: "off", KRIYA_BUDGET: "off", KRIYA_ANCHOR: "off", KRIYA_BROWSER: "off", KRIYA_CARTRIDGES: "off", KRIYA_ORCHESTRA: "off", KRIYA_GATES: "off" }
    const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), ...args], { cwd, env: { ...process.env, ...off } })
    let stderr = ""
    child.stderr.on("data", (d) => (stderr += d))
    const timer = setTimeout(() => child.kill("SIGKILL"), 150_000)
    child.on("exit", (code) => {
      clearTimeout(timer)
      done({ code, stderr })
    })
  })
}

const SECURITY = {
  id: "kriya-role-security",
  name: "Security engineer",
  version: "1.0.0",
  description: "Role cartridge for security steps.",
  activation: { always: false, keywords: ["security"] },
  cartridge: { role: "security", owns: ["threat_model"], reads: [], gates: ["G-TENANT"], detectors: [], judgement: [], maxPromptChars: 4000, globs: [] },
  invocation: { modelInvocable: false },
}
const textOf = (content) => (typeof content === "string" ? content : (content ?? []).map((p) => p?.text ?? "").join("\n"))

test("WT-GATE-TEN-RUN-01: a cross-tenant read fails G-TENANT; the next builder closes it (real DSH)", { timeout: 300_000 }, async () => {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-ten-run-")))
  mkdirSync(join(dir, ".kriya", "contracts"), { recursive: true })
  mkdirSync(join(dir, ".kriya", "gates"), { recursive: true })
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node -e 0" } }))
  writeFileSync(join(dir, ".kriya", "contracts", "auth_matrix.json"), JSON.stringify(["create", "read"].map((action) => ({ resource: "orders", action, roles: ["member"], tenantScoped: true }))))
  writeFileSync(
    join(dir, ".kriya", "gates", "tenants.json"),
    JSON.stringify({ signIn: { path: "/sign-in" }, tenants: { A: { body: { user: "a" } }, B: { body: { user: "b" } } }, token: { from: "json", field: "token" }, whoami: { path: "/me" }, resources: { orders: { create: { path: "/orders", body: { item: "x" } }, read: { path: "/orders/{id}" } } } })
  )
  const git = (...a) => execFileSync("git", a, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "P", GIT_AUTHOR_EMAIL: "p@x", GIT_COMMITTER_NAME: "P", GIT_COMMITTER_EMAIL: "p@x" } })
  git("init", "-q", "-b", "main")
  git("add", "-A")
  git("commit", "-q", "-m", "base")
  confirmCheck(dir, "npm test")
  // The app: its ownership check is whatever the project's policy.json says
  const orders = new Map()
  const app = createServer(async (req, res) => {
    let raw = ""
    for await (const c of req) raw += c
    const send = (s, b) => res.writeHead(s, { "content-type": "application/json" }).end(JSON.stringify(b))
    if (req.url === "/sign-in") return send(200, { token: JSON.parse(raw).user })
    const me = (req.headers.authorization ?? "").replace("Bearer ", "")
    if (req.url === "/me") return send(200, { id: me })
    if (req.url === "/orders" && req.method === "POST") {
      const o = { id: orders.size + 1, owner: me }
      orders.set(o.id, o)
      return send(201, o)
    }
    const o = orders.get(Number(/^\/orders\/(\d+)$/.exec(req.url)?.[1]))
    const checkOwner = existsSync(join(dir, "policy.json")) && JSON.parse(readFileSync(join(dir, "policy.json"), "utf8")).checkOwner === true
    if (!o || (checkOwner && o.owner !== me)) return send(404, { error: "not found" })
    send(200, o)
  })
  await new Promise((done) => app.listen(0, "127.0.0.1", done))
  useStack(dir, { app: `http://127.0.0.1:${app.address().port}` })
  const builders = []
  const fake = await startFakeKriya({
    approveAfter: 0,
    chat: (body) => {
      if (!body.tools?.length) return { content: "Title" }
      const first = textOf(body.messages.find((m) => m.role === "user")?.content)
      const done = body.messages.filter((m) => m.role === "tool").length
      if (/Do only this step, then stop\./.test(first)) {
        if (!done) builders.push(first)
        if (done) return { content: "Built." }
        return { toolCall: { name: "bash", args: { command: `echo '{"checkOwner": ${builders.length > 1}}' > policy.json`, description: "Write the policy" } } }
      }
      if (done === 0) return { toolCall: { name: "kriya_plan", args: { goal: "Tenant isolation", steps: [{ title: "Isolate tenants", done_when: "G-TENANT passes", role: "security" }] } } }
      if (done === 1) return { toolCall: { name: "kriya_step", args: { step: 1 } } }
      return { content: "Done." }
    },
  })
  fake.state.skills = [SECURITY]
  fake.state.skillBodies = new Map([["kriya-role-security", "# Security\n\nIdentity only from the verified session."]])
  try {
    assert.equal((await kriya(["login", "--url", fake.url, "--no-browser"], ROOT)).code, 0)
    const run = await kriya(["run", "--loop", "--cartridges", "--gates", "Isolate tenants"], dir)
    const report = `exit ${run.code}\nbuilders ${builders.length}\nstderr ${run.stderr.slice(-1200)}\nsecond ${String(builders[1]).slice(-900)}`
    assert.equal(run.code, 0, report)
    assert.equal(builders.length, 2, report)
    assert.match(builders[1], /G-TENANT/, report)
    assert.match(builders[1], /tenant A read B's #\d+ \(expected 403\/404, got 200\)/, report)
    assert.doesNotMatch(builders[1], /Bearer/)
    assert.equal(JSON.parse(readFileSync(join(dir, "policy.json"), "utf8")).checkOwner, true)
  } finally {
    await fake.close()
    app.close()
  }
})
