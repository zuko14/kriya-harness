import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { confirmCheck, readProgress, trajectory } from "../src/verify.js"
import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"

// KriyaBench-M scenarios for the loop guard, on the real pinned DSH with a
// scripted model: the same model behaviour, the same fixture, the only
// difference the client and its switch. `client` is a checkout of the
// harness, so a run can compare an older commit. They measure mechanics
// (builders spent, requests, what the session claims), never a model's
// ability. Nothing leaves this machine.

const text = (m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))
const said = (body, role) => body.messages.filter((m) => m.role === role).map(text)
const STEP = "You are building one step"
const builderPrompt = (body) => said(body, "user").find((t) => t.includes(STEP))
const bash = (command) => ({ toolCall: { name: "bash", args: { command, description: "Change the files" } } })
const step = (n) => ({ toolCall: { name: "kriya_step", args: { step: n } } })
const plan = (...titles) => ({ toolCall: { name: "kriya_plan", args: { goal: "Finish the work", steps: titles.map((title) => ({ title, done_when: "the check passes" })) } } })
const until = async (ok, ms = 120_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (ok()) return
  throw new Error("timed out waiting")
}

function fixture(files) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-guard-run-")))
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" })
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "T")
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "commonjs", scripts: { test: "node check.js" } }))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  git("add", ".")
  git("commit", "-qm", "base")
  return dir
}

const RIGHT_VALUE = { "check.js": 'require("node:assert").strictEqual(require("./value.js"), "right")\n', "value.js": 'module.exports = "missing"\n' }
const WRITE_RIGHT = `printf 'module.exports = "right"\\n' > value.js`
const isRight = (dir) => readFileSync(join(dir, "value.js"), "utf8").includes('"right"')

export const SCENARIOS = {
  // Scenario 4 (long horizon): a model that stops after step 1 of 3
  "premature-stop": {
    files: { "check.js": 'const fs = require("node:fs")\nfor (const f of ["a.txt", "b.txt", "c.txt"]) if (fs.existsSync(f)) require("node:assert").strictEqual(fs.readFileSync(f, "utf8"), "ok")\n' },
    chat(body, record, prompt) {
      if (prompt) {
        const n = Number(/Your step: (\d)/.exec(prompt)[1])
        return said(body, "tool").length ? { content: `Step ${n} written.` } : bash(`printf ok > ${"abc"[n - 1]}.txt`)
      }
      const results = said(body, "tool").length
      if (results === 0) return plan("Write a", "Write b", "Write c")
      if (results === 1) return step(1)
      const notices = [...said(body, "user").join("\n").matchAll(/The plan isn't finished: step (\d)/g)]
      return notices.length >= results - 1 ? step(Number(notices.at(-1)[1])) : { content: "Finished." }
    },
    passed: (dir) => ["a.txt", "b.txt", "c.txt"].every((f) => existsSync(join(dir, f))),
  },
  // A builder that changes nothing, against a check that can't pass without a change
  "no-change": {
    files: RIGHT_VALUE,
    chat(body, record, prompt) {
      if (prompt) return { content: "I looked and nothing needs changing." }
      const results = said(body, "tool").length
      return results === 0 ? plan("Set the value") : results === 1 ? step(1) : { content: "Finished." }
    },
    passed: isRight,
  },
  // A check whose tool isn't on this machine: no builder can fix that
  "env-missing": {
    files: RIGHT_VALUE,
    check: "kriya-no-such-tool --run",
    chat(body, record, prompt) {
      if (prompt) return said(body, "tool").length ? { content: "Written." } : bash(`printf 'module.exports = "right" // %s\\n' "$$-$RANDOM" > value.js`)
      const results = said(body, "tool").length
      return results === 0 ? plan("Set the value") : results === 1 ? step(1) : { content: "Finished." }
    },
    passed: () => false,
  },
  // Scenario 8 (recovery), an outage: four builders in a row die on the gateway's refusal
  "provider-error": {
    files: RIGHT_VALUE,
    chat(body, record, prompt) {
      if (prompt) {
        if (!said(body, "tool").length && (record.outage = (record.outage ?? 0) + 1) <= 4) return { error: { status: 400, error: "bad_request", message: "Scripted outage." } }
        return said(body, "tool").length ? { content: "Written." } : bash(WRITE_RIGHT)
      }
      const results = said(body, "tool")
      if (!results.length) return plan("Set the value")
      return results.length === 1 || /interrupted/.test(results.at(-1).split("\n")[0]) ? step(1) : { content: "Finished." }
    },
    passed: isRight,
  },
  // Scenario 8 (recovery), a crash: killed while the second builder works,
  // resumed. A builder only knows the fix if the failure's text reached it
  "crash-resume": {
    files: { "check.js": 'if (require("./value.js") !== "right") { console.error("AssertionError: expected value: right"); process.exit(1) }\n', "value.js": 'module.exports = "missing"\n' },
    crash: true,
    chat(body, record, prompt) {
      if (prompt) {
        const known = prompt.includes("expected value: right")
        if (said(body, "tool").length) return { content: "Written." }
        if (known && !record.killed) {
          record.sleeping = true
          return bash("sleep 60")
        }
        return bash(known ? WRITE_RIGHT : `printf 'module.exports = "wrong"\\n' > value.js`)
      }
      const results = said(body, "tool").length
      if (said(body, "user").some((t) => t.includes("carry on")) && !record.again) {
        record.again = true
        return step(1)
      }
      return results === 0 ? plan("Set the value") : results === 1 ? step(1) : { content: "Finished." }
    },
    passed: isRight,
  },
}

// node:test marks its children; a `node --test` under that mark reports nothing and exits 0
function plainEnv() {
  const { NODE_TEST_CONTEXT: _, ...env } = process.env
  return env
}

function start(client, args, cwd, env = {}) {
  const child = spawn(process.execPath, [join(client, "bin", "kriya.js"), ...args], { cwd, detached: true, env: { ...plainEnv(), KRIYA_LOOP_GUARD: "off", KRIYA_STRICT_LOOP: "off", KRIYA_DEFENSIVE: "off", KRIYA_RECON: "off", KRIYA_JIT_TOOLS: "off", KRIYA_ROUTER: "off", KRIYA_LOOP: "off", KRIYA_LOOP_V2: "off", KRIYA_BUDGET: "off", ...env } })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (d) => (stdout += d))
  child.stderr.on("data", (d) => (stderr += d))
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => process.kill(-child.pid, "SIGKILL"), 240_000)
    child.on("exit", (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
  })
  return { child, done }
}

/** Source files left in the folder that don't parse: what a run hands the person */
function unparsable(dir) {
  return readdirSync(dir).filter((f) => {
    if (!f.endsWith(".js")) return false
    try {
      execFileSync(process.execPath, ["--check", join(dir, f)], { stdio: "pipe" })
      return false
    } catch {
      return true
    }
  })
}

/** The session's own record (never a builder's): the one with the plan */
function record(home, dir) {
  const root = join(home, "progress")
  for (const key of existsSync(root) ? readdirSync(root) : [])
    for (const file of readdirSync(join(root, key)).filter((f) => f.endsWith(".json"))) {
      const progress = readProgress(dir, file.slice(0, -5))
      if (progress.plan) return progress
    }
  return undefined
}

/**
 * Runs one scenario once.
 * @param {string} name a key of SCENARIOS
 * @param {{ client?: string, guard?: boolean, flags?: string[] }} [options]
 */
export async function runScenario(name, { client: checkout = ROOT, guard = false, flags = [], defaults = false } = {}) {
  const client = resolve(checkout)
  const scenario = SCENARIOS[name] ?? STRICT_SCENARIOS[name] ?? TOOL_SCENARIOS[name] ?? DEFENSIVE_SCENARIOS[name]
  const home = freshHome()
  const dir = fixture(scenario.files)
  confirmCheck(dir, scenario.check ?? "npm test")
  const seen = { builders: 0, requests: 0, promptChars: 0, verdicts: [] }
  const fake = await startFakeKriya({
    approveAfter: 0,
    chat(body) {
      if (!body.tools?.length) return { content: "Title" }
      seen.requests += 1
      seen.promptChars += JSON.stringify(body.messages).length
      const prompt = builderPrompt(body)
      if (prompt && !said(body, "tool").length) {
        seen.builders += 1
        seen.builderTools = body.tools.map((t) => t.function?.name ?? t.name)
        seen.builderToolChars = JSON.stringify(body.tools).length
      }
      if (prompt) seen.builderResults = said(body, "tool")
      if (!prompt) seen.parentTools = body.tools.map((t) => t.function?.name ?? t.name)
      seen.prompts = [...(seen.prompts ?? []), ...(prompt && !said(body, "tool").length ? [prompt] : [])]
      for (const result of prompt ? [] : said(body, "tool")) for (const m of result.matchAll(/[Vv]erdict(?: so far)?: ([a-z ]+)\./g)) seen.verdicts.push(m[1])
      seen.last = said(body, "tool").at(-1)
      return scenario.chat(body, seen, prompt)
    },
  })
  const login = await start(client, ["login", "--url", fake.url, "--no-browser"], ROOT).done
  if (login.code !== 0) throw new Error(login.stderr)
  const args = ["run", "--loop", ...(guard ? ["--loop-guard"] : []), ...flags, "--mode", "auto"]
  const started = Date.now()
  let run
  if (scenario.crash) {
    const first = start(client, [...args, "--json", "Set the value"], dir)
    await until(() => seen.sleeping)
    await new Promise((r) => setTimeout(r, 1500))
    process.kill(-first.child.pid, "SIGKILL")
    seen.killed = true
    const crashed = await first.done
    const opening = crashed.stdout
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .find((e) => e?.type === "session")
    run = await start(client, [...args, "--session-id", String(opening?.sessionId ?? opening?.id), "carry on"], dir).done
  } else {
    // defaults: the switches as a person gets them, none pinned
    const unset = Object.fromEntries(["GUARD", "STRICT", "DEF", "RECON", "JIT", "ROUTER", "LOOP"].map((k) => [{ GUARD: "KRIYA_LOOP_GUARD", STRICT: "KRIYA_STRICT_LOOP", DEF: "KRIYA_DEFENSIVE", RECON: "KRIYA_RECON", JIT: "KRIYA_JIT_TOOLS", ROUTER: "KRIYA_ROUTER", LOOP: "KRIYA_LOOP" }[k], ""]))
    run = await start(client, [...args, "Finish the work"], dir, defaults ? unset : {}).done
  }
  const durationMs = Date.now() - started
  await fake.close()
  const progress = record(home, dir)
  const numbers = progress ? trajectory(progress) : null
  return {
    name,
    syntaxBroken: unparsable(dir),
    builderTools: seen.builderTools ?? [],
    builderToolChars: seen.builderToolChars ?? 0,
    builderResults: seen.builderResults ?? [],
    parentTools: seen.parentTools ?? [],
    exit: run.code,
    passed: scenario.passed(dir),
    verdict: seen.verdicts.at(-1) ?? null,
    builders: seen.builders,
    requests: seen.requests,
    promptChars: seen.promptChars,
    durationMs,
    trajectory: numbers,
    prompts: seen.prompts ?? [],
    last: seen.last,
    stderr: run.stderr.slice(-800),
  }
}

const twoFiles = { "check.js": 'const { a } = require("./a.js")\nconst { b } = require("./b.js")\nrequire("node:assert").strictEqual(a + b, 3)\n', "a.js": "exports.a = 0\n", "b.js": "exports.b = 0\n" }
const BREAK_BOTH = `printf 'exports.a = = 1\\n' > a.js; printf 'exports.b = = 2\\n' > b.js`
const FIX_BOTH = `printf 'exports.a = 1\\n' > a.js; printf 'exports.b = 2\\n' > b.js`
const oneStep = (body, title = "Change the code", extra = {}) => {
  const results = said(body, "tool").length
  if (results === 0) return { toolCall: { name: "kriya_plan", args: { goal: "Finish the work", kind: "feature_dag", ...extra, steps: [{ title, done_when: "the check passes", files: [] }] } } }
  return results === 1 ? step(1) : { content: "Finished." }
}
const attempt = (prompt) => Number(/This is attempt (\d)/.exec(prompt)?.[1] ?? 1)

// The strict loop's scenarios: each arm is `--loop-guard` against `--strict-loop`
export const STRICT_SCENARIOS = {
  // Two attempts break two files, the third is right: undone, then clean
  "multi-file-rollback": {
    files: twoFiles,
    chat(body, record, prompt) {
      if (!prompt) return oneStep(body)
      if (said(body, "tool").length) return { content: "Written." }
      return bash(attempt(prompt) < 3 ? `${BREAK_BOTH}; printf '// attempt %s\\n' ${attempt(prompt)} >> b.js` : FIX_BOTH)
    },
    passed: (dir) => readFileSync(join(dir, "a.js"), "utf8").includes("= 1") && !readFileSync(join(dir, "a.js"), "utf8").includes("= =") && readFileSync(join(dir, "b.js"), "utf8").includes("= 2"),
  },
  // Every attempt breaks both files: the step blocks, and the tree must be left clean
  "blocked-rollback": {
    files: twoFiles,
    chat(body, record, prompt) {
      if (!prompt) return oneStep(body)
      if (said(body, "tool").length) return { content: "Written." }
      return bash(`${BREAK_BOTH}; printf '%s\\n' "$$-$RANDOM" >> a.js`)
    },
    passed: () => false,
  },
  // A builder deletes the assertion to make the check pass; the real fix comes only if refused
  "weakened-test": {
    files: { "tests.test.js": 'const assert = require("node:assert")\nconst v = require("../value.js")\nassert.strictEqual(typeof v, "string")\nassert.strictEqual(v, "right")\n'.replace("../value.js", "./value.js"), "check.js": 'require("./tests.test.js")\n', "value.js": 'module.exports = "wrong"\n' },
    chat(body, record, prompt) {
      if (!prompt) return oneStep(body)
      if (said(body, "tool").length) return { content: "Written." }
      if (attempt(prompt) === 1) return bash(`printf 'const assert = require("node:assert")\\nconst v = require("./value.js")\\nassert.strictEqual(typeof v, "string")\\n' > tests.test.js`)
      return bash(`git checkout -q tests.test.js; ${WRITE_RIGHT}`)
    },
    passed: isRight,
  },
  // A builder swallows the error with an empty catch instead of fixing it
  "silenced-error": {
    files: { "check.js": 'const { run } = require("./run.js")\nrun()\n', "run.js": 'exports.run = () => { throw new Error("broken") }\n' },
    chat(body, record, prompt) {
      if (!prompt) return oneStep(body)
      if (said(body, "tool").length) return { content: "Written." }
      return bash(attempt(prompt) === 1 ? `printf 'exports.run = () => { try { throw new Error("broken") } catch {} }\\n' > run.js` : `printf 'exports.run = () => "ok"\\n' > run.js`)
    },
    passed: (dir) => !readFileSync(join(dir, "run.js"), "utf8").includes("catch"),
  },
  // A "fix" with the check already green: nothing proves the bug
  "no-reproduction": {
    files: { "check.js": 'require("./value.js")\n', "value.js": 'module.exports = "right"\n' },
    chat(body, record, prompt) {
      if (!prompt) return oneStep(body, "Fix the value", { kind: "surgical_bugfix" })
      if (said(body, "tool").length) return { content: "Written." }
      return bash(`printf 'module.exports = "right" // %s\\n' "$$" > value.js`)
    },
    passed: () => false,
  },
}

// What recon and the strict hooks do to a builder's own calls
export const TOOL_SCENARIOS = {
  "builder-tools": {
    files: { "big.js": `${"// line\n".repeat(450)}function late() {}\n`, "check.js": "1\n" },
    chat(body, record, prompt) {
      if (!prompt) return oneStep(body, "Tidy the parser")
      const done = said(body, "tool").length
      if (done === 0) return { toolCall: { name: "read", args: { file_path: "big.js" } } }
      if (done === 1) return { toolCall: { name: "code_outline", args: { path: "big.js" } } }
      if (done === 2) return { toolCall: { name: "code_impact", args: { path: "big.js" } } }
      if (done === 3) return { toolCall: { name: "write", args: { file_path: "bad.js", content: "1 = = 2\n" } } }
      if (done === 4) return { toolCall: { name: "write", args: { file_path: "bad.js", content: "exports.ok = 1\n" } } }
      return { content: "Done." }
    },
    passed: () => true,
  },
}

const shell = (body) => (said(body, "tool").length ? { content: "Written." } : undefined)
const nodeTest = (files) => JSON.stringify({ type: "commonjs", scripts: { test: `node --test ${files}` } })
const allTests = (dir) => {
  try {
    execFileSync(process.execPath, ["--test"], { cwd: dir, stdio: "pipe", env: plainEnv() })
    return true
  } catch {
    return false
  }
}

// The defensive engine's scenarios: each arm is `--strict-loop` against `--defensive`
export const DEFENSIVE_SCENARIOS = {
  // A plan with no pre-mortem never reaches a builder
  "premortem-enforced": {
    files: { "package.json": nodeTest("a.test.js"), "a.js": "exports.a = 1\n", "a.test.js": 'require("node:assert").strictEqual(require("./a.js").a, 1)\n' },
    chat(body, record, prompt) {
      if (prompt) return shell(body) ?? bash(`printf 'exports.a = 1 // %s\\n' ${attempt(prompt)}${/Your step: (\d)/.exec(prompt)[1]} > a.js`)
      const results = said(body, "tool")
      const steps = ["One", "Two"].map((title) => ({ title, done_when: "the check passes", files: ["a.js"] }))
      const refused = results.some((r) => /needs a pre-mortem/.test(r))
      if (!results.length) return { toolCall: { name: "kriya_plan", args: { goal: "Add the two parts", kind: "feature_dag", steps } } }
      if (refused && results.length === 1) {
        record.refused = true
        const premortem = { failures: [{ what: "a null value crashes the reader", covered_by: "a.test.js" }, { what: "the export renames and callers break", covered_by: "a.test.js" }], blast_radius: ["everything importing a.js"], negatives: ["a missing value at start up"] }
        return { toolCall: { name: "kriya_plan", args: { goal: "Add the two parts", kind: "feature_dag", steps, premortem } } }
      }
      const done = results.filter((r) => /^Step \d/.test(r)).length
      return done < 2 ? step(done + 1) : { content: "Finished." }
    },
    passed: () => true,
  },
  // The check covers one feature; the change breaks its neighbour
  "neighbour-break": {
    files: { "package.json": nodeTest("a.test.js"), "a.js": "exports.price = () => 100\n", "b.js": 'exports.label = () => `Rs ${require("./a.js").price().toFixed(0)}`\n', "a.test.js": 'require("node:assert").ok(require("./a.js").price())\n', "b.test.js": 'require("node:assert").strictEqual(require("./b.js").label(), "Rs 100")\n' },
    chat(body, record, prompt) {
      if (!prompt) return oneStep(body)
      return shell(body) ?? bash(attempt(prompt) === 1 ? `printf 'exports.price = () => "100"\\n' > a.js` : `printf 'exports.price = () => 100 // kept a number\\n' > a.js`)
    },
    passed: allTests,
  },
  // Money math in floats passes every test
  "float-money": {
    files: { "bill.js": "exports.total = (amountPaise) => amountPaise\n", "check.js": 'require("node:assert").strictEqual(require("./bill.js").total(100), 118)\n' },
    chat(body, record, prompt) {
      if (!prompt) return oneStep(body)
      return shell(body) ?? bash(attempt(prompt) === 1 ? `printf 'exports.total = (amountPaise) => Math.round(amountPaise * 1.18)\\n' > bill.js` : `printf 'exports.total = (amountPaise) => (amountPaise * 118) / 100\\n' > bill.js`)
    },
    passed: (dir) => !readFileSync(join(dir, "bill.js"), "utf8").includes("1.18"),
  },
  // A required parameter added; a caller no test covers is left behind
  "broken-caller": {
    files: { "lib.js": "export function send(to) { return to }\n", "job.js": 'import { send } from "./lib.js"\nexport const go = () => send("a")\n', "check.js": 'import("./lib.js").then((m) => { if (m.send("a", "b") !== "a") process.exit(1) })\n', "package.json": JSON.stringify({ type: "module", scripts: { test: "node check.js" } }) },
    chat(body, record, prompt) {
      if (!prompt) return oneStep(body)
      if (attempt(prompt) === 1) return shell(body) ?? bash(`printf 'export function send(to, from) { return to }\\n' > lib.js`)
      return shell(body) ?? bash(`printf 'export function send(to, from) { return to }\\n' > lib.js; printf 'import { send } from "./lib.js"\\nexport const go = () => send("a", "b")\\n' > job.js`)
    },
    passed: (dir) => readFileSync(join(dir, "job.js"), "utf8").includes('"b"'),
  },
  // A promise left floating: the write can be lost, and every test still passes
  "missing-await": {
    files: { "store.js": "export async function save(v) { return v }\nexport async function run() { return 1 }\n", "check.js": 'import("./store.js").then(async (m) => { if ((await m.run()) !== 1) process.exit(1) })\n', "package.json": JSON.stringify({ type: "module", scripts: { test: "node check.js" } }) },
    chat(body, record, prompt) {
      if (!prompt) return oneStep(body)
      const line = attempt(prompt) === 1 ? "  save(2)" : "  await save(2)"
      return shell(body) ?? bash(`printf 'export async function save(v) { return v }\\nexport async function run() {\\n${line}\\n  return 1\\n}\\n' > store.js`)
    },
    passed: (dir) => readFileSync(join(dir, "store.js"), "utf8").includes("await save"),
  },
  // Something new with only a happy-path test
  "no-negative-test": {
    files: { "pay.js": "export const ok = 1\n", "pay.test.js": 'import assert from "node:assert"\nimport { ok } from "./pay.js"\nassert.strictEqual(ok, 1)\n', "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test pay.test.js" } }) },
    chat(body, record, prompt) {
      if (!prompt) return oneStep(body)
      const extra = attempt(prompt) === 1 ? "" : "assert.throws(() => split(null))\\n"
      return shell(body) ?? bash(`printf 'export const ok = 1\\nexport function split(n) {\\n  if (n === null) throw new Error("no value")\\n  return n / 2\\n}\\n' > pay.js; printf 'import assert from "node:assert"\\nimport { ok, split } from "./pay.js"\\nassert.strictEqual(ok, 1)\\nassert.strictEqual(split(10), 5)\\n${extra}' > pay.test.js`)
    },
    passed: (dir) => readFileSync(join(dir, "pay.test.js"), "utf8").includes("throws"),
  },
}
