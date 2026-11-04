import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { freshHome } from "./helpers.js"

import { answer, handler, ROUTE } from "../plugins/overview/index.js"
import { jobRows, meterFigures, parseRemote } from "../src/overview.js"

// The Overview tab (plugins/overview, src/overview.js), WP-OV-*: a session's
// environment, context, changes, jobs and connectors, read-only, with no
// credential from a remote URL ever in the answer.

const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } })

function repo(remote) {
  const dir = mkdtempSync(join(tmpdir(), "kriya-overview-"))
  git(dir, "init", "-q", "-b", "main")
  git(dir, "config", "user.email", "t@example.com")
  git(dir, "config", "user.name", "t")
  writeFileSync(join(dir, "a.js"), "one\n")
  git(dir, "add", "-A")
  git(dir, "commit", "-q", "-m", "base")
  if (remote) git(dir, "remote", "add", "origin", remote)
  return dir
}

test("WP-OV-01: remotes are parsed to host and path; credentials never survive", () => {
  assert.deepEqual(parseRemote("git@github.com:zuko14/kriya-harness.git"), { host: "github.com", path: "zuko14/kriya-harness", github: true })
  assert.deepEqual(parseRemote("https://github.com/zuko14/Kriya-Tavi"), { host: "github.com", path: "zuko14/Kriya-Tavi", github: true })
  assert.deepEqual(parseRemote("ssh://git@gitlab.example.com:2222/team/app.git"), { host: "gitlab.example.com", path: "team/app", github: false })
  const withToken = parseRemote("https://someone:ghp_SECRET123@github.com/acme/private.git")
  assert.deepEqual(withToken, { host: "github.com", path: "acme/private", github: true })
  assert.doesNotMatch(JSON.stringify(withToken), /SECRET|someone/)
  for (const bad of ["", "   ", "file:///tmp/repo", "/local/path", "not a url", "https://github.com/", "https://github.com/a/b?x=1&token=y#z", null])
    assert.equal(JSON.stringify(parseRemote(bad) ?? null).includes("token"), false, String(bad))
  assert.equal(parseRemote("file:///tmp/repo"), null)
  assert.equal(parseRemote("https://github.com/"), null)
})

test("WP-OV-02: meter figures and job rows keep only what the panel shows", () => {
  assert.deepEqual(meterFigures({ contextPressure: { contextWindow: 262144, pressureTokens: 5120, surfaceTokens: 4000 }, tokenUsage: { uncachedInputTokens: 900, outputTokens: 40, cacheReadTokens: 4000, cacheWriteTokens: 0 } }), {
    context: { window: 262144, used: 5120 },
    usage: { input: 900, output: 40, cacheRead: 4000 },
  })
  assert.deepEqual(meterFigures({}), { context: null, usage: null })
  assert.deepEqual(meterFigures({ contextPressure: { pressureTokens: -1, surfaceTokens: "x" } }), { context: null, usage: null })
  const rows = jobRows(Array.from({ length: 25 }, (_, i) => ({ id: `bash-${i}`, kind: "bash", label: `job ${i}`, status: i ? "completed" : "running", startedAt: i, owner: "s1", outputLimitBytes: 9 })))
  assert.equal(rows.length, 20)
  assert.equal(rows[0].id, "bash-24", "newest first")
  assert.equal("owner" in rows[0] || "outputLimitBytes" in rows[0], false)
})

const request = (session) => new Request(`http://127.0.0.1${ROUTE}${session === undefined ? "" : `?session=${encodeURIComponent(session)}`}`)

test("WP-OV-03: the route answers one known session's overview, read-only", async () => {
  const dir = repo("https://someone:ghp_SECRET@github.com/acme/demo.git")
  writeFileSync(join(dir, "a.js"), "one\ntwo\n")
  writeFileSync(join(dir, "new.md"), "x\n")
  const before = git(dir, "status", "--porcelain=v1")
  const route = handler({
    folderOf: async (id) => (id === "s1" ? dir : undefined),
    live: (id) => (id === "s1" ? { id } : undefined),
    meter: () => ({ contextPressure: { contextWindow: 1000, pressureTokens: 250 } }),
    jobs: () => [{ id: "bash-1", kind: "bash", label: "npm test", status: "running", startedAt: 1 }],
    kriyaUrl: () => "https://kriya.example.com/some/path",
  })
  const response = await answer(route, request("s1"))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(body.environment.repo, { host: "github.com", path: "acme/demo", github: true })
  assert.equal(body.environment.branch, "main")
  assert.equal(body.environment.folder, dir)
  assert.deepEqual(body.context, { window: 1000, used: 250 })
  assert.equal(body.changes.count, 2)
  assert.deepEqual(body.jobs.map((j) => j.label), ["npm test"])
  assert.deepEqual(body.connectors, { kriya: "kriya.example.com", mcp: [] })
  assert.doesNotMatch(JSON.stringify(body), /SECRET|someone/)
  assert.equal(git(dir, "status", "--porcelain=v1"), before, "nothing in the folder changed")
})

test("WP-OV-04: unknown or missing sessions are refused; a stored session has no meter; a plain folder isn't git", async () => {
  // A plain folder gets Kriya's private store: in a throwaway home, never the person's
  freshHome()
  const plain = mkdtempSync(join(tmpdir(), "kriya-overview-plain-"))
  const route = handler({ folderOf: async (id) => (id === "old" ? plain : undefined), live: () => undefined, meter: () => assert.fail("no meter for a stored session"), jobs: () => [], kriyaUrl: () => undefined })
  assert.equal((await answer(route, request())).status, 400)
  assert.equal((await answer(route, request("nope"))).status, 400)
  const body = await (await answer(route, request("old"))).json()
  assert.equal(body.live, false)
  assert.equal(body.context, null)
  assert.equal(body.environment.git, false)
  // Not git, yet the session's own changes are tracked (none yet)
  assert.equal(body.changes.count, 0)
  assert.deepEqual(body.connectors, { kriya: null, mcp: [] })
  // Anything unexpected is a 500 with a fixed sentence, logged, never the error text
  let logged
  const broken = handler({ folderOf: async () => { throw new Error("disk on fire /secret/path") }, live: () => undefined, meter: () => ({}), jobs: () => [], kriyaUrl: () => undefined })
  const failed = await answer(broken, request("s1"), (e) => (logged = e))
  assert.equal(failed.status, 500)
  assert.doesNotMatch(JSON.stringify(await failed.json()), /fire|secret/)
  assert.match(String(logged), /disk on fire/)
})
