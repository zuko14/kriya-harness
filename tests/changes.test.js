import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { answer, handlers, ROUTES } from "../plugins/changes/index.js"
import { fileDiff, listChanges } from "../src/changes.js"
import { checkpoint } from "../src/checkpoints.js"
import { freshHome } from "./helpers.js"

// The Changes tab (plugins/changes, src/changes.js): every changed file in a
// session's folder against HEAD — modified, added, deleted, renamed,
// untracked, binary — with line counts and a diff, for paths git lists only.

const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } })

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "kriya-changes-"))
  git(dir, "init", "-q", "-b", "main")
  git(dir, "config", "user.email", "t@example.com")
  git(dir, "config", "user.name", "t")
  mkdirSync(join(dir, "src"))
  writeFileSync(join(dir, "src", "keep.js"), "one\ntwo\nthree\n")
  writeFileSync(join(dir, "gone.txt"), "bye\n")
  writeFileSync(join(dir, "move-me.txt"), "a\nb\nc\nd\ne\nf\n")
  git(dir, "add", "-A")
  git(dir, "commit", "-q", "-m", "base")
  return dir
}

test("lists modified, added, deleted, renamed, untracked and binary files with their counts", async () => {
  const dir = repo()
  writeFileSync(join(dir, "src", "keep.js"), "one\nTWO\nthree\nfour\n")
  rmSync(join(dir, "gone.txt"))
  git(dir, "mv", "move-me.txt", "moved.txt")
  writeFileSync(join(dir, "src", "new.js"), "fresh\nlines\n")
  writeFileSync(join(dir, "logo.bin"), Buffer.from([0, 1, 2, 0]))
  const changes = await listChanges(join(dir, "src"))
  assert.equal(changes.git, true)
  assert.equal(changes.branch, "main")
  const by = Object.fromEntries(changes.files.map((f) => [f.path, f]))
  assert.deepEqual([by["src/keep.js"].status, by["src/keep.js"].added, by["src/keep.js"].deleted], ["modified", 2, 1])
  assert.deepEqual([by["gone.txt"].status, by["gone.txt"].deleted], ["deleted", 1])
  assert.deepEqual([by["moved.txt"].status, by["moved.txt"].from], ["renamed", "move-me.txt"])
  assert.deepEqual([by["src/new.js"].status, by["src/new.js"].untracked, by["src/new.js"].added], ["added", true, 2])
  assert.equal(by["logo.bin"].binary, true)
  assert.equal(changes.added, 2 + 2)
})

test("a file's diff: tracked against HEAD, untracked against nothing; only listed paths", async () => {
  const dir = repo()
  writeFileSync(join(dir, "src", "keep.js"), "one\nTWO\nthree\n")
  writeFileSync(join(dir, "fresh.md"), "# hi\n")
  const tracked = await fileDiff(dir, "src/keep.js")
  assert.match(tracked.diff, /^-two$/m)
  assert.match(tracked.diff, /^\+TWO$/m)
  const untracked = await fileDiff(dir, "fresh.md")
  assert.match(untracked.diff, /^\+# hi$/m)
  for (const path of ["gone.txt", "../../etc/passwd", "", null]) await assert.rejects(fileDiff(dir, path), /has no changes|Which file/)
})

test("a repository with no commit yet, and a folder that isn't one", async () => {
  // A folder outside git gets a private store: in a throwaway Kriya home, never the person's
  freshHome()
  const dir = mkdtempSync(join(tmpdir(), "kriya-changes-new-"))
  git(dir, "init", "-q")
  writeFileSync(join(dir, "a.txt"), "x\n")
  git(dir, "add", "a.txt")
  const changes = await listChanges(dir)
  assert.deepEqual(changes.files.map((f) => [f.path, f.status, f.added]), [["a.txt", "added", 1]])
  assert.match((await fileDiff(dir, "a.txt")).diff, /^\+x$/m)
  // A folder in no repository and no session yet: tracked privately, nothing changed
  const plain = await listChanges(mkdtempSync(join(tmpdir(), "kriya-nogit-")))
  assert.equal(plain.shadow, true)
  assert.deepEqual(plain.files, [])
})

// 2026-11-04 (owner: the agent created files, the Changes tab showed nothing):
// in a folder with no repository, the session's changes since its first
// checkpoint, from Kriya's private store; nothing is written into the folder.
test("a folder that isn't a repository: what the session added, changed and deleted, with diffs", async () => {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-changes-nogit-")))
  writeFileSync(join(dir, "keep.js"), "one\ntwo\n")
  writeFileSync(join(dir, "gone.txt"), "bye\n")
  mkdirSync(join(dir, "node_modules"))
  writeFileSync(join(dir, "node_modules", "dep.js"), "x\n")
  // The loop's hook saves this before the agent's first change
  await checkpoint(dir, "s1", "before bash")
  writeFileSync(join(dir, "keep.js"), "one\nTWO\nthree\n")
  rmSync(join(dir, "gone.txt"))
  mkdirSync(join(dir, "src"))
  writeFileSync(join(dir, "src", "main.ts"), "export const a = 1\n")
  writeFileSync(join(dir, "node_modules", "dep2.js"), "y\n")
  const changes = await listChanges(dir, "s1")
  assert.equal(changes.git, true)
  assert.equal(changes.shadow, true)
  assert.deepEqual(
    changes.files.map((f) => [f.path, f.status, f.added, f.deleted]).sort(),
    [["gone.txt", "deleted", 0, 1], ["keep.js", "modified", 2, 1], ["src/main.ts", "added", 1, 0]]
  )
  assert.equal(changes.added, 3)
  assert.match((await fileDiff(dir, "keep.js", "s1")).diff, /^-two$/m)
  assert.match((await fileDiff(dir, "src/main.ts", "s1")).diff, /^\+export const a = 1$/m)
  await assert.rejects(fileDiff(dir, "node_modules/dep2.js", "s1"), /no changes/)
  assert.equal(existsSync(join(dir, ".git")), false)
  // Another session's changes start from its own first checkpoint
  assert.deepEqual((await listChanges(dir, "s2")).files, [])
  // Through the routes: tree ids stay on the server
  const routes = handlers(async (id) => (id === "s1" ? dir : undefined))
  const response = await answer(routes[ROUTES.list], new Request(`http://127.0.0.1/x?session=s1`))
  const body = await response.json()
  assert.equal(body.files.length, 3)
  assert.equal(body.base, undefined)
  assert.equal(body.now, undefined)
  const diff = await answer(routes[ROUTES.diff], new Request(`http://127.0.0.1/x?session=s1&path=keep.js`))
  assert.equal(diff.status, 200)
})

test("routes take a session, never a folder; unknown sessions are refused", async () => {
  const dir = repo()
  writeFileSync(join(dir, "gone.txt"), "changed\n")
  const routes = handlers(async (id) => (id === "s1" ? dir : undefined))
  const get = async (path, query) => {
    const response = await answer(routes[path], new Request(`http://127.0.0.1/x?${new URLSearchParams(query)}`))
    return { status: response.status, body: await response.json() }
  }
  const list = await get(ROUTES.list, { session: "s1" })
  assert.equal(list.status, 200)
  assert.deepEqual(list.body.files.map((f) => f.path), ["gone.txt"])
  assert.equal((await get(ROUTES.diff, { session: "s1", path: "gone.txt" })).status, 200)
  assert.equal((await get(ROUTES.diff, { session: "s1", path: "src/keep.js" })).status, 400)
  assert.equal((await get(ROUTES.list, { session: "nope" })).status, 400)
  assert.equal((await get(ROUTES.list, {})).status, 400)
})

test("a step's builder (a child session) changed the files: the parent session's Changes show them", async () => {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-changes-builder-")))
  writeFileSync(join(dir, "a.txt"), "before\n")
  const started = Date.now() - 1000
  // The builder's hook saves under the builder's own id
  await checkpoint(dir, "builder-child-1", "before bash")
  writeFileSync(join(dir, "a.txt"), "after\n")
  assert.deepEqual((await listChanges(dir, "parent-1")).files, [], "without its start time the parent can't see them")
  const seen = await listChanges(dir, "parent-1", started)
  assert.deepEqual(seen.files.map((f) => [f.path, f.status]), [["a.txt", "modified"]])
  // A session that began after those checkpoints doesn't inherit them
  assert.deepEqual((await listChanges(dir, "later-1", Date.now() + 60_000)).files, [])
  const routes = handlers(async () => dir, async () => started)
  const body = await (await answer(routes[ROUTES.list], new Request("http://127.0.0.1/x?session=parent-1"))).json()
  assert.deepEqual(body.files.map((f) => f.path), ["a.txt"])
})
