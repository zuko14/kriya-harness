import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { flowEnv, runArgs } from "../src/daemon.js"
import { planStatus, savePlan, seededPlan, writeSnapshot } from "../src/loop.js"
import { confirmCheck } from "../src/verify.js"
import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"

// Flows from Kriya (SD-14 in the Kriya repository), FL-*: the person's plan
// is saved as written, only known harness switches pass, and the Graph tab
// draws what the loop recorded.

const dir = () => realpathSync(mkdtempSync(join(tmpdir(), "kriya-flow-test-")))
function repo() {
  const at = dir()
  const git = (...a) => execFileSync("git", a, { cwd: at, stdio: "pipe" })
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "t")
  writeFileSync(join(at, "a.js"), "1\n")
  git("add", ".")
  git("commit", "-qm", "base")
  return at
}

const plan = { goal: "Ship", steps: [{ title: "Change it", done_when: "It works", files: [] }, { title: "Test it", done_when: "It passes", files: [], after: [1] }] }

test("FL-01: a flow's plan goes to a file and its progress comes back from one", () => {
  const at = dir()
  const env = flowEnv({ plan }, at)
  assert.deepEqual(JSON.parse(readFileSync(env.KRIYA_SEED_PLAN, "utf8")), plan)
  assert.equal(env.KRIYA_PROGRESS_FILE, join(at, "progress.json"))
  assert.deepEqual(seededPlan(env), plan)
  assert.equal(seededPlan({}), undefined)
  assert.equal(seededPlan({ KRIYA_SEED_PLAN: join(at, "missing") }), undefined)
})

test("FL-02: only known harness switches pass; a protected name is dropped", () => {
  const env = flowEnv(
    {
      profile: {
        id: "abc",
        env: {
          KRIYA_LOOP_V2: "on",
          KRIYA_MAX_STEPS: "150",
          KRIYA_MODE: "full",
          KRIYA_DISPATCH_ID: "x",
          PATH: "/evil",
          KRIYA_BUDGET: "off; rm -rf /",
        },
      },
    },
    dir()
  )
  assert.deepEqual(env, { KRIYA_LOOP_V2: "on", KRIYA_MAX_STEPS: "150" })
})

test("FL-03: the plan and profile never reach the command line", () => {
  const args = runArgs({ mode: "ask", prompt: "Do it", switches: {}, plan, profile: { env: { KRIYA_LOOP: "on" } } })
  assert.deepEqual(args, ["run", "--mode", "ask", "Do it"])
})

test("FL-04: a snapshot carries each step's status and the one being built", () => {
  freshHome()
  const at = repo()
  savePlan(at, "s1", plan)
  const file = join(dir(), "progress.json")
  writeSnapshot(at, "s1", { current: 1, env: { KRIYA_PROGRESS_FILE: file } })
  const seen = JSON.parse(readFileSync(file, "utf8"))
  assert.deepEqual(seen.plan.map((s) => [s.n, s.status, Boolean(s.building)]), [[1, "not started", true], [2, "not started", false]])
  assert.equal(planStatus(at, "s1").length, 2)
  // Without the variable nothing is written
  writeSnapshot(at, "s1", { env: {} })
})

function graphPlugin() {
  let definition
  globalThis.window = { __ModuleLoader__: { load: (m) => (definition = m) } }
  const code = readFileSync(fileURLToPath(new URL("../plugins/graph/client.js", import.meta.url)), "utf8")
  new Function(code)()
  const react = { createElement: () => null, useCallback: (f) => f, useEffect: () => {}, useState: (v) => [v, () => {}] }
  return definition.factory(() => react)
}

test("FL-05: the Graph tab places a step below what it needs", () => {
  const { layers, stateOf } = graphPlugin()
  const diamond = [
    { n: 1, title: "a", status: "pass", after: [] },
    { n: 2, title: "b", status: "pass", after: [1] },
    { n: 3, title: "c", status: "fail", after: [1] },
    { n: 4, title: "d", status: "not started", after: [2, 3] },
  ]
  const { at, edges } = layers(diamond)
  assert.equal(at.get(2).y, at.get(3).y)
  assert.ok(at.get(4).y > at.get(3).y)
  assert.notEqual(at.get(2).x, at.get(3).x)
  assert.equal(edges.length, 4)
  // v1 plans have no `after`: a chain, as they run
  const chain = layers([{ n: 1, title: "a", status: "pass" }, { n: 2, title: "b", status: "pass" }])
  assert.deepEqual(chain.edges, [{ from: 1, to: 2 }])
  assert.equal(stateOf({ status: "fail", attempts: 2 }), "Failing · 2 runs")
  assert.equal(stateOf({ status: "pass", building: { attempt: 3 } }), "Building · attempt 3")
})

test("FL-06: the Graph tab is in the bundle and adds no route", () => {
  const client = readFileSync(fileURLToPath(new URL("../plugins/graph/client.js", import.meta.url)), "utf8")
  assert.doesNotMatch(client, /method:\s*"POST"/)
  assert.ok(existsSync(fileURLToPath(new URL("../plugins/graph/package.json", import.meta.url))))
  const bundle = readFileSync(fileURLToPath(new URL("../bundle/cordis.patch.yml", import.meta.url)), "utf8")
  assert.match(bundle, /id: kriya-graph\n\s+name: '@kriya-ai\/harness-graph'/)
})

// On the real, pinned DSH with a scripted model and a real git repository
test("FL-07: kriya run keeps the person's plan as written, and reports its steps", { timeout: 180_000 }, async () => {
  freshHome()
  const at = realpathSync(mkdtempSync(join(tmpdir(), "kriya-flow-run-")))
  const git = (...a) => execFileSync("git", a, { cwd: at, stdio: "pipe" })
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "T")
  writeFileSync(join(at, "package.json"), JSON.stringify({ type: "commonjs", scripts: { test: "node check.js" } }))
  writeFileSync(join(at, "check.js"), 'require("node:assert").strictEqual(require("./value.js"), "right")\n')
  writeFileSync(join(at, "value.js"), 'module.exports = "missing"\n')
  git("add", ".")
  git("commit", "-qm", "base")
  confirmCheck(at, "npm test")
  const work = dir()
  const env = flowEnv({ plan: { goal: "The person's goal", steps: [{ title: "The person's step", done_when: "check.js passes", files: ["value.js"] }] } }, work)
  const results = []
  const fake = await startFakeKriya({
    approveAfter: 0,
    chat: (body) => {
      if (!body.tools?.length) return { content: "Plan check" }
      const done = body.messages.filter((m) => m.role === "tool").length
      const said = body.messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      if (said.some((t) => t.includes("You are building one step")))
        return done === 0 ? { toolCall: { name: "bash", args: { command: `printf '%s\\n' 'module.exports = "right"' > value.js`, description: "Fix" } } } : { content: "Written." }
      results.splice(0, results.length, ...body.messages.filter((m) => m.role === "tool").map((m) => JSON.stringify(m.content)))
      // The model tries its own plan; the person's stands
      if (done === 0) return { toolCall: { name: "kriya_plan", args: { goal: "The model's goal", steps: [{ title: "The model's step", done_when: "whatever", files: [] }] } } }
      if (done === 1) return { toolCall: { name: "kriya_step", args: { step: 1 } } }
      if (done === 2) return { toolCall: { name: "kriya_plan", args: { goal: "Again", steps: [{ title: "Another", done_when: "x", files: [] }] } } }
      return { content: "Finished." }
    },
  })
  const kriya = (args, cwd, extra = {}) =>
    new Promise((done) => {
      const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), ...args], { cwd, env: { ...process.env, ...extra } })
      let stderr = ""
      child.stderr.on("data", (d) => (stderr += d))
      const timer = setTimeout(() => child.kill("SIGKILL"), 150_000)
      child.on("exit", (code) => {
        clearTimeout(timer)
        done({ code, stderr })
      })
    })
  try {
    const signedIn = await kriya(["login", "--url", fake.url, "--no-browser"], ROOT)
    assert.equal(signedIn.code, 0, signedIn.stderr)
    const r = await kriya(["run", "--loop", "--mode", "auto", "Do the job"], at, env)
    assert.equal(r.code, 0, r.stderr)
    const joined = results.join("\n")
    assert.match(joined, /The person's step/)
    assert.doesNotMatch(joined, /The model's step/)
    assert.match(joined, /can't be replanned/)
    const seen = JSON.parse(readFileSync(env.KRIYA_PROGRESS_FILE, "utf8"))
    assert.deepEqual(seen.plan.map((s) => [s.title, s.status]), [["The person's step", "pass"]])
  } finally {
    await fake.close()
  }
})
