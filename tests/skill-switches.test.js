import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { answer, handlers, ROUTES } from "../plugins/skills/index.js"
import { skillsDir } from "../src/local-skills.js"
import { offFor, projectRoot, readSwitches, setSkillSwitch, switchesFile, switchProvider } from "../src/skill-switches.js"
import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"

// Skill switches (src/skill-switches.js): a skill turned off for a project or
// everywhere leaves the agent's catalog, `skill` tool and /name, without its
// files being touched; the Skills page and `kriya skills` show it and what it
// saves. The last test proves it on the real, pinned DSH.

const temp = (prefix) => mkdtempSync(join(tmpdir(), prefix))

function skill(root, name, description = `Use when testing ${name}, with enough words to cost something.`) {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBODY-OF-${name}\n`)
}

function repo() {
  const dir = temp("kriya-switch-repo-")
  mkdirSync(join(dir, ".git"))
  mkdirSync(join(dir, "src", "deep"), { recursive: true })
  return dir
}

test("off here is per project (keyed by its git root), off everywhere is everywhere, on clears both", () => {
  freshHome()
  const a = repo()
  const b = repo()
  setSkillSwitch(join(a, "src", "deep"), "alpha", "off-here")
  assert.equal(projectRoot(join(a, "src", "deep")), projectRoot(a))
  assert.deepEqual([...offFor(a)], [["alpha", "here"]])
  assert.deepEqual([...offFor(b)], [])
  setSkillSwitch(b, "beta", "off-everywhere")
  assert.deepEqual([...offFor(a)].sort(), [["alpha", "here"], ["beta", "everywhere"]])
  // Off everywhere wins over off here; on clears both
  setSkillSwitch(a, "alpha", "off-everywhere")
  assert.deepEqual(readSwitches(), { everywhere: ["alpha", "beta"], projects: {} })
  setSkillSwitch(a, "alpha", "on")
  setSkillSwitch(a, "beta", "on")
  assert.deepEqual(readSwitches(), { everywhere: [], projects: {} })
  // Refused: paths, unknown states
  assert.throws(() => setSkillSwitch(a, "../x", "on"), /isn't a skill name/)
  assert.throws(() => setSkillSwitch(a, "alpha", "maybe"), /on, off-here or off-everywhere/)
})

test("a broken or hand-edited file turns nothing off and never throws", () => {
  freshHome()
  mkdirSync(join(switchesFile(), ".."), { recursive: true })
  writeFileSync(switchesFile(), "{not json")
  assert.deepEqual(readSwitches(), { everywhere: [], projects: {} })
  writeFileSync(switchesFile(), JSON.stringify({ everywhere: ["ok-name", "../bad", 3], projects: { "/x": "nope" } }))
  assert.deepEqual(readSwitches(), { everywhere: ["ok-name"], projects: {} })
})

test("the provider reports each turned-off name at rank 0 with both surfaces off, and tells DSH at once", async () => {
  freshHome()
  const dir = repo()
  let invalidated = 0
  const abort = new AbortController()
  const provider = switchProvider({ invalidate: () => invalidated++, signal: abort.signal })
  assert.deepEqual(await provider.list({ cwd: dir }), [])
  setSkillSwitch(dir, "alpha", "off-here")
  assert.equal(invalidated, 1)
  const [entry] = await provider.list({ cwd: dir })
  assert.equal(entry.name, "alpha")
  assert.equal(entry.rank, 0)
  assert.deepEqual(entry.invocation, { modelInvocable: false, userInvocable: false })
  assert.equal(await provider.get(entry, {}), undefined)
  abort.abort()
  setSkillSwitch(dir, "alpha", "on")
  assert.equal(invalidated, 1)
})

test("the Skills page lists each skill's state and counts only the ones on", async () => {
  freshHome()
  const project = repo()
  skill(skillsDir(), "alpha")
  skill(skillsDir(), "beta")
  const routes = handlers(() => project, { agentsHome: temp("kriya-switch-agents-") })
  const call = async (path, body) => {
    const request = body
      ? new Request("http://127.0.0.1/x", { method: "POST", body: JSON.stringify(body) })
      : new Request("http://127.0.0.1/x")
    const response = await answer(routes[path], request)
    return { status: response.status, body: await response.json() }
  }
  const before = (await call(ROUTES.list)).body
  assert.deepEqual(before.skills.map((s) => [s.name, s.state]), [["alpha", "on"], ["beta", "on"]])
  assert.equal(before.offTokens, 0)
  assert.equal(before.project, projectRoot(project))

  const off = await call(ROUTES.switch, { name: "beta", state: "off-here" })
  assert.equal(off.status, 200)
  const after = (await call(ROUTES.list)).body
  assert.deepEqual(after.skills.map((s) => [s.name, s.state]), [["alpha", "on"], ["beta", "off-here"]])
  assert.ok(after.catalogTokens < before.catalogTokens)
  assert.equal(after.catalogTokens + after.offTokens, before.catalogTokens)
  assert.equal((await call(ROUTES.read, undefined).catch(() => null))?.status ?? 400, 400)
  assert.equal((await call(ROUTES.switch, { name: "beta", state: "sideways" })).status, 400)
  assert.equal((await call(ROUTES.switch, { name: "../etc", state: "on" })).status, 400)
})

test("kriya skills off/on: the listing shows it and what it saves", () => {
  freshHome()
  const project = repo()
  skill(skillsDir(), "alpha")
  const run = (...args) => spawnSync(process.execPath, [join(ROOT, "bin", "kriya.js"), "skills", ...args], { cwd: project, env: { ...process.env, DSH_AGENTS_HOME: temp("kriya-switch-agents-") }, encoding: "utf8" })
  const off = run("off", "alpha")
  assert.equal(off.status, 0, off.stderr)
  assert.match(off.stdout, /alpha is off in /)
  assert.match(off.stdout, /alpha .*\(off in this project\)/)
  assert.match(off.stdout, /0 skill\(s\) on, 1 off.*saves about \d+/)
  assert.match(run("off", "alpha", "--everywhere").stdout, /\(off everywhere\)/)
  const on = run("on", "alpha")
  assert.match(on.stdout, /alpha is on\./)
  assert.match(on.stdout, /1 skill\(s\) on, 0 off/)
  assert.equal(run("off").status, 1)
})

function kriya(args, cwd) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), ...args], { cwd, env: process.env })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000)
    child.on("exit", (code) => {
      clearTimeout(timer)
      done({ code, stdout, stderr })
    })
  })
}

test("on the real DSH, a skill that's off isn't in the catalog and can't be loaded", { timeout: 300_000 }, async () => {
  freshHome()
  const project = repo()
  skill(skillsDir(), "alpha-guide")
  skill(skillsDir(), "beta-guide")
  setSkillSwitch(project, "beta-guide", "off-here")
  let first = null
  let results = []
  const fake = await startFakeKriya({
    approveAfter: 0,
    chat: (body) => {
      if (!body.tools?.length) return { content: "Switch check" }
      first ??= JSON.stringify(body.messages)
      results = body.messages.filter((m) => m.role === "tool")
      if (results.length === 0) return { toolCall: { name: "skill", args: { name: "beta-guide" } } }
      if (results.length === 1) return { toolCall: { name: "skill", args: { name: "alpha-guide" } } }
      return { content: "Done." }
    },
  })
  const login = await kriya(["login", "--url", fake.url, "--no-browser"], ROOT)
  assert.equal(login.code, 0, login.stderr)
  const run = await kriya(["run", "Use the guides"], project)
  await fake.close()
  const report = `exit ${run.code}\nfirst request: ${String(first).slice(0, 1500)}\nstderr: ${run.stderr.slice(-800)}`
  assert.equal(run.code, 0, report)
  assert.match(first, /alpha-guide/, report)
  assert.doesNotMatch(first, /beta-guide/, report)
  const texts = results.map((m) => JSON.stringify(m.content))
  assert.match(texts[0], /beta-guide.*(unknown|not available)/, report)
  assert.doesNotMatch(texts[0], /BODY-OF-beta-guide/, report)
  assert.match(texts[1], /BODY-OF-alpha-guide/, report)
})
