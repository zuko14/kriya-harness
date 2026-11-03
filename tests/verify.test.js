import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { GUIDANCE, verifyTool } from "../plugins/loop/index.js"
import {
  clearCheck,
  confirmCheck,
  confirmedCheck,
  discoverChecks,
  MAX_ATTEMPTS,
  OUTPUT_LIMIT,
  progressFiles,
  readProgress,
  trimOutput,
  verdict,
  verifyStep,
  VerifyError,
} from "../src/verify.js"
import { freshHome, ROOT } from "./helpers.js"

// H14a, the Kriya loop's verify step (src/verify.js, plugins/loop): checks
// are suggested from the project, confirmed only by the person, run by the
// harness under the session's sandbox; pass, fail and blocked come from the
// exit code alone; progress lives in ~/.kriya, never in the project.

function project(files = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-verify-")))
  mkdirSync(join(dir, ".git"))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}

const npmProject = () => project({ "package.json": JSON.stringify({ scripts: { test: "node --test", lint: "eslint .", check: "npm run lint && npm test" } }) })

/** A fake shell: each run answers with the next scripted result */
function shell(...results) {
  const ran = []
  return {
    ran,
    run: async (command) => {
      ran.push(command)
      return results.length > 1 ? results.shift() : results[0]
    },
  }
}
const ok = { exitCode: 0, timedOut: false, output: "all good" }
const failing = (output = "1 failing: parser empty input") => ({ exitCode: 1, timedOut: false, output })

test("discovery suggests the checks a project defines, best first, with its package manager", () => {
  assert.deepEqual(
    discoverChecks(npmProject()).map((c) => c.command),
    ["npm run check", "npm test", "npm run lint"]
  )
  const pnpm = project({ "package.json": JSON.stringify({ scripts: { test: "vitest" } }), "pnpm-lock.yaml": "" })
  assert.deepEqual(discoverChecks(pnpm).map((c) => c.command), ["pnpm run test"])
  const yarn = project({ "package.json": JSON.stringify({ scripts: { test: "jest" } }), "yarn.lock": "" })
  assert.deepEqual(discoverChecks(yarn).map((c) => c.command), ["yarn test"])
  // npm init's placeholder isn't a check
  assert.deepEqual(discoverChecks(project({ "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) })), [])
  const polyglot = project({ Makefile: "check:\n\tmake test\ntest:\n\t./run\n", "Cargo.toml": "", "go.mod": "", "pyproject.toml": "[tool.pytest.ini_options]\n" })
  assert.deepEqual(
    discoverChecks(polyglot).map((c) => c.command),
    ["make check", "make test", "cargo test", "go test ./...", "python -m pytest"]
  )
  // From a subfolder, the project root's checks
  mkdirSync(join(polyglot, "src", "deep"), { recursive: true })
  assert.equal(discoverChecks(join(polyglot, "src", "deep"))[0].command, "make check")
})

test("only the person confirms a check: one line, kept by project root, cleared on request", () => {
  freshHome()
  const dir = npmProject()
  assert.equal(confirmedCheck(dir), undefined)
  assert.throws(() => confirmCheck(dir, ""), VerifyError)
  assert.throws(() => confirmCheck(dir, "npm test\nrm -rf ~"), VerifyError)
  assert.throws(() => confirmCheck(dir, "x".repeat(501)), VerifyError)
  confirmCheck(dir, "  npm test  ")
  mkdirSync(join(dir, "lib"))
  assert.equal(confirmedCheck(join(dir, "lib")).command, "npm test")
  assert.equal(clearCheck(dir), true)
  assert.equal(confirmedCheck(dir), undefined)
  assert.equal(clearCheck(dir), false)
})

test("with no confirmed check nothing runs and the work is 'not configured', with suggestions", async () => {
  freshHome()
  const dir = npmProject()
  const fake = shell(ok)
  const result = await verifyStep({ cwd: dir, sessionId: "s1", step: "1 tests", run: fake.run })
  assert.equal(result.status, "not configured")
  assert.deepEqual(fake.ran, [])
  assert.equal(result.suggestions[0].command, "npm run check")
  assert.equal(verdict(readProgress(dir, "s1")).status, "not checked")
})

test("pass and fail come from the exit code alone; the model's words can't change them", async () => {
  freshHome()
  const dir = npmProject()
  confirmCheck(dir, "npm test")
  const fake = shell(failing(), ok)
  const first = await verifyStep({ cwd: dir, sessionId: "s1", step: "1 parser", run: fake.run })
  assert.equal(first.status, "fail")
  assert.equal(first.exitCode, 1)
  assert.equal(first.attemptsLeft, MAX_ATTEMPTS - 1)
  assert.match(first.output, /1 failing/)
  const second = await verifyStep({ cwd: dir, sessionId: "s1", step: "1 parser", run: fake.run })
  assert.equal(second.status, "pass")
  assert.equal(second.output, "")
  assert.equal(second.verdict, "verified")
  // Only the confirmed command ever ran
  assert.deepEqual(fake.ran, ["npm test", "npm test"])
  // A timeout is a failure even with exit 0
  const timed = await verifyStep({ cwd: dir, sessionId: "s2", run: shell({ exitCode: 0, timedOut: true, output: "" }).run })
  assert.equal(timed.status, "fail")
})

test(`a step that fails ${MAX_ATTEMPTS} times is blocked, with its output, and isn't run again`, async () => {
  freshHome()
  const dir = npmProject()
  confirmCheck(dir, "npm test")
  const fake = shell(failing("TypeError: cannot read 'x'"))
  let last
  for (let i = 0; i < MAX_ATTEMPTS; i++) last = await verifyStep({ cwd: dir, sessionId: "s1", step: "2 cli", run: fake.run })
  assert.equal(last.status, "blocked")
  assert.match(last.output, /TypeError/)
  assert.equal(last.verdict, "blocked")
  const again = await verifyStep({ cwd: dir, sessionId: "s1", step: "2 cli", run: fake.run })
  assert.equal(again.status, "blocked")
  assert.equal(fake.ran.length, MAX_ATTEMPTS)
  // Another session starts fresh
  assert.equal((await verifyStep({ cwd: dir, sessionId: "s2", step: "2 cli", run: shell(ok).run })).status, "pass")
})

test("the session verdict: verified only when every step's last run passed", () => {
  const runs = (...list) => ({ runs: list.map(([step, status]) => ({ step, status })) })
  assert.equal(verdict(runs()).status, "not checked")
  assert.equal(verdict(runs(["1", "pass"], ["2", "pass"])).status, "verified")
  assert.equal(verdict(runs(["1", "pass"], ["2", "fail"])).status, "failed")
  // A regression after a pass fails again
  assert.equal(verdict(runs(["1", "pass"], ["1", "fail"])).status, "failed")
  assert.equal(verdict(runs(["1", "fail"], ["1", "fail"], ["1", "fail"], ["1", "fail"], ["2", "pass"])).status, "blocked")
})

test("progress is kept in ~/.kriya, readable, and never written inside the project", async () => {
  const home = freshHome()
  const dir = npmProject()
  confirmCheck(dir, "npm test")
  await verifyStep({ cwd: dir, sessionId: "sess-9", step: "1 parser", run: shell(failing()).run })
  await verifyStep({ cwd: dir, sessionId: "sess-9", step: "1 parser", run: shell(ok).run })
  const files = progressFiles(dir, "sess-9")
  assert.ok(files.md.startsWith(home))
  const md = readFileSync(files.md, "utf8")
  assert.match(md, /Verdict: verified/)
  assert.match(md, /1 parser: pass \(2 runs\)/)
  assert.match(md, /exit 1/)
  assert.deepEqual(readdirSync(dir).sort(), [".git", "package.json"])
  assert.throws(() => progressFiles(dir, "../escape"), VerifyError)
})

test("long output keeps its end, where test runners report", () => {
  const long = `${"x".repeat(10_000)}FAIL at the end`
  const trimmed = trimOutput(long)
  assert.ok(trimmed.length < OUTPUT_LIMIT + 80)
  assert.match(trimmed, /FAIL at the end$/)
  assert.match(trimmed, /earlier characters left out/)
})

test("kriya_verify takes no command: only an optional step label", async () => {
  freshHome()
  const dir = npmProject()
  confirmCheck(dir, "npm test")
  const ran = []
  const tool = verifyTool({
    cwd: async () => dir,
    run: async (command, _exec, cwd) => {
      ran.push({ command, cwd })
      return ok
    },
  })
  const schema = JSON.stringify(tool)
  assert.doesNotMatch(schema, /"command"/)
  const value = await tool.execute({ step: "1 parser", command: "rm -rf /" }, { agent: { id: "s1" }, signal: new AbortController().signal })
  assert.equal(value.status, "pass")
  assert.deepEqual(ran, [{ command: "npm test", cwd: dir }])
  await assert.rejects(tool.execute({}, { signal: new AbortController().signal }), VerifyError)
  assert.match(GUIDANCE, /never say tests pass/)
})

test("off by default: the kriya-loop row runs only when kriya was started with --loop", () => {
  for (const profile of ["kriya", "kriya-run", "kriya-acp"]) {
    const dump = readFileSync(join(ROOT, "expected", `${profile}.dump.yml`), "utf8")
    assert.match(dump, /- id: kriya-loop\n {2}name: '@kriya-ai\/harness-loop'\n {2}disabled: !!js process\.env\.KRIYA_LOOP !== 'on'\n/, profile)
  }
})

test("kriya verify lists, confirms by number or text, and clears", () => {
  const home = freshHome()
  const dir = npmProject()
  const kriya = (...args) =>
    spawnSync(process.execPath, [join(ROOT, "bin", "kriya.js"), "verify", ...args], { cwd: dir, env: { ...process.env, KRIYA_HOME: home }, encoding: "utf8" })
  assert.match(kriya().stdout, /1\. npm run check/)
  assert.match(kriya("use", "2").stdout, /Confirmed for .*: npm test/)
  assert.match(kriya().stdout, /Check for .*: npm test/)
  assert.equal(kriya("use", "9").status, 1)
  assert.match(kriya("use", "npm", "run", "lint").stdout, /npm run lint/)
  assert.match(kriya("clear").stdout, /Forgot this project's check/)
  assert.ok(!existsSync(join(dir, ".kriya")))
})

test("KRIYA_VERIFY_CHECK from the person's shell sets this run's check; a multi-line one is ignored", () => {
  freshHome()
  const dir = npmProject()
  confirmCheck(dir, "npm test")
  try {
    process.env.KRIYA_VERIFY_CHECK = "node --test"
    assert.equal(confirmedCheck(dir).command, "node --test")
    assert.equal(confirmedCheck(dir).source, "KRIYA_VERIFY_CHECK")
    process.env.KRIYA_VERIFY_CHECK = "node --test\nrm -rf ~"
    assert.equal(confirmedCheck(dir).command, "npm test")
  } finally {
    delete process.env.KRIYA_VERIFY_CHECK
  }
})
