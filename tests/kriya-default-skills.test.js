import assert from "node:assert/strict"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { answer, handlers, KRIYA_AGENT, KRIYA_DEFAULTS, ROUTES } from "../plugins/skills/index.js"
import { setSkillSwitch } from "../src/skill-switches.js"
import { freshHome } from "./helpers.js"

// The Skills page with Kriya's skills (WORKSPACE_PANEL_SKILLS_PLUGINS.md §4),
// WP-SK-*: the Kriya default skills (kriya-*) and the Kriya agent's own come
// first, read-only, with the same switches; Kriya unreachable is a warning.

const candidate = (name, description) => ({ name, description, provider: "kriya", source: "custom", locator: { id: name, version: "1.0.0" } })
const source = (list, bodies = {}) => ({ list: async () => list, get: async (c) => (bodies[c.name] ? { name: c.name, content: bodies[c.name] } : undefined) })
const get = (route, query = "") => new Request(`http://127.0.0.1${route}${query}`)

function setup(kriya) {
  const home = freshHome()
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "kriya-sk-")))
  const table = handlers(() => cwd, { agentsHome: home }, kriya)
  return { cwd, table }
}

test("WP-SK-01: Kriya default skills are listed first, grouped, read-only, and switchable", async () => {
  const { cwd, table } = setup(source([candidate("kriya-verify", "Run kriya_verify before claiming done."), candidate("task-planning", "Plans tasks.")], { "kriya-verify": "# Verify before claiming done\n" }))
  setSkillSwitch(cwd, "task-planning", "off-here")
  const page = await (await answer(table[ROUTES.list], get(ROUTES.list))).json()
  assert.deepEqual(page.skills.slice(0, 2).map((s) => [s.name, s.where, s.state, s.editable, s.source]), [
    ["kriya-verify", KRIYA_DEFAULTS, "on", false, "kriya"],
    ["task-planning", KRIYA_AGENT, "off-here", false, "kriya"],
  ])
  assert.ok(page.catalogTokens > 0)
  const read = await (await answer(table[ROUTES.read], get(ROUTES.read, "?name=kriya-verify"))).json()
  assert.equal(read.content, "# Verify before claiming done\n")
  assert.equal(read.editable, false)
  assert.equal((await answer(table[ROUTES.read], get(ROUTES.read, "?name=nope"))).status, 400)
  // The same switch the page uses for local skills
  const off = await answer(table[ROUTES.switch], new Request(`http://127.0.0.1${ROUTES.switch}`, { method: "POST", body: JSON.stringify({ name: "kriya-verify", state: "off-everywhere" }) }))
  assert.equal(off.status, 200)
  const after = await (await answer(table[ROUTES.list], get(ROUTES.list))).json()
  assert.equal(after.skills.find((s) => s.name === "kriya-verify").state, "off-everywhere")
})

test("WP-SK-02: Kriya unreachable keeps the page working with a warning; signed out shows none", async () => {
  const down = setup({ list: async () => ({ candidates: [candidate("kriya-plan", "Plan steps.")], complete: false }), get: async () => undefined })
  const page = await (await answer(down.table[ROUTES.list], get(ROUTES.list))).json()
  assert.equal(page.skills[0].name, "kriya-plan")
  assert.ok(page.warnings.some((w) => /isn't answering/.test(w)))
  assert.equal((await answer(down.table[ROUTES.read], get(ROUTES.read, "?name=kriya-plan"))).status, 400)
  const out = setup(source([]))
  const empty = await (await answer(out.table[ROUTES.list], get(ROUTES.list))).json()
  assert.equal(empty.skills.filter((s) => s.source === "kriya").length, 0)
})
