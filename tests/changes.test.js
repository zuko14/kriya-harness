import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { answer, handlers, ROUTES } from "../plugins/changes/index.js"
import { fileDiff, listChanges } from "../src/changes.js"

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
  const dir = mkdtempSync(join(tmpdir(), "kriya-changes-new-"))
  git(dir, "init", "-q")
  writeFileSync(join(dir, "a.txt"), "x\n")
  git(dir, "add", "a.txt")
  const changes = await listChanges(dir)
  assert.deepEqual(changes.files.map((f) => [f.path, f.status, f.added]), [["a.txt", "added", 1]])
  assert.match((await fileDiff(dir, "a.txt")).diff, /^\+x$/m)
  assert.deepEqual(await listChanges(mkdtempSync(join(tmpdir(), "kriya-nogit-"))), { git: false })
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
