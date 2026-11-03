import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { findProjects, LIMIT } from "../src/projects.js"
import { ROOT } from "./helpers.js"

// The Projects page's list (src/projects.js): project folders under the
// usual places in home, one level of group folders, extra roots from
// KRIYA_PROJECT_ROOTS, the folder kriya started in, nothing else.

function home() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-projects-")))
  const make = (path, marker) => {
    mkdirSync(join(dir, path), { recursive: true })
    if (marker === ".git") mkdirSync(join(dir, path, ".git"), { recursive: true })
    else if (marker) writeFileSync(join(dir, path, marker), "")
  }
  make("Developer/app", ".git")
  make("Developer/lib", "package.json")
  make("Developer/org/service", "go.mod") // a group folder: one level deeper
  make("Developer/notes") // no marker: not a project
  make("Developer/node_modules/pkg", "package.json") // skipped folder
  make("Developer/.hidden", ".git") // hidden: skipped
  make("Documents/thesis", ".git") // macOS asks before Documents is read: not searched unless named
  make("elsewhere/tool", "Cargo.toml")
  make("started", undefined)
  return dir
}

test("finds project folders in the usual places and one level of group folders", () => {
  const dir = home()
  const { projects, truncated } = findProjects({ home: dir, cwd: join(dir, "started"), extra: "" })
  const paths = projects.map((p) => p.shown)
  assert.deepEqual(paths.slice(1).sort(), ["~/Developer/app", "~/Developer/lib", "~/Developer/org/service"])
  assert.equal(truncated, false)
  const app = projects.find((p) => p.name === "app")
  assert.equal(app.git, true)
  assert.equal(app.root, "~/Developer")
  assert.equal(projects.find((p) => p.name === "lib").git, false)
})

test("the folder kriya started in comes first, project or not", () => {
  const dir = home()
  const { projects } = findProjects({ home: dir, cwd: join(dir, "started"), extra: "" })
  assert.equal(projects[0].shown, "~/started")
  assert.equal(projects[0].here, true)
  assert.equal(projects[0].root, "Started here")
})

test("KRIYA_PROJECT_ROOTS adds folders, Documents included, with ~ and the PATH separator", () => {
  const dir = home()
  const { projects, roots } = findProjects({ home: dir, cwd: join(dir, "started"), extra: ["~/Documents", join(dir, "elsewhere")].join(":") })
  const names = projects.map((p) => p.name)
  assert.ok(names.includes("thesis"))
  assert.ok(names.includes("tool"))
  assert.equal(roots[0], join(dir, "Documents"))
})

test("a missing home or root lists nothing and doesn't throw", () => {
  const { projects } = findProjects({ home: join(tmpdir(), "kriya-no-such-home"), cwd: join(tmpdir(), "kriya-no-such-cwd"), extra: "/nope" })
  assert.deepEqual(projects, [])
})

test("the list is capped", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-projects-many-")))
  for (let i = 0; i < LIMIT + 5; i++) mkdirSync(join(dir, "Developer", `p${i}`, ".git"), { recursive: true })
  const { projects, truncated } = findProjects({ home: dir, cwd: join(dir, "Developer"), extra: "" })
  assert.ok(projects.length <= LIMIT)
  assert.equal(truncated, true)
})

test("the Projects page is in every Web UI profile's bundle and the plugin is browser-ready", () => {
  const dump = readFileSync(join(ROOT, "expected", "kriya.dump.yml"), "utf8")
  assert.match(dump, /- id: kriya-projects\n {2}name: '@kriya-ai\/harness-projects'\n/)
  const pkg = JSON.parse(readFileSync(join(ROOT, "plugins", "projects", "package.json"), "utf8"))
  assert.equal(pkg.exports["./client"], "./client.js")
  assert.equal(pkg.dsh.client.platform, "web")
})

// A row's block in a recorded dump, up to the next row
const row = (dump, id) => {
  const start = dump.indexOf(`- id: ${id}\n`)
  assert.ok(start >= 0, `${id} is in the dump`)
  const end = dump.indexOf("\n- id: ", start + 1)
  return dump.slice(start, end === -1 ? undefined : end)
}

test("Creator mode, DSH's plugin pages and its plugin-authoring entries are off", () => {
  const dump = readFileSync(join(ROOT, "expected", "kriya.dump.yml"), "utf8")
  for (const id of ["preset-cordis", "ui-cordis", "entry-customization", "ui-plugin-manager", "ui-settings-plugins", "ui-settings-plugin-inventory"])
    assert.match(row(dump, id), /\n {2}disabled: true(\n|$)/, id)
  // `kriya run` and editors (ACP) have no agent presets, so no Creator mode
  for (const profile of ["kriya-run", "kriya-acp"])
    assert.doesNotMatch(readFileSync(join(ROOT, "expected", `${profile}.dump.yml`), "utf8"), /id: cordis\n/, profile)
})
