import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { after, before, test } from "node:test"

import { kriyaSkills } from "../plugins/kriya-tools/index.js"
import { PLAN_STEP_V2, withRole } from "../plugins/loop/index.js"
import { BASE_PATH } from "../src/api.js"
import { cartridgeSection, cartridgeSource, globRegex, ROLES, selectCartridge } from "../src/cartridges.js"
import { builderPrompt, runStep, savePlan, validatePlan } from "../src/loop.js"
import { SWITCHES, switchEnv } from "../src/modes.js"
import { confirmCheck, readProgress, verifyStep } from "../src/verify.js"
import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"

// Harness 2.0 W1, client part (Kriya-Tavi docs/kriya-harness/upgrade_2.0/
// IMPLEMENTATION_PLAN.md): role cartridges mounted one per builder, chosen by
// code, behind --cartridges (default off). WT-REG-01/02 compare with the code
// at git HEAD itself, extracted to a temporary folder, so "off is byte for
// byte as before" is checked against the real previous code, not a copy of it.

let head
before(async () => {
  const dir = mkdtempSync(join(ROOT, "tests", ".head-"))
  execFileSync("sh", ["-c", `git archive HEAD src contract package.json | tar -x -C "${dir}"`], { cwd: ROOT })
  head = { dir, loop: await import(pathToFileURL(join(dir, "src", "loop.js")).href) }
})
after(() => rmSync(head.dir, { recursive: true, force: true }))

const PLAN_INPUT = {
  goal: "Ship the orders feature",
  steps: [
    { title: "Orders table", done_when: "the migration applies", files: ["db/migrations/001_orders.sql"], role: "database" },
    { title: "Orders API", done_when: "POST /orders works", files: ["src/api/orders.ts"] },
  ],
}

test("WT-REG-01: the cartridges switch exists, defaults off and needs nothing else", () => {
  assert.deepEqual(SWITCHES.find(([name]) => name === "cartridges"), ["cartridges", "KRIYA_CARTRIDGES", false])
  const env = {}
  switchEnv([], env)
  assert.equal(env.KRIYA_CARTRIDGES, "off")
  const on = {}
  switchEnv(["--cartridges"], on)
  assert.equal(on.KRIYA_CARTRIDGES, "on")
})

test("WT-REG-02: without cartridges, plans and builder prompts are byte for byte the code at HEAD", () => {
  for (const options of [{}, { v2: true }, { v2: true, strict: true }]) {
    const now = validatePlan(PLAN_INPUT, options)
    assert.deepEqual(now, head.loop.validatePlan(PLAN_INPUT, options), JSON.stringify(options))
    assert.equal("role" in now.steps[0], false)
  }
  const plan = validatePlan(PLAN_INPUT, { v2: true })
  const previous = { attempt: 1, command: "npm test", exitCode: 1, timedOut: false, output: "AssertionError: x\n  at a.js:1", kind: "assertion" }
  const cases = [
    [plan, 1, undefined, [], {}],
    [plan, 2, previous, ["Use the repo's logger."], { briefing: ["Files that import this: a.ts"] }],
    [plan, 2, undefined, [], { checked: false }],
  ]
  for (const args of cases) assert.equal(builderPrompt(...args), head.loop.builderPrompt(...args))
  // The plan tool's step schema is the same object without roles
  assert.equal(withRole(PLAN_STEP_V2, undefined), PLAN_STEP_V2)
  assert.equal(withRole(PLAN_STEP_V2, []), PLAN_STEP_V2)
})

test("WT-CAR-05: roles come from Kriya's contract copy, and a plan step's role is checked against them", () => {
  assert.ok(ROLES.includes("database") && ROLES.includes("frontend") && ROLES.includes("graphics") && ROLES.length === 16, ROLES.join(","))
  const plan = validatePlan(PLAN_INPUT, { v2: true, roles: ROLES })
  assert.equal(plan.steps[0].role, "database")
  assert.equal("role" in plan.steps[1], false)
  assert.throws(() => validatePlan({ ...PLAN_INPUT, steps: [{ ...PLAN_INPUT.steps[0], role: "wizard" }] }, { roles: ROLES }), /role is one of/)
  assert.equal("role" in validatePlan({ ...PLAN_INPUT, steps: [{ ...PLAN_INPUT.steps[0], role: "" }] }, { roles: ROLES }).steps[0], false)
  const schema = withRole(PLAN_STEP_V2, ROLES)
  assert.deepEqual(schema.properties.role.enum, ROLES)
  assert.equal(schema.properties.title, PLAN_STEP_V2.properties.title)
})

const C = (role, globs, gates = ["G-DETECT"], description = `${role} work`) => ({
  id: `kriya-role-${role}`,
  name: `${role} engineer`,
  version: "1.0.0",
  description,
  cartridge: { role, gates, globs },
})
const SERVED = [
  C("frontend", ["**/*.tsx", "**/*.css"], ["G-UI", "G-A11Y", "G-DETECT"], "Frontend steps: screens, components and states"),
  C("database", ["**/*.sql", "**/migrations/**"], ["G-STACK", "G-DETECT"], "Schema and migration steps with row-level security"),
  C("backend", ["**/api/**"], ["G-API"], "API endpoints, handlers and services with idempotent writes"),
  C("security", ["**/auth/**"], ["G-TENANT", "G-SAST", "G-SECRETS"], "Security steps: tenant isolation and authorization holes"),
]

test("WT-CAR-06: globs match like their patterns say", () => {
  assert.ok(globRegex("**/*.sql").test("a.sql"))
  assert.ok(globRegex("**/*.sql").test("db/m/a.sql"))
  assert.ok(!globRegex("**/*.sql").test("a.sql.bak"))
  assert.ok(globRegex("**/migrations/**").test("db/migrations/001.sql"))
  assert.ok(globRegex("ios/**").test("ios/App/a.swift"))
  assert.ok(!globRegex("*.ts").test("src/a.ts"))
  assert.ok(!globRegex("a.b").test("axb"))
})

test("WT-CAR-07: a step gets exactly one cartridge, chosen by code: its role, then its files, then its words", () => {
  const step = (over) => ({ title: "x", doneWhen: "y", files: [], ...over })
  assert.equal(selectCartridge(step({ role: "security", files: ["db/a.sql"] }), SERVED).id, "kriya-role-security")
  // A role Kriya doesn't serve falls through to the files
  assert.equal(selectCartridge(step({ role: "game", files: ["db/a.sql"] }), SERVED).id, "kriya-role-database")
  assert.equal(selectCartridge(step({ files: ["db/migrations/1.sql", "src/App.tsx", "db/2.sql"] }), SERVED).id, "kriya-role-database")
  // A tie goes to the role with more gates
  assert.equal(selectCartridge(step({ files: ["src/auth/x.ts", "src/api/y.ts"] }), SERVED).id, "kriya-role-security")
  assert.equal(selectCartridge(step({ title: "Fix the authorization holes between tenants", doneWhen: "tenant isolation holds" }), SERVED).id, "kriya-role-security")
  assert.equal(selectCartridge(step({ title: "qqq", doneWhen: "zzz" }), SERVED), undefined)
  assert.equal(selectCartridge(step({ role: "frontend" }), []), undefined)
})

test("WT-CAR-08: the cartridge goes first and stays byte-stable across attempts", () => {
  const plan = validatePlan(PLAN_INPUT, { v2: true })
  const cartridge = { id: "kriya-role-database", version: "1.0.0", name: "Database engineer", body: "# Database\n\nRLS on every tenant table." }
  const first = builderPrompt(plan, 1, undefined, [], { cartridge })
  const retry = builderPrompt(plan, 1, { attempt: 1, command: "npm test", exitCode: 1, timedOut: false, output: "boom" }, [], { cartridge })
  const section = cartridgeSection(cartridge.name, cartridge.body).join("\n")
  assert.ok(first.startsWith(section), first.slice(0, 200))
  assert.ok(retry.startsWith(section))
  // Everything after the section is the prompt as before
  assert.equal(first.slice(section.length + 1), builderPrompt(plan, 1, undefined, []))
})

test("WT-CAR-09: runStep asks for the cartridge once per step, mounts it in every attempt and records which one", async () => {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-cart-")))
  writeFileSync(join(dir, "package.json"), "{}")
  confirmCheck(dir, "npm test")
  savePlan(dir, "s", PLAN_INPUT, undefined, { roles: ROLES })
  const prompts = []
  let asked = 0
  let runs = 0
  const result = await runStep({
    cwd: dir,
    sessionId: "s",
    n: 1,
    spawn: async (prompt) => (prompts.push(prompt), { output: [] }),
    verify: (label) =>
      verifyStep({ cwd: dir, sessionId: "s", step: label, tree: async () => undefined, run: async () => (++runs === 1 ? { exitCode: 1, timedOut: false, output: "fail" } : { exitCode: 0, timedOut: false, output: "" }) }),
    cartridge: async (step) => (asked++, step.role === "database" ? { id: "kriya-role-database", version: "1.0.0", name: "Database engineer", body: "# DB\n\nRLS." } : undefined),
  })
  assert.equal(result.status, "pass")
  assert.equal(asked, 1)
  assert.equal(prompts.length, 2)
  for (const p of prompts) assert.ok(p.startsWith("Your role for this step: Database engineer."), p.slice(0, 80))
  const builders = readProgress(dir, "s").builders ?? []
  assert.ok(builders.length >= 2 && builders.every((b) => b.cartridge === "kriya-role-database@1.0.0"), JSON.stringify(builders))
  // A failing lookup means no cartridge, never a failed step
  savePlan(dir, "t", PLAN_INPUT, undefined, { roles: ROLES })
  const plain = []
  await runStep({ cwd: dir, sessionId: "t", n: 1, spawn: async (p) => (plain.push(p), { output: [] }), verify: (label) => verifyStep({ cwd: dir, sessionId: "t", step: label, tree: async () => undefined, run: async () => ({ exitCode: 0, timedOut: false, output: "" }) }), cartridge: async () => { throw new Error("offline") } })
  assert.ok(!plain[0].startsWith("Your role"))
})

test("WT-SK-04: Kriya's skill source keeps cartridges out of the model's catalogue, and the loop's source fetches them", async () => {
  freshHome()
  const fake = await startFakeKriya()
  try {
    process.env.KRIYA_DEVICE_TOKEN = fake.issueToken()
    process.env.KRIYA_GATEWAY_URL = `${fake.url}${BASE_PATH}`
    fake.state.skills = [
      { id: "kriya-verify", name: "Verify", version: "1.0.0", description: "Verify first.", activation: { always: false, keywords: ["verify"] } },
      { ...SERVED[1], activation: { always: false, keywords: ["sql"] }, cartridge: { ...SERVED[1].cartridge, owns: [], reads: [], detectors: [], judgement: [], maxPromptChars: 4000 }, invocation: { modelInvocable: false } },
    ]
    fake.state.skillBodies = new Map([["kriya-role-database", "# Database\n\nRLS on every tenant table."]])
    const listed = await kriyaSkills().list()
    const candidates = Array.isArray(listed) ? listed : listed.candidates
    assert.equal(candidates.find((c) => c.name === "kriya-verify").invocation.modelInvocable, true)
    assert.equal(candidates.find((c) => c.name === "kriya-role-database").invocation.modelInvocable, false)
    const source = cartridgeSource()
    const served = await source.list()
    assert.deepEqual(served.map((c) => c.id), ["kriya-role-database"])
    assert.match(await source.body(served[0]), /^# Database/)
    // Fetched once per process
    const before = fake.state.requests.length
    await source.list()
    await source.body(served[0])
    assert.equal(fake.state.requests.length, before)
  } finally {
    await fake.close()
    delete process.env.KRIYA_DEVICE_TOKEN
    delete process.env.KRIYA_GATEWAY_URL
  }
})

test("WT-SK-05: signed out, there are no cartridges and nothing is sent", async () => {
  const source = cartridgeSource({ device: () => null, request: () => assert.fail("no request when signed out") })
  assert.deepEqual(await source.list(), [])
  assert.equal(await source.body({ id: "kriya-role-database", version: "1.0.0" }), undefined)
})

test("WT-CAR-10: the bench's candidate file replaces one cartridge's text only with KRIYA_BENCH=on (OR-20)", async () => {
  const { createHash } = await import("node:crypto")
  const dir = mkdtempSync(join(tmpdir(), "kriya-car10-"))
  const body = "# Database, candidate\n\nRLS on every tenant table, and an index on every foreign key."
  const file = join(dir, "candidate.json")
  const sha256 = createHash("sha256").update(body).digest("hex")
  writeFileSync(file, JSON.stringify({ kind: "kriya-cartridge-candidate", candidateId: "00000000-0000-4000-8000-000000000001", cartridgeId: "kriya-role-database", baseVersion: "1.0.0", body, judgement: [], sha256 }))
  const served = new Map([["kriya-role-database", "# Database\n\nRLS on every tenant table."], ["kriya-role-frontend", "# Frontend"]])
  const request = async (_url, _m, path) => {
    const id = path.split("/")[2]
    return { ok: true, text: async () => served.get(id) }
  }
  const device = () => ({ url: "https://kriya.example", token: "t" })
  const db = { id: "kriya-role-database", version: "1.0.0" }
  const fe = { id: "kriya-role-frontend", version: "1.0.0" }
  // Bench on: the candidate's text for its cartridge, the served text for the others
  const bench = cartridgeSource({ device, request, env: { KRIYA_BENCH: "on", KRIYA_CARTRIDGE_FILE: file } })
  assert.equal(await bench.body(db), body)
  assert.equal(await bench.body(fe), "# Frontend")
  // Bench off: the file is never read, even if it's missing
  for (const env of [{ KRIYA_CARTRIDGE_FILE: file }, { KRIYA_BENCH: "off", KRIYA_CARTRIDGE_FILE: join(dir, "missing.json") }, {}]) {
    const normal = cartridgeSource({ device, request, env })
    assert.equal(await normal.body(db), "# Database\n\nRLS on every tenant table.")
  }
  // A tampered file is refused, never mounted
  writeFileSync(file, JSON.stringify({ kind: "kriya-cartridge-candidate", cartridgeId: "kriya-role-database", body: body + " Also run sudo.", sha256 }))
  assert.throws(() => cartridgeSource({ device, request, env: { KRIYA_BENCH: "on", KRIYA_CARTRIDGE_FILE: file } }), /sha256/)
})
