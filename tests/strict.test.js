import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { parseError, readHook, syntaxHook, toolsToHide } from "../plugins/loop/index.js"
import { builderPrompt, runStep, savePlan, validatePlan } from "../src/loop.js"
import { affectedTests, importers, MAX_READ_LINES, outline, outlineText, ReconError, readPage } from "../src/recon.js"
import { ladder, PLAN_LIMITS, silencers, syntaxCommand, taskKind, weakenedTest } from "../src/strict.js"
import { confirmCheck, readProgress, trajectory, verdict, verifyStep } from "../src/verify.js"
import { freshHome } from "./helpers.js"

// The strict loop, recon and JIT tools, in parts: scripted checks and real
// git repositories. The real-DSH drills are in strict-run.test.js.

function repo(files) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-strict-")))
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
  confirmCheck(dir, "npm test")
  return dir
}
const PASS = { exitCode: 0, timedOut: false, output: "" }
// Answers the person's check with `check`; every other command (a rung) passes
const runner = (check = PASS, others = PASS) => {
  const seen = []
  return { seen, run: async (command) => (seen.push(command), command === "npm test" ? (typeof check === "function" ? check() : check) : typeof others === "function" ? others(command) : others) }
}
const verify = (dir, run, plan) => {
  if (plan) savePlan(dir, "s", plan, undefined, { strict: true })
  return verifyStep({ cwd: dir, sessionId: "s", step: plan ? `1 ${plan.steps[0].title}` : "all", run, guard: true, strict: {} })
}
const ONE = { goal: "Add a thing", kind: "feature_dag", steps: [{ title: "one", done_when: "x" }] }

test("ST-CT-01: the contract is checked, bounds the plan, and names the kind from the goal when it isn't given", () => {
  const plan = validatePlan({ ...ONE, invariants: ["db/*", ""], acceptance: ["npm run lint", "a", "b", "c"] }, { strict: true })
  assert.deepEqual([plan.kind, plan.invariants, plan.acceptance.length], ["feature_dag", ["db/*"], 3])
  assert.throws(() => validatePlan({ ...ONE, kind: "anything" }, { strict: true }), /kind is one of/)
  const three = ["a", "b", "c"].map((title) => ({ title, done_when: "x" }))
  assert.throws(() => validatePlan({ goal: "g", kind: "surgical_bugfix", steps: three }, { strict: true }), /at most 2 steps/)
  assert.equal(PLAN_LIMITS.surgical_bugfix, 2)
  assert.equal(validatePlan({ goal: "Fix the crash on login", steps: [{ title: "a", done_when: "x" }] }, { strict: true }).kind, "surgical_bugfix")
  assert.equal(validatePlan(ONE).kind, undefined, "off, a plan has no contract")
  assert.deepEqual(["Rename the module", "Investigate retries", "Add a page"].map(taskKind), ["refactoring_migration", "deep_research", "feature_dag"])
  assert.match(builderPrompt({ goal: "g", steps: [{ title: "a", doneWhen: "x", files: [] }], invariants: ["db/*"], acceptance: ["npm run lint"] }, 1), /must not change: db\/\*[\s\S]*must also exit 0: npm run lint/)
})

test("ST-TM-01: what weakens a test, and what doesn't", () => {
  const was = 'test("a", () => {\n  assert.equal(f(), 1)\n  assert.equal(g(), 2)\n})\n'
  assert.equal(weakenedTest(was, null), "deleted")
  assert.match(weakenedTest(was, 'test("a", () => {\n  assert.equal(f(), 1)\n})\n'), /fewer assertions \(2 to 1\)/)
  assert.match(weakenedTest(was, 'test("a", () => {\n  assert.equal(f(), 1)\n  // assert.equal(g(), 2)\n})\n'), /fewer assertions/)
  assert.equal(weakenedTest(was, was.replace('test("a"', 'test.skip("a"')), "tests skipped")
  assert.equal(weakenedTest(was, `${was}test("b", () => { assert.ok(h()) })\n`), undefined, "adding tests is fine")
  assert.equal(weakenedTest(was, was.replace("f(), 1", "f(), 3")), undefined, "a changed expectation is left to the originals re-run")
})

test("ST-TM-02: what silences the compiler, only when the change adds it", () => {
  assert.deepEqual(silencers("const a = 1\n", "const a: any = 1\n"), ["`any`"])
  assert.deepEqual(silencers(null, "// @ts-ignore\nfoo()\n"), ["a compiler suppression"])
  assert.deepEqual(silencers("f()\n", "try { f() } catch {}\n"), ["an empty catch"])
  assert.deepEqual(silencers("f()\n", "try:\n    f()\nexcept Exception:\n    pass\n"), ["an empty catch"])
  assert.deepEqual(silencers("let a: any\n", "let a: any\nlet b = 2\n"), [], "already there isn't added")
  assert.deepEqual(silencers("", "try { f() } catch (e) { log(e) }\nconst company = 1\n"), [])
})

test("ST-LD-01: the rungs are the cheapest that apply; quoted; a tsc rung only with the project's own tsc", () => {
  const dir = repo({ "a.js": "1\n", "b.ts": "1\n", "tsconfig.json": "{}" })
  assert.deepEqual(ladder(dir, ["a.js", "gone.js"]).map((r) => r.level), [1])
  assert.deepEqual(ladder(dir, ["b.ts"]), [], "no tsc installed: no rung")
  mkdirSync(join(dir, "node_modules/.bin"), { recursive: true })
  writeFileSync(join(dir, "node_modules/.bin/tsc"), "")
  assert.equal(ladder(dir, ["b.ts"])[0].level, 2)
  assert.match(syntaxCommand(["it's.js"]), /'it'\\''s\.js'/)
  assert.equal(syntaxCommand(["a.md"]), undefined)
})

test("ST-LD-02: a syntax error comes back without running the person's check, and the run says which rung", async () => {
  freshHome()
  const dir = repo({ "a.js": "1\n" })
  writeFileSync(join(dir, "a.js"), "1 = = 2\n")
  const { seen, run } = runner(PASS, { exitCode: 1, timedOut: false, output: "a.js:1\nSyntaxError: Unexpected token '='" })
  const result = await verify(dir, run)
  assert.equal(result.status, "fail")
  assert.equal(result.failure, "syntax")
  assert.match(result.command, /node --check/)
  assert.ok(!seen.includes("npm test"))
  const progress = readProgress(dir, "s")
  assert.equal(progress.runs[0].level, 1)
  assert.equal(trajectory(progress).earlyFailures, 1)
})

test("ST-LD-03: a type error in a file this work never touched doesn't stop it", async () => {
  freshHome()
  const dir = repo({ "a.ts": "1\n", "old.ts": "1\n", "tsconfig.json": "{}", "node_modules/.bin/tsc": "" })
  writeFileSync(join(dir, ".gitignore"), "node_modules\n")
  writeFileSync(join(dir, "a.ts"), "2\n")
  const older = runner(PASS, { exitCode: 2, timedOut: false, output: "old.ts(1,1): error TS2322: nope" })
  assert.equal((await verify(dir, older.run)).status, "pass")
  assert.ok(older.seen.includes("npm test"))
  const mine = runner(PASS, { exitCode: 2, timedOut: false, output: "a.ts(1,1): error TS2322: nope" })
  const failed = await verifyStep({ cwd: dir, sessionId: "t", step: "all", run: mine.run, guard: true, strict: {} })
  assert.equal(failed.failure, "type")
  assert.ok(!mine.seen.includes("npm test"))
})

test("ST-LD-04: affected tests run before the suite, found from imports", async () => {
  freshHome()
  const dir = repo({ "package.json": JSON.stringify({ scripts: { test: "node --test" } }), "src/a.js": "exports.a = 1\n", "tests/a.test.js": 'require("../src/a.js")\n', "tests/b.test.js": "1\n" })
  writeFileSync(join(dir, "src/a.js"), "exports.a = 2\n")
  assert.deepEqual(affectedTests(dir, ["src/a.js"]), ["tests/a.test.js"])
  const { seen, run } = runner(PASS, (command) => (command.startsWith("node --test") ? { exitCode: 1, timedOut: false, output: "AssertionError: no" } : PASS))
  const result = await verify(dir, run)
  assert.equal(result.status, "fail")
  assert.match(result.command, /node --test 'tests\/a\.test\.js'/)
  assert.ok(!seen.includes("npm test"))
})

test("ST-CK-01: invariants, weakened tests and silencers refuse a change the check would pass", async () => {
  freshHome()
  const dir = repo({ "db/schema.js": "1\n", "a.test.js": "assert.ok(1)\nassert.ok(2)\n", "a.ts": "const a = 1\n" })
  writeFileSync(join(dir, "db/schema.js"), "2\n")
  assert.equal((await verify(dir, runner().run, { ...ONE, invariants: ["db/*"] })).failure, "invariant broken")
  execFileSync("git", ["checkout", "-q", "."], { cwd: dir })
  writeFileSync(join(dir, "a.test.js"), "assert.ok(1)\n")
  const weak = await verifyStep({ cwd: dir, sessionId: "u", step: "all", run: runner().run, guard: true, strict: {} })
  assert.equal(weak.failure, "tests changed")
  assert.match(weak.output, /a\.test\.js was weakened/)
  execFileSync("git", ["checkout", "-q", "."], { cwd: dir })
  writeFileSync(join(dir, "a.ts"), "const a: any = 1\n")
  const quiet = await verifyStep({ cwd: dir, sessionId: "v", step: "all", run: runner().run, guard: true, strict: {} })
  assert.equal(quiet.failure, "silenced")
})

test("ST-CK-03: a changed expectation keeps its assertion count, but fails on the committed test", async () => {
  freshHome()
  const dir = repo({ "a.test.js": "assert.equal(f(), 1)\n", "src.md": "x\n" })
  writeFileSync(join(dir, "a.test.js"), "assert.equal(f(), 2)\n")
  const onTheOriginal = async (c) => (c === "npm test" && execFileSync("cat", ["a.test.js"], { cwd: dir, encoding: "utf8" }).includes("1)") ? { exitCode: 1, timedOut: false, output: "AssertionError: no" } : PASS)
  const result = await verifyStep({ cwd: dir, sessionId: "s", step: "all", run: onTheOriginal, guard: true, strict: {} })
  assert.equal(result.status, "fail")
  assert.equal(result.failure, "tests changed")
  assert.equal(execFileSync("cat", ["a.test.js"], { cwd: dir, encoding: "utf8" }), "assert.equal(f(), 2)\n", "the work's file is back")
})

test("ST-CK-02: acceptance commands can only fail a pass; Read only runs nothing extra", async () => {
  freshHome()
  const dir = repo({ "a.md": "1\n" })
  const { run } = runner(PASS, (c) => (c === "npm run lint" ? { exitCode: 1, timedOut: false, output: "lint: no" } : PASS))
  const failed = await verify(dir, run, { ...ONE, acceptance: ["npm run lint"] })
  assert.equal(failed.status, "fail")
  assert.equal(failed.failure, "acceptance")
  const read = runner()
  await verifyStep({ cwd: dir, sessionId: "r", step: "all", run: read.run, strict: { readOnly: true } })
  assert.deepEqual(read.seen, ["npm test"])
})

test("ST-RD-01: a bug fix must be red on the old code, then green; the old code comes back to the new", async () => {
  freshHome()
  const dir = repo({ "v.js": 'module.exports = "old"\n' })
  const fix = { goal: "Fix the value", kind: "surgical_bugfix", steps: [{ title: "one", done_when: "x" }] }
  writeFileSync(join(dir, "v.js"), 'module.exports = "new"\n')
  // The check passes on both versions: nothing proves the bug
  const none = await verify(dir, runner().run, fix)
  assert.equal(none.failure, "no reproduction")
  execFileSync("git", ["status"], { cwd: dir, stdio: "pipe" })
  assert.equal(execFileSync("cat", ["v.js"], { cwd: dir, encoding: "utf8" }), 'module.exports = "new"\n', "the work's file is back")
  // Red on the old code, green on the new
  const proved = await verifyStep({
    cwd: dir,
    sessionId: "p",
    step: "all",
    guard: true,
    strict: {},
    run: async (c) => (c === "npm test" ? (execFileSync("cat", ["v.js"], { cwd: dir, encoding: "utf8" }).includes("new") ? PASS : { exitCode: 1, timedOut: false, output: "red" }) : PASS),
  })
  assert.equal(proved.status, "pass")
})

test("ST-RB-01: two broken attempts go back to the step's start; a blocked step leaves it there", async () => {
  freshHome()
  const dir = repo({})
  savePlan(dir, "s", ONE, undefined, { strict: true })
  const restored = []
  let tree = 0
  const fail = { exitCode: 1, timedOut: false, output: "SyntaxError: Unexpected token" }
  const prompts = []
  const result = await runStep({
    cwd: dir,
    sessionId: "s",
    n: 1,
    spawn: async (prompt) => (prompts.push(prompt), { output: [] }),
    verify: (label) => verifyStep({ cwd: dir, sessionId: "s", step: label, tree: async () => undefined, run: async () => fail, guard: true }),
    guard: { snapshot: async () => `t${tree++}`, restore: async (to, why) => restored.push([to, why]) },
  })
  assert.equal(result.status, "blocked")
  assert.equal(result.rolledBack, true)
  // After attempt 2, and when attempt 4 blocks the step
  assert.deepEqual(restored.map(([to]) => to), ["t0", "t0"])
  assert.match(prompts[2], /all their changes were undone/)
  assert.equal(trajectory(readProgress(dir, "s")).rollbacks, 2)
  assert.equal(verdict(readProgress(dir, "s")).status, "blocked")
})

test("ST-RC-01: outlines list symbols with lines; paths stay in the folder", () => {
  const ts = "export function a() {}\nexport class B {\n  run() {\n  }\n}\nexport interface C {}\nexport type D = 1\nexport const e = 1\n  if (x) {\n"
  assert.deepEqual(outlineText(ts, ".ts").map((s) => `${s.line} ${s.kind} ${s.name}`), ["1 function a", "2 class B", "3 method run", "6 interface C", "7 type D", "8 const e"])
  assert.deepEqual(outlineText("class A:\n    def b(self):\n        pass\n", ".py").map((s) => s.name), ["A", "b"])
  assert.deepEqual(outlineText("func (s *S) Run() {}\ntype T struct{}\n", ".go").map((s) => s.name), ["Run", "T"])
  assert.deepEqual(outlineText("x", ".md"), [])
  const dir = repo({ "a.js": "function a() {}\n" })
  assert.equal(outline(dir, "a.js").symbols[0].name, "a")
  assert.throws(() => outline(dir, "../secret.js"), ReconError)
  assert.throws(() => outline(dir, "none.js"), ReconError)
})

test("ST-RC-02: impact finds importers by resolved path, in JS and Python", () => {
  const dir = repo({
    "src/a.js": "1\n",
    "src/b.js": 'import x from "./a.js"\n',
    "src/c.ts": 'const y = require("./a")\n',
    "lib/d.js": 'export { z } from "../src/a"\n',
    "src/other.js": 'import a from "./other-a.js"\n',
    "pkg/m.py": "1\n",
    "pkg/n.py": "from pkg.m import thing\n",
  })
  assert.deepEqual(importers(dir, "src/a.js").sort(), ["lib/d.js", "src/b.js", "src/c.ts"])
  assert.deepEqual(importers(dir, "pkg/m.py"), ["pkg/n.py"])
})

test("ST-RC-03: a long read comes back as one page saying what's left; a short one is left alone", async () => {
  const lines = Array.from({ length: MAX_READ_LINES + 50 }, (_, i) => ({ number: i + 11, text: `line ${i + 11}` }))
  const long = { path: "/p/big.js", offset: 11, lines, totalLines: 900 }
  const page = readPage(long)
  assert.match(page, /^<path>\/p\/big\.js<\/path>\n<type>file<\/type>\n<content>\n11: line 11\n/)
  assert.match(page, /\n410: line 410\n\n\(Showing lines 11-410 of 900\. Use offset=411 to continue/)
  assert.doesNotMatch(page, /411: line/)
  assert.equal(readPage({ ...long, lines: lines.slice(0, MAX_READ_LINES) }), undefined)
  assert.equal(readPage({}), undefined)
  const hook = readHook()
  const accept = async () => ({ kind: "accept" })
  const read = { name: "read", agent: {}, arguments: {} }
  assert.match((await hook(read, { value: long }, accept)).content[0].text, /Showing lines 11-410/)
  assert.equal((await hook(read, { isError: true }, accept)).content, undefined)
  assert.equal((await hook({ ...read, name: "bash" }, { value: long }, accept)).content, undefined)
})

test("ST-SX-01: a write that breaks parsing says so at once; other tools and clean files don't", async () => {
  const dir = repo({})
  writeFileSync(join(dir, "bad.js"), "1 = = 2\n")
  writeFileSync(join(dir, "good.js"), "1\n")
  assert.match(await parseError(join(dir, "bad.js")), /SyntaxError/)
  assert.equal(await parseError(join(dir, "good.js")), undefined)
  const hook = syntaxHook({ cwd: async () => dir })
  const accept = async () => ({ kind: "accept" })
  const said = await hook({ name: "edit", agent: {}, arguments: { file_path: "bad.js" } }, { content: [{ type: "text", text: "ok" }] }, accept)
  assert.match(said.content[1].text, /no longer parses/)
  assert.deepEqual(await hook({ name: "edit", agent: {}, arguments: { file_path: "good.js" } }, { content: [] }, accept), { kind: "accept" })
  assert.deepEqual(await hook({ name: "bash", agent: {}, arguments: {} }, { content: [] }, accept), { kind: "accept" })
})

test("ST-JT-01: a step keeps the heavy tools its words need, and loses the rest", () => {
  const names = ["read", "bash", "browser_open", "browser_read", "rea_tools", "rea_call"]
  const step = (title, files = []) => ({ title, doneWhen: "done", files })
  assert.deepEqual(toolsToHide(names, step("Fix the date parser")), ["browser_open", "browser_read", "rea_tools", "rea_call"])
  assert.deepEqual(toolsToHide(names, step("Fix the login page layout")), ["rea_tools", "rea_call"])
  assert.deepEqual(toolsToHide(names, step("Decompile the binary")), ["browser_open", "browser_read"])
})
