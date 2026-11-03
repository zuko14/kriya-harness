import assert from "node:assert/strict"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { answer, apply, handlers, inject, ROUTES } from "../plugins/skills/index.js"
import { skillsDir } from "../src/local-skills.js"
import { freshHome } from "./helpers.js"

// The Skills page's routes (plugins/skills): found through DSH's own catalog,
// writes only to skills you own, every save re-checked by DSH's parser.

const temp = (prefix) => mkdtempSync(join(tmpdir(), prefix))

function skill(root, name, description = `Use when testing ${name}.`) {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`)
}

function setup() {
  freshHome()
  const project = temp("kriya-page-project-")
  const roots = { agentsHome: temp("kriya-page-agents-") }
  const plugin = temp("kriya-page-plugin-")
  skill(plugin, "linked-one")
  mkdirSync(skillsDir(), { recursive: true })
  symlinkSync(join(plugin, "linked-one"), join(skillsDir(), "linked-one"), "dir")
  skill(skillsDir(), "my-own")
  const routes = handlers(() => project, roots)
  const get = async (path, query = "") => {
    const response = await answer(routes[path], new Request(`http://127.0.0.1/x${query}`))
    return { status: response.status, body: await response.json() }
  }
  const post = async (path, body) => {
    const response = await answer(
      routes[path],
      new Request("http://127.0.0.1/x", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) })
    )
    return { status: response.status, body: await response.json() }
  }
  return { project, plugin, get, post }
}

test("list and read: what the catalog holds, linked or yours, never a path from the browser", async () => {
  const { get, plugin } = setup()
  const list = await get(ROUTES.list)
  assert.equal(list.status, 200)
  assert.deepEqual(list.body.skills.map((s) => [s.name, s.linked, s.editable, s.canCopy]), [
    ["linked-one", true, false, true],
    ["my-own", false, true, false],
  ])
  assert.ok(list.body.catalogTokens > 0)
  const read = await get(ROUTES.read, "?name=my-own")
  assert.equal(read.status, 200)
  assert.match(read.body.content, /^---\nname: my-own/)
  assert.equal((await get(ROUTES.read, "?name=linked-one")).body.linkTarget.endsWith(join(plugin.split("/").pop(), "linked-one")), true)
  // A path, an unknown name or nothing: refused
  for (const query of ["?name=../etc/passwd", "?name=nope", ""]) assert.equal((await get(ROUTES.read, query)).status, 400, query)
})

test("save: yours only, the name kept, DSH's parser checks it, the old version back if it can't read it", async () => {
  const { post } = setup()
  const file = join(skillsDir(), "my-own", "SKILL.md")
  const good = "---\nname: my-own\ndescription: Use when testing the save route.\n---\n\n# Better\n"
  const saved = await post(ROUTES.save, { name: "my-own", content: good })
  assert.equal(saved.status, 200)
  assert.equal(readFileSync(file, "utf8"), good)

  // Frontmatter DSH rejects (no description): refused, the previous file kept
  const broken = await post(ROUTES.save, { name: "my-own", content: "---\nname: my-own\n---\nno description\n" })
  assert.equal(broken.status, 400)
  assert.match(broken.body.error, /Not saved: the agent couldn't read it/)
  assert.equal(readFileSync(file, "utf8"), good)

  assert.match((await post(ROUTES.save, { name: "my-own", content: good.replace("name: my-own", "name: other") })).body.error, /Keep "name: my-own"/)
  assert.match((await post(ROUTES.save, { name: "my-own", content: "x".repeat(70_000) })).body.error, /64 KB/)
  assert.match((await post(ROUTES.save, { name: "linked-one", content: good })).body.error, /Make your own copy first/)
  assert.equal((await post(ROUTES.save, "not json")).status, 400)
})

test("copy turns a link into your own folder and leaves the source untouched; then it saves", async () => {
  const { post, plugin } = setup()
  const source = join(plugin, "linked-one", "SKILL.md")
  const before = readFileSync(source, "utf8")
  const copied = await post(ROUTES.copy, { name: "linked-one" })
  assert.equal(copied.status, 200)
  assert.equal(copied.body.linked, false)
  assert.equal(copied.body.editable, true)
  assert.equal(lstatSync(join(skillsDir(), "linked-one")).isSymbolicLink(), false)
  const edited = before.replace("# linked-one", "# mine now")
  assert.equal((await post(ROUTES.save, { name: "linked-one", content: edited })).status, 200)
  assert.equal(readFileSync(source, "utf8"), before)
  assert.match((await post(ROUTES.copy, { name: "my-own" })).body.error, /isn't a linked skill/)
})

test("create a new skill; refuse bad names, duplicates and empty descriptions; unlink links only", async () => {
  const { post, get } = setup()
  const created = await post(ROUTES.create, { name: "release-notes", description: "Use when writing release notes: group by feature." })
  assert.equal(created.status, 200)
  assert.equal(created.body.editable, true)
  assert.ok((await get(ROUTES.list)).body.skills.some((s) => s.name === "release-notes"))
  assert.match((await post(ROUTES.create, { name: "Release Notes", description: "Use when anything at all." })).body.error, /isn't a skill name/)
  assert.match((await post(ROUTES.create, { name: "my-own", description: "Use when anything at all." })).body.error, /already a skill/)
  assert.match((await post(ROUTES.create, { name: "short-one", description: "x" })).body.error, /at least 10/)
  // A description with YAML-special characters stays one valid value
  const tricky = await post(ROUTES.create, { name: "tricky-one", description: 'Use when: "quotes", colons: and # hashes appear.' })
  assert.equal(tricky.status, 200, tricky.body.error)

  assert.equal((await post(ROUTES.unlink, { name: "linked-one" })).status, 200)
  assert.equal(existsSync(join(skillsDir(), "linked-one")), false)
  assert.match((await post(ROUTES.unlink, { name: "my-own" })).body.error, /is a folder, not a link/)
})

test("routes go on DSH's fenced /api channel: GET for reads, POST for writes; an unexpected failure is a plain 500", async () => {
  assert.deepEqual(inject, ["connection"])
  const registered = []
  const ctx = {
    effect: (fn) => fn(),
    logger: () => ({ warn() {} }),
    connection: { fetch: { register: (route) => (registered.push(route), async () => {}) } },
  }
  apply(ctx)
  assert.deepEqual(
    registered.map((r) => [r.path, r.methods.join(","), r.requestBody]).sort(),
    [
      ["/api/kriya.skill", "GET", "buffered"],
      ["/api/kriya.skill.copy", "POST", "buffered"],
      ["/api/kriya.skill.create", "POST", "buffered"],
      ["/api/kriya.skill.save", "POST", "buffered"],
      ["/api/kriya.skill.switch", "POST", "buffered"],
      ["/api/kriya.skill.unlink", "POST", "buffered"],
      ["/api/kriya.skills", "GET", "buffered"],
    ]
  )
  let logged = null
  const failed = await answer(() => { throw new Error("disk on fire") }, new Request("http://x/"), (e) => (logged = e))
  assert.equal(failed.status, 500)
  assert.doesNotMatch(JSON.stringify(await failed.json()), /disk on fire/)
  assert.equal(logged.message, "disk on fire")
})
