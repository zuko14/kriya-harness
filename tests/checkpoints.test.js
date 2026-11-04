import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { checkpoint, CheckpointError, KEEP, listCheckpoints, undo } from "../src/checkpoints.js"
import { freshHome } from "./helpers.js"

// H14b undo drills on real git (KRIYA_LOOP.md §5): clean, dirty and
// mid-rebase repositories. Each drill fingerprints what is the person's
// (every ref outside refs/kriya, HEAD, the index file, the stash, a rebase
// in progress) before and after, and they must be identical.

const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "P", GIT_AUTHOR_EMAIL: "p@x", GIT_COMMITTER_NAME: "P", GIT_COMMITTER_EMAIL: "p@x" } }).trim()
const read = (dir, path) => readFileSync(join(dir, path), "utf8")
const write = (dir, path, content) => {
  mkdirSync(join(dir, path, ".."), { recursive: true })
  writeFileSync(join(dir, path), content)
}

function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-ckpt-")))
  git(dir, "init", "-q", "-b", "main")
  write(dir, ".gitignore", "secret.env\nbuild/\n")
  write(dir, "a.txt", "a1\n")
  write(dir, "src/b.txt", "b1\n")
  git(dir, "add", ".")
  git(dir, "commit", "-q", "-m", "one")
  git(dir, "tag", "v1")
  return dir
}

/** Everything that is the person's, by hash */
function fingerprint(dir) {
  const refs = git(dir, "for-each-ref", "--format=%(refname) %(objectname)")
    .split("\n")
    .filter((line) => line && !line.startsWith("refs/kriya/"))
  const gitDir = join(dir, ".git")
  const index = existsSync(join(gitDir, "index")) ? createHash("sha256").update(readFileSync(join(gitDir, "index"))).digest("hex") : null
  return {
    refs,
    head: readFileSync(join(gitDir, "HEAD"), "utf8"),
    headCommit: git(dir, "rev-parse", "HEAD"),
    index,
    stash: git(dir, "stash", "list"),
    rebase: existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply")),
  }
}

test("clean repository: a change, undo, and the files are back; the person's refs untouched", async () => {
  freshHome()
  const dir = repo()
  const before = fingerprint(dir)
  const first = await checkpoint(dir, "s1", "before edit a.txt")
  assert.equal(first.created, true)
  assert.match(first.ref, /^refs\/kriya\/checkpoints\/s1\/000001$/)
  // The agent edits, adds and deletes
  write(dir, "a.txt", "a2\n")
  write(dir, "src/new/c.txt", "c\n")
  rmSync(join(dir, "src", "b.txt"))
  const result = await undo(dir)
  assert.equal(result.changed, 3)
  assert.equal(read(dir, "a.txt"), "a1\n")
  assert.equal(read(dir, "src/b.txt"), "b1\n")
  assert.ok(!existsSync(join(dir, "src", "new")), "a folder the undo emptied is gone")
  assert.deepEqual(fingerprint(dir), before)
  // git sees no change: the tree matches HEAD again
  assert.equal(git(dir, "status", "--porcelain"), "")
})

test("dirty repository: staged, unstaged and untracked work come back as they were; ignored files and the index untouched", async () => {
  freshHome()
  const dir = repo()
  write(dir, "a.txt", "staged\n")
  git(dir, "add", "a.txt")
  write(dir, "a.txt", "staged then edited\n")
  write(dir, "notes.md", "untracked\n")
  write(dir, "secret.env", "TOKEN=keep-me\n")
  write(dir, "build/out.bin", "artifact\n")
  git(dir, "stash", "list")
  const before = fingerprint(dir)
  const status = git(dir, "status", "--porcelain")

  await checkpoint(dir, "s1", "before step 1")
  write(dir, "a.txt", "agent\n")
  write(dir, "notes.md", "agent rewrote\n")
  write(dir, "secret.env", "TOKEN=agent-changed\n")
  await undo(dir)

  assert.equal(read(dir, "a.txt"), "staged then edited\n")
  assert.equal(read(dir, "notes.md"), "untracked\n")
  // Ignored files are never in a checkpoint, so undo leaves them as they are
  assert.equal(read(dir, "secret.env"), "TOKEN=agent-changed\n")
  assert.equal(read(dir, "build/out.bin"), "artifact\n")
  assert.deepEqual(fingerprint(dir), before)
  assert.equal(git(dir, "status", "--porcelain"), status)
})

test("mid-rebase: undo restores the files and leaves the rebase, HEAD and index alone", async () => {
  freshHome()
  const dir = repo()
  git(dir, "checkout", "-q", "-b", "feature")
  write(dir, "a.txt", "feature\n")
  git(dir, "commit", "-q", "-am", "feature")
  git(dir, "checkout", "-q", "main")
  write(dir, "a.txt", "main\n")
  git(dir, "commit", "-q", "-am", "main")
  git(dir, "checkout", "-q", "feature")
  assert.throws(() => git(dir, "rebase", "main"))
  const before = fingerprint(dir)
  assert.equal(before.rebase, true)
  const conflicted = read(dir, "a.txt")

  await checkpoint(dir, "s1", "before resolving")
  write(dir, "a.txt", "agent's bad resolution\n")
  await undo(dir)

  assert.equal(read(dir, "a.txt"), conflicted)
  assert.deepEqual(fingerprint(dir), before)
})

test("an undo is itself saved: the state it replaced can be restored", async () => {
  freshHome()
  const dir = repo()
  await checkpoint(dir, "s1", "before step 1")
  write(dir, "a.txt", "agent work\n")
  const first = await undo(dir)
  assert.equal(read(dir, "a.txt"), "a1\n")
  assert.match(first.saved.ref, /^refs\/kriya\/undone\/000001$/)
  const list = await listCheckpoints(dir)
  const n = list.findIndex((c) => c.ref === first.saved.ref) + 1
  await undo(dir, { target: n })
  assert.equal(read(dir, "a.txt"), "agent work\n")
})

test("one step at a time, unchanged trees aren't saved twice, and the oldest are dropped", async () => {
  freshHome()
  const dir = repo()
  await checkpoint(dir, "s1", "step 1")
  assert.equal((await checkpoint(dir, "s1", "step 1 again")).created, false)
  write(dir, "a.txt", "after 1\n")
  await checkpoint(dir, "s1", "step 2")
  write(dir, "a.txt", "after 2\n")
  await undo(dir)
  assert.equal(read(dir, "a.txt"), "after 1\n")
  await undo(dir)
  assert.equal(read(dir, "a.txt"), "a1\n")
  await assert.rejects(undo(dir), /Nothing to undo/)

  for (let i = 0; i < KEEP + 3; i++) {
    write(dir, "a.txt", `v${i}\n`)
    await checkpoint(dir, "s2", `step ${i}`)
  }
  assert.equal((await listCheckpoints(dir)).filter((c) => c.session === "s2").length, KEEP)
})

test("outside a git repository: checkpoints and undo work from Kriya's private store; the folder gets nothing", async () => {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-nogit-")))
  writeFileSync(join(dir, "app.js"), "one\n")
  mkdirSync(join(dir, "node_modules", "dep"), { recursive: true })
  writeFileSync(join(dir, "node_modules", "dep", "index.js"), "dependency\n")
  const first = await checkpoint(dir, "s1", "before edit")
  assert.ok(first?.created, "a checkpoint outside git")
  assert.equal(existsSync(join(dir, ".git")), false, "no .git written into the folder")
  writeFileSync(join(dir, "app.js"), "two\n")
  writeFileSync(join(dir, "new.js"), "made by the agent\n")
  await checkpoint(dir, "s1", "after edit")
  const { trackedRoot, shadowDir } = await import("../src/checkpoints.js")
  const store = shadowDir(dir)
  const tracked = execFileSync("git", ["--git-dir", store, "ls-tree", "-r", "--name-only", first.tree], { encoding: "utf8" })
  assert.doesNotMatch(tracked, /node_modules/, "dependency folders are never tracked")
  assert.deepEqual(await trackedRoot(dir), { root: dir, shadow: true })
  await undo(dir, { target: (await listCheckpoints(dir)).findIndex((c) => c.label === "before edit") + 1 })
  assert.equal(readFileSync(join(dir, "app.js"), "utf8"), "one\n")
  assert.equal(existsSync(join(dir, "new.js")), false)
  assert.equal(readFileSync(join(dir, "node_modules", "dep", "index.js"), "utf8"), "dependency\n", "untracked folders untouched by undo")
  await assert.rejects(checkpoint(dir, "../x", "x"), CheckpointError)
})

test("the home folder and filesystem roots are never tracked", async () => {
  const { tooBroad } = await import("../src/checkpoints.js")
  assert.equal(tooBroad("/Users/someone", "/Users/someone"), true)
  assert.equal(tooBroad("/", "/Users/someone"), true)
  assert.equal(tooBroad("/Users/someone/Documents/app", "/Users/someone"), false)
})

test("the hook saves before file-changing calls only, one at a time per folder, never in Read only, and never blocks the call", async () => {
  const { checkpointHook, checkpointLabel } = await import("../plugins/loop/index.js")
  const saved = []
  const warnings = []
  let readOnly = false
  let release
  const gate = new Promise((done) => (release = done))
  const hook = checkpointHook({
    cwd: async () => "/repo",
    readOnly: () => readOnly,
    warn: (text) => warnings.push(text),
    save: async (cwd, session, label) => {
      saved.push({ cwd, session, label, at: saved.length })
      if (saved.length === 1) await gate
      if (label.includes("boom")) throw new Error("disk full")
    },
  })
  const exec = (name, args = {}) => ({ name, arguments: args, agent: { id: "s1" } })
  const order = []
  const a = hook(exec("write", { path: "a.txt" }), async () => order.push("a"))
  const b = hook(exec("bash", { description: "build" }), async () => order.push("b"))
  await new Promise((done) => setTimeout(done, 20))
  // b waits for a's checkpoint: they share Kriya's index
  assert.equal(saved.length, 1)
  release()
  await Promise.all([a, b])
  assert.deepEqual(order, ["a", "b"])
  assert.deepEqual(saved.map((s) => s.label), ["before write: a.txt", "before bash: build"])
  // Reads don't checkpoint
  await hook(exec("read", { path: "a.txt" }), async () => order.push("read"))
  assert.equal(saved.length, 2)
  // Read only changes nothing, so nothing is saved
  readOnly = true
  await hook(exec("edit", { path: "a.txt" }), async () => order.push("edit"))
  assert.equal(saved.length, 2)
  readOnly = false
  // A failing checkpoint is logged and the call still runs
  await hook(exec("bash", { description: "boom" }), async () => order.push("boom"))
  assert.equal(order.at(-1), "boom")
  assert.match(warnings[0], /no checkpoint before bash: disk full/)
  assert.equal(checkpointLabel({ name: "bash", arguments: { command: "npm i" } }), "before bash: npm i")
})

test("kriya undo lists and restores from the command line", async () => {
  const home = freshHome()
  const dir = repo()
  await checkpoint(dir, "s1", "before write: a.txt")
  write(dir, "a.txt", "agent\n")
  const kriya = (...args) =>
    execFileSync(process.execPath, [join(import.meta.dirname, "..", "bin", "kriya.js"), "undo", ...args], { cwd: dir, env: { ...process.env, KRIYA_HOME: home }, encoding: "utf8" })
  assert.match(kriya("--list"), /1\. .*before write: a\.txt/)
  assert.match(kriya(), /Back to "before write: a\.txt" \(1 file changed\)/)
  assert.equal(read(dir, "a.txt"), "a1\n")
  assert.match(kriya("--list"), /\(saved by an undo\)/)
})
