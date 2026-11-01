import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, beforeEach, test } from "node:test"

import { githubRepo, handoff, HandoffError, prepareHandoff, pull } from "../plugins/kriya-handoff/index.js"
import { KriyaError } from "../src/api.js"
import { CLIENT_VERSION } from "../src/paths.js"
import { writeDevice } from "../src/store.js"
import { startFakeKriya } from "./fake-kriya.js"
import { contract, freshHome, ROOT, route, violations } from "./helpers.js"

// Handoff and pull (H8, HD-11) against the fake Kriya and real git
// repositories in temporary folders: the checks HD-11 asks of the client,
// the patch in track C's checkpoint format (untracked and binary files
// included, the person's index untouched), the upload and download against
// the pinned contract, and a pull that applies on its own branch or changes
// nothing. "GitHub" is a local bare repository whose clones name github.com
// as origin; nothing leaves this machine.

const ID = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.com" }
Object.assign(process.env, ID, { GIT_CONFIG_NOSYSTEM: "1" })

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
const temp = (prefix) => mkdtempSync(join(tmpdir(), prefix))
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")
const GITHUB = "https://github.com/owner/calc.git"
// Bytes that aren't text: git writes them as a binary patch
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 255, 0, 7])

let fake
let device
let origin

/** A clone of "GitHub" with the base commit pushed */
function clone() {
  const dir = temp("kriya-clone-")
  git(dir, "clone", "--quiet", origin, ".")
  git(dir, "remote", "set-url", "origin", GITHUB)
  return dir
}

/** Work in progress: a change, a new file and a binary one */
function work(dir) {
  writeFileSync(join(dir, "math.js"), "export const multiply = (a, b) => a * b\n")
  writeFileSync(join(dir, "notes.md"), "# Next\n- finish the tests\n")
  writeFileSync(join(dir, "logo.png"), PNG)
}

before(async () => {
  fake = await startFakeKriya()
  device = { url: fake.url, token: fake.issueToken() }
  origin = temp("kriya-origin-")
  git(origin, "init", "--quiet", "--bare", "-b", "main")
  const seed = temp("kriya-seed-")
  git(seed, "init", "--quiet", "-b", "main")
  writeFileSync(join(seed, "math.js"), "export const multiply = (a, b) => a + b\n")
  writeFileSync(join(seed, ".gitignore"), "dist/\n")
  git(seed, "add", "-A")
  git(seed, "commit", "--quiet", "-m", "base")
  git(seed, "push", "--quiet", origin, "main")
})
after(() => fake.close())
beforeEach(() => {
  fake.state.handoffError = null
  fake.state.corruptCheckpoint = false
})

const last = () => fake.state.requests.at(-1)

test("githubRepo reads https, ssh and scp remotes, and nothing else", () => {
  assert.equal(githubRepo("https://github.com/owner/calc.git"), "owner/calc")
  assert.equal(githubRepo("https://github.com/owner/calc"), "owner/calc")
  assert.equal(githubRepo("git@github.com:owner/my.repo.git"), "owner/my.repo")
  assert.equal(githubRepo("ssh://git@github.com/owner/calc.git"), "owner/calc")
  assert.equal(githubRepo("https://gitlab.com/owner/calc.git"), null)
  assert.equal(githubRepo("https://github.com.evil.example/owner/calc.git"), null)
  assert.equal(githubRepo(""), null)
})

test("the patch is track C's checkpoint: every change, untracked and binary files, never ignored ones; the index is untouched", async () => {
  const dir = clone()
  work(dir)
  writeFileSync(join(dir, "staged.txt"), "staged\n")
  git(dir, "add", "staged.txt")
  execFileSync("mkdir", ["-p", join(dir, "dist")])
  writeFileSync(join(dir, "dist", "out.js"), "built\n")
  const status = git(dir, "status", "--porcelain")

  const { meta, patch } = await prepareHandoff(dir, "  Finish the tests  ")
  const text = patch.toString("latin1")
  for (const file of ["math.js", "notes.md", "logo.png", "staged.txt"]) assert.match(text, new RegExp(`diff --git a/${file.replace(".", "\\.")}`))
  assert.match(text, /GIT binary patch/)
  assert.doesNotMatch(text, /dist\/out\.js/)
  assert.equal(git(dir, "status", "--porcelain"), status, "the person's index changed")

  assert.deepEqual(violations(route("POST", "/handoff").request, meta), [])
  assert.deepEqual(meta, {
    repo: "owner/calc",
    baseRef: "main",
    baseSha: git(dir, "rev-parse", "HEAD"),
    note: "Finish the tests",
    sha256: sha256(patch),
    bytes: patch.length,
  })
})

test("refused before any upload: not a repository, detached HEAD, not GitHub, HEAD not pushed, a long note", async () => {
  const before = fake.state.requests.length
  await assert.rejects(prepareHandoff(temp("kriya-plain-")), /isn't a git repository/)

  const detached = clone()
  git(detached, "switch", "--quiet", "--detach")
  await assert.rejects(prepareHandoff(detached), /detached; check out a branch/)

  const gitlab = clone()
  git(gitlab, "remote", "set-url", "origin", "https://gitlab.com/owner/calc.git")
  await assert.rejects(prepareHandoff(gitlab), /isn't a GitHub repository/)

  const unpushed = clone()
  git(unpushed, "commit", "--quiet", "--allow-empty", "-m", "local only")
  await assert.rejects(prepareHandoff(unpushed), /isn't on GitHub yet; push your branch first/)

  await assert.rejects(prepareHandoff(clone(), "x".repeat(2001)), /over 2000 characters/)
  assert.equal(fake.state.requests.length, before)
})

test("handoff uploads meta and patch as the contract says and returns the thread and workspace", async () => {
  const dir = clone()
  work(dir)
  const done = await handoff(device, dir, "Finish the tests")
  const exchange = last()
  const shape = route("POST", "/handoff")
  assert.equal(exchange.method, "POST")
  assert.equal(exchange.headers[contract.headers.version.toLowerCase()], CLIENT_VERSION)
  assert.equal(exchange.headers.authorization, `Bearer ${device.token}`)
  assert.match(exchange.headers["content-type"], /^multipart\/form-data; boundary=/)
  assert.deepEqual(violations(shape.request, exchange.body), [])
  assert.equal(exchange.status, 201)
  assert.deepEqual(violations(shape.response, exchange.response), [])
  assert.equal(done.url, exchange.response.url)

  const stored = fake.state.workspaces.get(done.workspaceId)
  const { patch } = await prepareHandoff(dir)
  assert.ok(stored.patch.equals(patch), "the server got other bytes")
  assert.equal(done.bytes, patch.length)
})

test("handoff surfaces Kriya's refusal in its own words", async () => {
  const dir = clone()
  work(dir)
  fake.state.handoffError = { status: 403, error: "not_connected", message: "Connect GitHub in Kriya, Account → Apps, then hand off again." }
  await assert.rejects(handoff(device, dir), (error) => {
    assert.ok(error instanceof KriyaError)
    assert.equal(error.code, "not_connected")
    assert.match(error.message, /Connect GitHub/)
    return true
  })
  assert.deepEqual(violations(contract.error, last().response), [])
})

test("pull applies the latest checkpoint on kriya/pull-<id> at the base commit, byte for byte", async () => {
  const laptop = clone()
  work(laptop)
  const { workspaceId } = await handoff(device, laptop, "carry on")
  // Later the cloud agent saved another checkpoint on the same base
  const cloud = clone()
  work(cloud)
  writeFileSync(join(cloud, "math.test.js"), "test('multiply', () => {})\n")
  const { patch } = await prepareHandoff(cloud)
  fake.state.workspaces.get(workspaceId).patch = patch

  const other = clone()
  const base = git(other, "rev-parse", "HEAD")
  const done = await pull(device, other, workspaceId)
  const exchange = last()
  assert.equal(exchange.path, `/workspaces/${workspaceId}/checkpoint`)
  assert.equal(exchange.headers.authorization, `Bearer ${device.token}`)
  assert.equal(route("GET", "/workspaces/{id}/checkpoint").auth, true)

  assert.deepEqual(done, { branch: `kriya/pull-${workspaceId}`, baseSha: base, bytes: patch.length })
  assert.equal(git(other, "branch", "--show-current"), `kriya/pull-${workspaceId}`)
  assert.equal(git(other, "rev-parse", "HEAD"), base)
  for (const file of ["math.js", "notes.md", "logo.png", "math.test.js"])
    assert.ok(readFileSync(join(other, file)).equals(readFileSync(join(cloud, file))), file)
  // The person's main is where it was
  assert.equal(git(other, "rev-parse", "main"), base)
})

test("pull changes nothing on a damaged download, a dirty tree, a missing base, a taken branch or a patch that doesn't apply", async () => {
  const laptop = clone()
  work(laptop)
  const { workspaceId } = await handoff(device, laptop)
  const branches = (dir) => git(dir, "branch", "--format=%(refname:short)")

  const damaged = clone()
  fake.state.corruptCheckpoint = true
  await assert.rejects(pull(device, damaged, workspaceId), (error) => error instanceof HandoffError && /damaged on the way; nothing was applied/.test(error.message))
  fake.state.corruptCheckpoint = false
  assert.equal(branches(damaged), "main")
  assert.equal(git(damaged, "status", "--porcelain"), "")

  const dirty = clone()
  writeFileSync(join(dirty, "math.js"), "mine\n")
  await assert.rejects(pull(device, dirty, workspaceId), /uncommitted changes; commit or stash/)
  assert.equal(readFileSync(join(dirty, "math.js"), "utf8"), "mine\n")

  const missing = clone()
  fake.state.workspaces.get(workspaceId).baseSha = "f".repeat(40)
  await assert.rejects(pull(device, missing, workspaceId), /isn't in this clone; run git fetch/)
  assert.equal(branches(missing), "main")
  fake.state.workspaces.get(workspaceId).baseSha = git(missing, "rev-parse", "HEAD")

  const taken = clone()
  git(taken, "branch", `kriya/pull-${workspaceId}`)
  await assert.rejects(pull(device, taken, workspaceId), /already exists/)

  const conflict = clone()
  const stored = fake.state.workspaces.get(workspaceId)
  const good = stored.patch
  stored.patch = Buffer.from(good.toString("latin1").replace("-export const multiply = (a, b) => a + b", "-something else entirely"), "latin1")
  await assert.rejects(pull(device, conflict, workspaceId), /doesn't apply cleanly \(.*\); nothing was changed/)
  stored.patch = good
  assert.equal(git(conflict, "branch", "--show-current"), "main")
  assert.equal(branches(conflict), "main")
  assert.equal(git(conflict, "status", "--porcelain"), "")

  await assert.rejects(pull(device, clone(), "not-an-id"), /isn't a workspace id/)
  await assert.rejects(pull(device, clone(), "00000000-0000-4000-8000-000000000000"), (error) => error instanceof KriyaError && error.status === 404)
})

function kriya(args, cwd, home) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), ...args], {
      cwd,
      env: { ...process.env, KRIYA_HOME: home },
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    child.on("exit", (code) => done({ code, stdout, stderr }))
  })
}

test("kriya handoff and a bare kriya pull, end to end through the command", async () => {
  const home = freshHome()
  writeDevice({ url: fake.url, token: device.token, deviceId: "11111111-2222-4333-8444-555555555555" })
  const laptop = clone()
  work(laptop)
  const sent = await kriya(["handoff", "Finish", "the", "tests"], laptop, home)
  assert.equal(sent.code, 0, sent.stderr)
  assert.match(sent.stdout, /Handed off \(\d+ bytes of changes\)/)
  assert.match(sent.stdout, new RegExp(`${fake.url.replace(/[.]/g, "\\.")}/a/agent-1/`))
  const workspaceId = /Workspace ([0-9a-f-]{36})/.exec(sent.stdout)[1]
  assert.equal(fake.state.workspaces.get(workspaceId).meta.note, "Finish the tests")
  assert.ok(existsSync(join(home, "last-workspace")))

  const other = clone()
  const got = await kriya(["pull"], other, home)
  assert.equal(got.code, 0, got.stderr)
  assert.match(got.stdout, new RegExp(`On branch kriya/pull-${workspaceId}`))
  assert.equal(readFileSync(join(other, "notes.md"), "utf8"), "# Next\n- finish the tests\n")

  const outside = await kriya(["handoff"], temp("kriya-plain-"), home)
  assert.equal(outside.code, 1)
  assert.match(outside.stderr, /kriya: This folder isn't a git repository/)
})
