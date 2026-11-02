import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { HEAVY_CATALOG, linkSkills, skillsDir, unlinkSkill, visibleSkills } from "../src/local-skills.js"
import { freshHome, ROOT } from "./helpers.js"

// `kriya skills`: SKILL.md skills read by DSH's own provider (the same one
// the agent's catalog uses), linked into ~/.kriya/skills.

const temp = (prefix) => mkdtempSync(join(tmpdir(), prefix))

function skill(root, name, description = `Use when testing ${name}.`) {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`)
}

function source() {
  const dir = temp("kriya-skill-src-")
  skill(dir, "alpha-skill")
  skill(dir, "beta-skill")
  // Invalid frontmatter (a name that isn't kebab-case), and a folder with no SKILL.md
  mkdirSync(join(dir, "Bad Skill"))
  writeFileSync(join(dir, "Bad Skill", "SKILL.md"), "---\nname: Bad Skill\ndescription: x\n---\n")
  mkdirSync(join(dir, "notes"))
  return dir
}

test("link, list, relink, unlink: what the agent's catalog gets", async () => {
  freshHome()
  const agentsHome = temp("kriya-agents-")
  const project = temp("kriya-project-")
  const from = source()
  const { linked, kept } = linkSkills(from)
  assert.deepEqual(linked.sort(), ["Bad Skill", "alpha-skill", "beta-skill"])
  assert.deepEqual(kept, [])
  const seen = await visibleSkills(project, { agentsHome })
  assert.deepEqual(seen.skills.map((s) => s.name), ["alpha-skill", "beta-skill"])
  assert.ok(seen.skills.every((s) => s.source === "user-dsh"))
  // DSH skipped the invalid one with a warning; kriya passes it on
  assert.ok(seen.warnings.some((w) => /Bad Skill/.test(w)), seen.warnings.join("\n"))
  assert.ok(seen.catalogChars > 0 && seen.catalogChars < HEAVY_CATALOG)

  assert.deepEqual(linkSkills(from).linked, [])
  assert.deepEqual(linkSkills(from, ["alpha-skill"]).kept, ["alpha-skill"])
  assert.throws(() => linkSkills(from, ["nope"]), /not a skill in/)
  assert.throws(() => linkSkills(join(from, "missing")), /no such folder/)
  assert.throws(() => linkSkills(join(from, "notes")), /has no <name>\/SKILL\.md skills/)

  unlinkSkill("beta-skill")
  assert.deepEqual((await visibleSkills(project, { agentsHome })).skills.map((s) => s.name), ["alpha-skill"])
  assert.throws(() => unlinkSkill("beta-skill"), /isn't linked/)
  assert.throws(() => unlinkSkill("../escape"), /isn't a skill name/)
  // A real folder the person put there is never deleted
  skill(skillsDir(), "my-own")
  assert.throws(() => unlinkSkill("my-own"), /is a folder, not a link/)
})

test("a project's own skill wins a name; a link whose folder is gone is reported", async () => {
  freshHome()
  const agentsHome = temp("kriya-agents-")
  const project = temp("kriya-project-")
  mkdirSync(join(project, ".git"))
  skill(join(project, ".agents", "skills"), "alpha-skill", "The project's version.")
  const from = source()
  linkSkills(from, ["alpha-skill"])
  const seen = await visibleSkills(project, { agentsHome })
  assert.equal(seen.skills.find((s) => s.name === "alpha-skill").source, "project-agents")
  assert.deepEqual(seen.shadowed.map((s) => [s.name, s.source]), [["alpha-skill", "user-dsh"]])

  rmSync(join(from, "alpha-skill"), { recursive: true })
  const after = await visibleSkills(project, { agentsHome })
  assert.deepEqual(after.broken, ["alpha-skill"])
})

test("kriya skills prints each skill, where it comes from, and the catalog cost", () => {
  const home = freshHome()
  const from = source()
  const project = temp("kriya-project-")
  const env = { ...process.env, KRIYA_HOME: home, DSH_AGENTS_HOME: temp("kriya-agents-") }
  const run = (args) => spawnSync(process.execPath, [join(ROOT, "bin", "kriya.js"), ...args], { cwd: project, env, encoding: "utf8" })
  const link = run(["skills", "link", from, "--only", "alpha-skill,beta-skill"])
  assert.equal(link.status, 0, link.stderr)
  assert.match(link.stdout, /Linked 2 skill\(s\) into /)
  assert.match(link.stdout, /^ {2}alpha-skill +~\/\.kriya\/skills$/m)
  assert.match(link.stdout, /2 skill\(s\); the catalog is about \d+ tokens on every request\./)
  // A heavy catalog gets a warning
  const big = temp("kriya-skill-big-")
  for (let i = 0; i < 90; i++) skill(big, `big-${i}`, "x".repeat(480))
  symlinkSync(big, join(home, "unused"))
  assert.match(run(["skills", "link", big]).stdout, /That's a lot for every request/)
  assert.equal(run(["skills", "unlink", "../x"]).status, 1)
  assert.match(run(["skills", "frob"]).stdout, /Unknown skills command frob/)
})
