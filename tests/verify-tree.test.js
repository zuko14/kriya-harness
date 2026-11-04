import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { RECHECK, recheckHook } from "../plugins/loop/index.js"
import { checkFiles, confirmCheck, currentVerdict, verifyStep, workTree } from "../src/verify.js"
import { freshHome } from "./helpers.js"

// Harness upgrade U8 (HU-VF-01…03): a pass belongs to the files it ran on.

function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-tree-")))
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" })
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "T")
  writeFileSync(join(dir, "a.js"), "1\n")
  git("add", ".")
  git("commit", "-qm", "base")
  return dir
}
const objects = (dir) => readdirSync(join(dir, ".git", "objects"), { recursive: true }).length

test("HU-VF-01: the fingerprint follows content, untracked files and HEAD, and writes nothing to .git", async () => {
  const dir = repo()
  const clean = await workTree(dir)
  assert.deepEqual(clean.changed, [])
  const before = objects(dir)
  writeFileSync(join(dir, "a.js"), "2\n")
  const edited = await workTree(dir)
  assert.notEqual(edited.fingerprint, clean.fingerprint)
  assert.deepEqual(edited.changed, ["a.js"])
  writeFileSync(join(dir, "new.txt"), "x\n")
  const added = await workTree(dir)
  assert.notEqual(added.fingerprint, edited.fingerprint)
  assert.deepEqual(added.changed, ["a.js", "new.txt"])
  // Same files, same fingerprint; content changes it even when the paths don't
  assert.equal((await workTree(dir)).fingerprint, added.fingerprint)
  writeFileSync(join(dir, "a.js"), "3\n")
  assert.notEqual((await workTree(dir)).fingerprint, added.fingerprint)
  assert.equal(objects(dir), before)
  // Outside a repository: none
  assert.equal(await workTree(realpathSync(mkdtempSync(join(tmpdir(), "kriya-norepo-")))), undefined)
})

test("HU-VF-02: verified holds only for the files it ran on; a pass names changed test and check files", async () => {
  freshHome()
  const dir = repo()
  confirmCheck(dir, "true")
  writeFileSync(join(dir, "a.test.js"), "test\n")
  const pass = await verifyStep({ cwd: dir, sessionId: "s1", step: "1", run: async () => ({ exitCode: 0, timedOut: false, output: "" }) })
  assert.equal(pass.verdict, "verified")
  assert.deepEqual(pass.touched, ["a.test.js"])
  assert.equal((await currentVerdict(dir, "s1")).status, "verified")
  writeFileSync(join(dir, "a.js"), "changed after the pass\n")
  const now = await currentVerdict(dir, "s1")
  assert.equal(now.status, "not checked")
  assert.equal(now.stale, true)
  assert.deepEqual(now.touched, ["a.test.js"])
  // Checked again: verified for the new files
  await verifyStep({ cwd: dir, sessionId: "s1", step: "1", run: async () => ({ exitCode: 0, timedOut: false, output: "" }) })
  assert.equal((await currentVerdict(dir, "s1")).status, "verified")
  // No runs: not checked, never stale
  assert.deepEqual(await currentVerdict(dir, "none"), { status: "not checked", steps: [] })
  assert.deepEqual(checkFiles(["src/x.js", "tests/y.js", "pkg/z_test.go", "package.json", "README.md"]), ["tests/y.js", "pkg/z_test.go", "package.json"])
})

test("HU-VF-03: at the turn's end a stale pass is sent back once per turn; a fresh one isn't", async () => {
  const steered = []
  const agent = { id: "s", steer: (m) => steered.push(m) }
  let stale = true
  const hook = recheckHook({ cwd: async () => "/x", verdict: async () => (stale ? { status: "not checked", stale: true } : { status: "verified" }), message: (t) => t })
  await hook({ agent, turn: 1 })
  await hook({ agent, turn: 1 })
  assert.deepEqual(steered, [RECHECK])
  await hook({ agent, turn: 2 })
  assert.equal(steered.length, 2)
  stale = false
  await hook({ agent, turn: 3 })
  assert.equal(steered.length, 2)
})
