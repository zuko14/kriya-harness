import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { builderPrompt, savePlan, validatePlan } from "../src/loop.js"
import { blastRadius, changedSymbols, importers, importGraph } from "../src/recon.js"
import { addedLines, checkPremortem, exportedFunctions, hasBoundaryTest, newSurface, reviewDiff, sentinel } from "../src/sentinel.js"
import { confirmCheck, readProgress, verifyStep } from "../src/verify.js"
import { runScenario } from "./guard-scenarios.js"
import { freshHome } from "./helpers.js"

// The defensive engine: pre-mortem enforcement, blast-radius discovery,
// invariant catches, the diff review and negative tests. Rules against real
// files and repositories; the scenarios at the end run on the real pinned DSH.

function repo(files) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-def-")))
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" })
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "T")
  for (const [rel, text] of Object.entries({ "package.json": "{}", ...files })) {
    mkdirSync(join(dir, rel, ".."), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  git("add", ".")
  git("commit", "-qm", "base")
  return dir
}
const diff = (rel, before, after) => ({ rel, before, after })
const rules = (d, facts) => sentinel([d], facts).map((f) => f.rule)
const STEPS = ["a", "b"].map((title) => ({ title, done_when: "x" }))
const GOOD = {
  failures: [
    { what: "a null total crashes the invoice page", covered_by: "tests/a.test.js" },
    { what: "an empty cart divides by zero", covered_by: "tests/b.test.js" },
  ],
  blast_radius: ["the invoices table and the billing route"],
  negatives: ["a null total and an empty cart"],
}

test("DF-PM-01: a multi-step plan with no real pre-mortem is refused before anything is built", () => {
  const plan = (premortem) => validatePlan({ goal: "Add it", kind: "feature_dag", steps: STEPS, premortem }, { strict: true, defensive: true })
  assert.throws(() => plan(undefined), /needs a pre-mortem/)
  assert.throws(() => plan({ ...GOOD, failures: GOOD.failures.slice(0, 1) }), /at least 2/)
  assert.throws(() => plan({ ...GOOD, failures: [GOOD.failures[0], GOOD.failures[0]] }), /at least 2/, "the same one twice isn't two")
  assert.throws(() => plan({ ...GOOD, failures: [{ what: "none" }, { what: "n/a" }] }), /at least 2/, "blanks don't count")
  assert.throws(() => plan({ ...GOOD, failures: GOOD.failures.map((f) => ({ what: f.what })) }), /needs covered_by/)
  assert.throws(() => plan({ ...GOOD, blast_radius: [] }), /blast_radius/)
  assert.throws(() => plan({ ...GOOD, negatives: ["none"] }), /negatives/)
  assert.equal(plan(GOOD).premortem.failures[1].coveredBy, "tests/b.test.js")
})

test("DF-PM-02: one step needs none; off, nothing is asked; builders are told what to defend", () => {
  assert.deepEqual(checkPremortem(undefined, 1), {})
  assert.equal(validatePlan({ goal: "g", steps: STEPS }).premortem, undefined)
  const plan = validatePlan({ goal: "Add it", kind: "feature_dag", steps: STEPS, premortem: GOOD }, { strict: true, defensive: true })
  const prompt = builderPrompt(plan, 1)
  assert.match(prompt, /Could fail: a null total crashes the invoice page \(proved by tests\/a\.test\.js\)/)
  assert.match(prompt, /Bad inputs to handle: a null total/)
})

test("DF-BR-01: the graph resolves relative paths, tsconfig aliases and Python modules", () => {
  const dir = repo({
    "tsconfig.json": '{\n  // a comment\n  "compilerOptions": { "paths": { "@/*": ["./*"] } }\n}\n',
    "lib/money.ts": "export const add = 1\n",
    "lib/bill.ts": 'import { add } from "@/lib/money"\n',
    "app/page.tsx": 'import { x } from "../lib/bill"\n',
    "tests/money.test.ts": 'vi.mock("@/lib/money")\n',
    "pkg/m.py": "1\n",
    "pkg/n.py": "from pkg.m import thing\n",
  })
  const graph = importGraph(dir)
  assert.deepEqual(importers(dir, "lib/money.ts", graph).sort(), ["lib/bill.ts", "tests/money.test.ts"])
  assert.deepEqual(importers(dir, "pkg/m.py", graph), ["pkg/n.py"])
})

test("DF-BR-02: the radius reaches neighbours through imports, and finds their tests nearest first", () => {
  const dir = repo({
    "a.js": 'exports.a = 1\n',
    "b.js": 'require("./a.js")\n',
    "c.js": 'require("./b.js")\n',
    "d.js": 'require("./c.js")\n',
    "e.js": 'require("./d.js")\n',
    "tests/a.test.js": 'require("../a.js")\n',
    "tests/c.test.js": 'require("../c.js")\n',
    "tests/e.test.js": 'require("../e.js")\n',
    "tests/other.test.js": "1\n",
  })
  const r = blastRadius(importGraph(dir), [diff("a.js", "exports.a = 1\n", "exports.a = 2\n")])
  assert.deepEqual(r.direct, ["b.js"])
  assert.deepEqual(r.transitive, ["c.js", "d.js"])
  assert.deepEqual(r.tests, ["tests/a.test.js", "tests/c.test.js"], "depth 3, and not the unrelated suite")
})

test("DF-BR-03: a changed table reaches whoever names it; a changed route reaches its callers; a changed symbol finds its tests", () => {
  const dir = repo({
    "db/schema.ts": "export const invoices = pgTable('invoices', {})\nexport const users = pgTable('users', {})\n",
    "queries/report.ts": "// reads invoices through a helper\nconst rows = invoices\n",
    "queries/other.ts": "const rows = customers\n",
    "tests/report.test.ts": "expect(invoices).toBeDefined()\n",
    "app/api/billing/route.ts": "export function GET() {}\n",
    "components/pay.tsx": 'fetch("/api/billing")\n',
    "tests/calculate.test.ts": "calculateTotal()\n",
    "lib/calc.ts": "export function calculateTotal() { return 1 }\n",
  })
  const graph = importGraph(dir)
  const schema = blastRadius(graph, [diff("db/schema.ts", "export const invoices = pgTable('invoices', {})\n", "export const invoices = pgTable('invoices', { a: 1 })\n")])
  assert.ok(schema.transitive.includes("queries/report.ts"))
  assert.ok(!schema.transitive.includes("queries/other.ts"))
  assert.deepEqual(schema.tests, ["tests/report.test.ts"])
  const route = blastRadius(graph, [diff("app/api/billing/route.ts", "export function GET() {}\n", "export function GET() { return 1 }\n")])
  assert.deepEqual(route.callers, ["components/pay.tsx"])
  const symbol = blastRadius(graph, [diff("lib/calc.ts", "export function calculateTotal() { return 1 }\n", "export function calculateTotal(a) { return a }\n")])
  assert.deepEqual(symbol.tests, ["tests/calculate.test.ts"])
  assert.deepEqual(changedSymbols("function a() {}\nfunction b() {}\n", "function a() {}\nfunction c() {}\n", ".js").sort(), ["b", "c"])
})

test("DF-SN-01: the sentinel reads added lines only", () => {
  assert.deepEqual(addedLines("a\nb\n", "a\nb\nc\n"), [{ line: 3, text: "c" }])
  assert.deepEqual(addedLines("a\n", "a\na\n"), [{ line: 2, text: "a" }])
  assert.deepEqual(addedLines(null, "x\n"), [{ line: 1, text: "x" }])
  const old = "const t = amount * 1.18\n"
  assert.deepEqual(rules(diff("lib/bill.ts", old, `${old}const y = 1\n`)), [], "an old problem isn't this change's")
})

test("DF-SN-02: each invariant catches its violation and leaves its neighbour alone", () => {
  const tenancy = { tenancy: true }
  assert.deepEqual(rules(diff("actions/x.ts", "", "await db.select().from(t)\n"), tenancy), ["tenant isolation"])
  assert.deepEqual(rules(diff("queries/x.ts", "", "await privileged((tx) => tx)\n"), tenancy), ["tenant isolation"])
  assert.deepEqual(rules(diff("worker/janitor.ts", "", "await privileged((tx) => tx)\n"), tenancy), [], "bookkeeping may")
  assert.deepEqual(rules(diff("actions/x.ts", "", "await withUser(id, (tx) => tx.select())\n"), tenancy), [])
  assert.deepEqual(rules(diff("actions/x.ts", "", "await db.select().from(t)\n"), {}), [], "a project with no withUser")
  assert.deepEqual(rules(diff("lib/q.js", "", "conn.query(`select * from t where id = ${id}`)\n")), ["sql injection"])
  assert.deepEqual(rules(diff("lib/q.js", "", 'conn.query("select 1 where id = " + id)\n')), ["sql injection"])
  assert.deepEqual(rules(diff("lib/q.js", "", 'conn.query("select 1 where id = $1", [id])\n')), [])
  assert.deepEqual(rules(diff("lib/bill.ts", "", "const tax = amount * 0.18\n")), ["financial precision"])
  assert.deepEqual(rules(diff("lib/bill.ts", "", "const fee = parseFloat(price)\n")), ["financial precision"])
  assert.deepEqual(rules(diff("lib/bill.ts", "", "const tax = (amountPaise * 18n) / 100n\n")), [])
  assert.deepEqual(rules(diff("components/price.tsx", "", "const shown = amount.toFixed(2)\n")), [], "display isn't math")
  assert.deepEqual(rules(diff("lib/chart.ts", "", "const width = size * 0.5\n")), [], "not money")
  assert.deepEqual(rules(diff("app/api/x/route.ts", "", "const { userId } = await request.json()\n")), ["session identity"])
  assert.deepEqual(rules(diff("actions/x.ts", "", "const role = formData.get('role')\n")), ["session identity"])
  assert.deepEqual(rules(diff("app/api/x/route.ts", "", "const { userId } = await requireUser()\n")), [])
  assert.deepEqual(rules(diff("lib/x.ts", "", `const key = "${"sk-"}abcdefghijklmnopqrstuvwx"\n`)), ["secret in code"])
  assert.deepEqual(rules(diff("tests/x.test.ts", "", "const tax = amount * 0.18\n")), [], "tests aren't checked")
  assert.deepEqual(rules(diff("lib/bill.ts", "", "// const tax = amount * 0.18\n")), [], "nor comments")
})

test("DF-RV-01: exported functions and their parameters are read", () => {
  const f = exportedFunctions("export async function a(x: string, y = 2, ...z) {}\nexport const b = (p?: number) => p\ndef c(self, q):\n  pass\n")
  assert.deepEqual([...f.keys()], ["a", "b", "c"])
  assert.equal(f.get("a").async, true)
  assert.deepEqual(f.get("a").params.map((p) => [p.name, p.required, p.default]), [["x", true, undefined], ["y", false, "2"], ["z", false, undefined]])
  assert.equal(f.get("b").params[0].required, false)
  assert.deepEqual(f.get("c").params.map((p) => p.name), ["q"])
})

test("DF-RV-02: what a change does to callers it didn't touch", () => {
  const dir = repo({ "lib.js": "export function send(to, n = 1) {}\nexport function old() {}\nexport function sync() {}\n", "job.js": 'import { send, old, sync } from "./lib.js"\nsend("a"); old(); sync()\n' })
  const graph = importGraph(dir)
  const after = (text) => reviewDiff(graph, [diff("lib.js", "export function send(to, n = 1) {}\nexport function old() {}\nexport function sync() {}\n", text)]).map((h) => h.hazard)
  assert.deepEqual(after("export function send(to, from, n = 1) {}\nexport function old() {}\nexport function sync() {}\n"), ["broken signature"])
  assert.deepEqual(after("export function send(to, n = 2) {}\nexport function old() {}\nexport function sync() {}\n"), ["altered default"])
  assert.deepEqual(after("export function send(to, n = 1) {}\nexport function sync() {}\n"), ["removed export"])
  assert.deepEqual(after("export function send(to, n = 1) {}\nexport function old() {}\nexport async function sync() {}\n"), ["now async"])
  assert.deepEqual(after("export function send(to, n = 1, opt = 2) {}\nexport function old() {}\nexport function sync() {}\n"), [], "an optional parameter breaks no one")
  const returned = repo({ "lib.js": "export function go() {}\n", "job.js": 'import { go } from "./lib.js"\nexport const run = () => { return go() }\n' })
  assert.deepEqual(reviewDiff(importGraph(returned), [diff("lib.js", "export function go() {}\n", "export async function go() {}\n")]), [], "returning the promise hands it on")
  // Handled: the caller changed in the same work
  const handled = reviewDiff(graph, [diff("lib.js", "export function send(to, n = 1) {}\n", "export function send(to, from, n = 1) {}\n"), diff("job.js", "", 'send("a", "b")\n')])
  assert.deepEqual(handled, [])
})

test("DF-RV-03: promises nobody waits for, and races", () => {
  const dir = repo({ "dep.js": "export async function fetchIt() {}\n", "a.js": 'import { fetchIt } from "./dep.js"\n' })
  const graph = importGraph(dir)
  const before = 'import { fetchIt } from "./dep.js"\nasync function save() {}\n'
  const hazards = (lines) => reviewDiff(graph, [diff("a.js", before, `${before}${lines}\n`)]).map((h) => h.hazard)
  assert.deepEqual(hazards("save()"), ["missing await"])
  assert.deepEqual(hazards("  const r = fetchIt()"), ["missing await"])
  assert.deepEqual(hazards("await save()"), [])
  assert.deepEqual(hazards("return fetchIt()"), [])
  assert.deepEqual(hazards("fetchIt().then(done)"), [])
  assert.deepEqual(hazards("void save()"), [])
  assert.deepEqual(hazards("items.forEach(async (i) => go(i))"), ["race"])
  assert.deepEqual(hazards("const r = items.map(async (i) => go(i))"), ["race"])
  assert.deepEqual(hazards("await Promise.all(items.map(async (i) => go(i)))"), [])
  // Replayed on real commits, these were deliberate: not hazards
  assert.deepEqual(hazards("const r = save()\nawait r"), [])
  assert.deepEqual(hazards("const go = () =>\n  save()"), [], "an arrow's body is its return")
  assert.deepEqual(reviewDiff(graph, [diff("a.js", "async function f() {\n  await run(1)\n}\n", "async function f() {\n  const p = run(2)\n  await p\n}\n")]).map((h) => h.hazard), [])
  assert.deepEqual(reviewDiff(graph, [diff("dist/a.js", "", "async function f() {}\nf()\n")]), [], "generated code")
  assert.deepEqual(hazards("go().catch(() => {})"), [])
  assert.deepEqual(hazards("  save(),"), [], "an element of Promise.all")
  assert.deepEqual(reviewDiff(graph, [diff("a.js", "const r = await Promise.all([\n  1,\n])\n", "const r = await Promise.all([\n  1,\n  items.map(async (i) => go(i)),\n])\n")]).map((h) => h.hazard), [])
  assert.deepEqual(reviewDiff(graph, [diff("a.js", "async function f() {\n  await db.save(x)\n}\n", "async function f() {\n  db.save(x)\n}\n")]).map((h) => h.hazard), ["missing await"])
})

test("DF-NG-01: something new needs a test with a bad input", () => {
  const added = diff("lib/pay.js", "export function a() {}\n", "export function a() {}\nexport function split(n) {}\n")
  assert.deepEqual(newSurface([added]), ["lib/pay.js"])
  assert.deepEqual(newSurface([diff("lib/pay.js", "export function a() {}\n", "export function a() { return 1 }\n")]), [], "a change inside isn't new surface")
  assert.deepEqual(newSurface([diff("app/api/x/route.ts", null, "const x = 1\n")]), ["app/api/x/route.ts"])
  const test = (line) => hasBoundaryTest([diff("tests/pay.test.js", "", `${line}\n`)])
  assert.equal(test("assert.equal(split(10), 5)"), false)
  for (const bad of ["assert.throws(() => split(null))", "expect(res.status).toBe(401)", "await expect(run()).rejects.toThrow()", 'split("")', "it('refuses an invalid amount', f)", "with pytest.raises(ValueError):"]) assert.equal(test(bad), true, bad)
  assert.equal(hasBoundaryTest([diff("lib/pay.js", "", "throw new TypeError('invalid')\n")]), false, "only test files count")
})

test("DF-FL-01: the sentinel runs before the tests; findings name file, line and rule", async () => {
  freshHome()
  const dir = repo({ "lib/bill.js": "exports.total = 1\n" })
  confirmCheck(dir, "npm test")
  writeFileSync(join(dir, "lib/bill.js"), "exports.total = 1\nconst tax = amount * 0.18\n")
  const seen = []
  const result = await verifyStep({ cwd: dir, sessionId: "s", step: "all", guard: true, strict: { defensive: true }, run: async (c) => (seen.push(c), { exitCode: 0, timedOut: false, output: "" }) })
  assert.equal(result.failure, "invariant violated")
  assert.match(result.output, /lib\/bill\.js:2 \[financial precision\]/)
  assert.deepEqual(seen, [])
})

test("DF-FL-02: a pre-mortem claim with no test can't verify; off, nothing changes", async () => {
  freshHome()
  const dir = repo({ "a.md": "1\n" })
  confirmCheck(dir, "npm test")
  writeFileSync(join(dir, "a.md"), "2\n")
  savePlan(dir, "s", { goal: "Add it", kind: "feature_dag", steps: [{ title: "one", done_when: "x" }], premortem: GOOD }, undefined, { strict: true, defensive: true })
  const pass = async () => ({ exitCode: 0, timedOut: false, output: "" })
  const result = await verifyStep({ cwd: dir, sessionId: "s", step: "1 one", guard: true, strict: { defensive: true }, run: pass })
  assert.equal(result.failure, "premortem open")
  assert.match(result.output, /tests\/a\.test\.js/)
  const plain = await verifyStep({ cwd: dir, sessionId: "t", step: "all", guard: true, strict: {}, run: pass })
  assert.equal(plain.status, "pass")
  assert.equal(readProgress(dir, "t").runs[0].status, "pass")
})

const pair = async (name) => {
  const strict = await runScenario(name, { flags: ["--strict-loop"] })
  const defensive = await runScenario(name, { flags: ["--defensive"] })
  return { strict, defensive, report: JSON.stringify({ strict: { ...strict, prompts: 0, parentTools: 0, builderTools: 0 }, defensive: { ...defensive, prompts: 0, parentTools: 0, builderTools: 0 } }).slice(0, 2400) }
}

for (const [id, name] of [["DF-RUN-01", "neighbour-break"], ["DF-RUN-02", "float-money"], ["DF-RUN-03", "broken-caller"], ["DF-RUN-04", "missing-await"], ["DF-RUN-05", "no-negative-test"]])
  test(`${id}: ${name}: --strict-loop reads verified over the defect; --defensive refuses it and the next attempt is clean`, { timeout: 200_000 }, async () => {
    const { strict, defensive, report } = await pair(name)
    assert.equal(strict.verdict, "verified", report)
    assert.equal(strict.passed, false, report)
    assert.equal(defensive.verdict, "verified", report)
    assert.equal(defensive.passed, true, report)
    assert.equal(defensive.builders, 2, report)
  })

test("DF-RUN-06: a plan with no pre-mortem reaches no builder; with one, it runs", { timeout: 200_000 }, async () => {
  const { strict, defensive, report } = await pair("premortem-enforced")
  assert.equal(strict.verdict, "verified", report)
  assert.equal(defensive.verdict, "verified", report)
  assert.match(defensive.prompts[0], /Could fail: a null value crashes the reader/, report)
  assert.doesNotMatch(strict.prompts[0], /Could fail/, report)
})

test("DF-RUN-07: with no flags at all, a person gets the engine: float money refused, then clean", { timeout: 200_000 }, async () => {
  const r = await runScenario("float-money", { defaults: true })
  assert.equal(r.passed, true, r.stderr)
  assert.equal(r.verdict, "verified", r.stderr)
  assert.equal(r.builders, 2, r.stderr)
})
